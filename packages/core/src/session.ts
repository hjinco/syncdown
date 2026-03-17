import { createNullIo, resolveAppPaths } from "./config.js";
import { findIntegration } from "./config-model.js";
import {
	getEnabledIntegrations,
	getRunTargetLabel,
	getTargetIntegrations,
	requireOutputDir,
	resetIntegrationState,
	runIntegrationSync,
} from "./execution.js";
import {
	acquireRunLock,
	type RunLockHandle,
	startLockHeartbeat,
} from "./run-lock.js";
import { type AppRuntime, intervalPresetToMs } from "./runtime.js";
import {
	cloneRuntimeSnapshot,
	createIntegrationRuntimeSnapshot,
	createSessionRunError,
	createSyncCancelledError,
	createWatchController,
	type IntegrationRunResult,
	type InternalIntegrationState,
	type InternalSyncSession,
	type SessionRunError,
	type WatchController,
} from "./session-internals.js";
import type {
	AppIo,
	AppSnapshot,
	ExitCode,
	RunNowOptions,
	SyncdownServices,
	SyncLogEntry,
	SyncRunTarget,
	SyncRuntimeEvent,
	SyncRuntimeSnapshot,
	SyncSession,
	WatchStrategy,
} from "./types.js";
import { EXIT_CODES } from "./types.js";

const LOG_RING_LIMIT = 200;

export function openSyncSession(
	services: SyncdownServices,
	runtime: AppRuntime,
	inspect: () => Promise<AppSnapshot>,
	io: AppIo = createNullIo(),
): Promise<SyncSession> {
	return createSyncSession(services, runtime, inspect, io);
}

async function createSyncSession(
	services: SyncdownServices,
	runtime: AppRuntime,
	inspect: () => Promise<AppSnapshot>,
	io: AppIo,
): Promise<InternalSyncSession> {
	const initialAppSnapshot = await inspect();
	const integrationStates = new Map<string, InternalIntegrationState>(
		initialAppSnapshot.integrations.flatMap((summary) => {
			const integration = findIntegration(
				initialAppSnapshot.config,
				summary.id,
			);
			if (!integration) {
				return [];
			}

			return [
				[
					summary.id,
					{
						integration,
						snapshot: createIntegrationRuntimeSnapshot(summary),
						runPromise: null,
						cancelRequested: false,
						cancelReason: null,
					},
				],
			];
		}),
	);

	const runtimeSnapshot: SyncRuntimeSnapshot = {
		status: "idle",
		watch: {
			active: false,
			strategy: null,
			startedAt: null,
		},
		lastRunTarget: null,
		lastRunStartedAt: null,
		lastRunFinishedAt: null,
		lastRunExitCode: null,
		lastRunError: null,
		integrations: Array.from(integrationStates.values()).map(
			(state) => state.snapshot,
		),
		logs: [],
	};

	const subscribers = new Set<(event: SyncRuntimeEvent) => void>();
	let disposed = false;
	let watchController: WatchController | null = null;
	let lockHandle: RunLockHandle | null = null;
	let stopHeartbeat: (() => Promise<void>) | null = null;
	let lockPromise: Promise<void> | null = null;

	function emitSnapshot(): void {
		const event: SyncRuntimeEvent = {
			type: "snapshot",
			snapshot: cloneRuntimeSnapshot(runtimeSnapshot),
		};

		for (const listener of subscribers) {
			listener(event);
		}
	}

	function syncOverallStatus(): void {
		const hasRunningIntegration = runtimeSnapshot.integrations.some(
			(integration) => integration.running,
		);
		runtimeSnapshot.status = runtimeSnapshot.watch.active
			? "watching"
			: hasRunningIntegration
				? "running"
				: "idle";
	}

	function createSessionIo(
		options: {
			connectorId?: string;
			integrationId?: string;
			integrationLabel?: string;
		} = {},
	): AppIo {
		return {
			write(line) {
				io.write(line);
				appendLog("info", line, options);
			},
			error(line) {
				io.error(line);
				appendLog("error", line, options);
			},
		};
	}

	function appendLog(
		level: SyncLogEntry["level"],
		message: string,
		options: {
			connectorId?: string;
			integrationId?: string;
			integrationLabel?: string;
		} = {},
	): void {
		runtimeSnapshot.logs.push({
			timestamp: runtime.now().toISOString(),
			level,
			message,
			connectorId: options.connectorId,
			integrationId: options.integrationId,
			integrationLabel: options.integrationLabel,
		});

		if (runtimeSnapshot.logs.length > LOG_RING_LIMIT) {
			runtimeSnapshot.logs.splice(
				0,
				runtimeSnapshot.logs.length - LOG_RING_LIMIT,
			);
		}

		emitSnapshot();
	}

	function updateFromAppSnapshot(appSnapshot: AppSnapshot): void {
		const expectedIntegrationIds = new Set(
			appSnapshot.integrations.map((summary) => summary.id),
		);
		const staleActiveStates: InternalIntegrationState[] = [];

		for (const [
			integrationId,
			integrationState,
		] of integrationStates.entries()) {
			if (expectedIntegrationIds.has(integrationId)) {
				continue;
			}

			if (
				integrationState.runPromise ||
				integrationState.snapshot.running ||
				integrationState.snapshot.queuedImmediateRun
			) {
				integrationState.snapshot.enabled = false;
				integrationState.snapshot.nextRunAt = null;
				staleActiveStates.push(integrationState);
				continue;
			}

			integrationStates.delete(integrationId);
		}

		const orderedSnapshots = appSnapshot.integrations.flatMap((summary) => {
			let integrationState = integrationStates.get(summary.id);
			if (!integrationState) {
				const integration = findIntegration(appSnapshot.config, summary.id);
				if (!integration) {
					return [];
				}

				integrationState = {
					integration,
					snapshot: createIntegrationRuntimeSnapshot(summary),
					runPromise: null,
					cancelRequested: false,
					cancelReason: null,
				};
				integrationStates.set(summary.id, integrationState);
			}

			const latestIntegration = findIntegration(appSnapshot.config, summary.id);
			if (latestIntegration) {
				integrationState.integration = latestIntegration;
			}

			integrationState.snapshot.connectorId = summary.connectorId;
			integrationState.snapshot.connectionId = summary.connectionId;
			integrationState.snapshot.label = summary.label;
			integrationState.snapshot.enabled = summary.enabled;
			integrationState.snapshot.interval = summary.interval;
			if (!integrationState.snapshot.lastSuccessAt) {
				integrationState.snapshot.lastSuccessAt = summary.lastSyncAt;
			}

			return [integrationState.snapshot];
		});

		runtimeSnapshot.integrations = [
			...orderedSnapshots,
			...staleActiveStates.map((state) => state.snapshot),
		];
	}

	async function ensureLockAcquired(): Promise<void> {
		if (lockHandle) {
			return;
		}

		if (lockPromise) {
			await lockPromise;
			return;
		}

		const paths = resolveAppPaths();
		lockPromise = (async () => {
			try {
				lockHandle = await acquireRunLock(paths, runtime);
				stopHeartbeat = startLockHeartbeat(lockHandle, runtime);
			} catch (error) {
				if (error instanceof Error && error.name === "RunLockError") {
					throw createSessionRunError(EXIT_CODES.LOCKED, error.message);
				}

				throw error;
			}
		})();

		try {
			await lockPromise;
		} finally {
			lockPromise = null;
		}
	}

	function hasActiveRuns(): boolean {
		return Array.from(integrationStates.values()).some(
			(state) => state.runPromise !== null,
		);
	}

	async function maybeReleaseLock(): Promise<void> {
		if (runtimeSnapshot.watch.active || hasActiveRuns() || !lockHandle) {
			return;
		}

		const heartbeatStop = stopHeartbeat;
		const handle = lockHandle;
		stopHeartbeat = null;
		lockHandle = null;

		await heartbeatStop?.();
		await handle.release();
	}

	function setLastRunStart(target: SyncRunTarget): void {
		runtimeSnapshot.lastRunTarget = target;
		runtimeSnapshot.lastRunStartedAt = runtime.now().toISOString();
		runtimeSnapshot.lastRunFinishedAt = null;
		runtimeSnapshot.lastRunExitCode = null;
		runtimeSnapshot.lastRunError = null;
		syncOverallStatus();
		emitSnapshot();
	}

	function setLastRunFinish(
		exitCode: ExitCode,
		errorMessage: string | null,
	): void {
		runtimeSnapshot.lastRunFinishedAt = runtime.now().toISOString();
		runtimeSnapshot.lastRunExitCode = exitCode;
		runtimeSnapshot.lastRunError = errorMessage;
		syncOverallStatus();
		emitSnapshot();
	}

	async function scheduleIntegrationRun(
		entry: ReturnType<typeof getTargetIntegrations>[number],
		appSnapshot: AppSnapshot,
	): Promise<IntegrationRunResult> {
		const integrationState = integrationStates.get(entry.integration.id);
		if (!integrationState) {
			throw new Error(`Unknown integration: ${entry.integration.id}`);
		}

		integrationState.integration = entry.integration;
		integrationState.cancelRequested = false;
		integrationState.cancelReason = null;

		if (integrationState.runPromise) {
			integrationState.snapshot.queuedImmediateRun = true;
			emitSnapshot();
			return integrationState.runPromise;
		}

		const runPromise = (async () => {
			let exitCode = await runIntegrationSync({
				connector: entry.connector,
				integration: entry.integration,
				snapshot: integrationState.snapshot,
				services,
				appSnapshot,
				runtime,
				io: createSessionIo({
					connectorId: entry.integration.connectorId,
					integrationId: entry.integration.id,
				}),
				throwIfCancelled: () => {
					if (integrationState.cancelRequested) {
						throw createSyncCancelledError(
							integrationState.cancelReason ?? "Sync cancelled by user.",
						);
					}
				},
				emitSnapshot: () => {
					syncOverallStatus();
					emitSnapshot();
				},
			});

			while (integrationState.snapshot.queuedImmediateRun) {
				if (integrationState.cancelRequested) {
					integrationState.snapshot.queuedImmediateRun = false;
					break;
				}

				integrationState.snapshot.queuedImmediateRun = false;
				emitSnapshot();
				const latestSnapshot = await inspect();
				updateFromAppSnapshot(latestSnapshot);

				if (!latestSnapshot.config.outputDir) {
					exitCode = EXIT_CODES.CONFIG_ERROR;
					integrationState.snapshot.lastError =
						"No output directory configured. Run `syncdown` first.";
					integrationState.snapshot.progress = null;
					emitSnapshot();
					break;
				}

				const latestIntegration = findIntegration(
					latestSnapshot.config,
					entry.integration.id,
				);
				const latestConnector = latestIntegration
					? services.connectors.find(
							(candidate) => candidate.id === latestIntegration.connectorId,
						)
					: undefined;
				if (
					!latestIntegration ||
					!latestConnector ||
					!latestIntegration.enabled
				) {
					appendLog(
						"info",
						`Integration skipped: ${entry.integration.label} is disabled.`,
						{
							connectorId: entry.integration.connectorId,
							integrationId: entry.integration.id,
							integrationLabel: entry.integration.label,
						},
					);
					break;
				}

				integrationState.integration = latestIntegration;
				exitCode = await runIntegrationSync({
					connector: latestConnector,
					integration: latestIntegration,
					snapshot: integrationState.snapshot,
					services,
					appSnapshot: latestSnapshot,
					runtime,
					io: createSessionIo({
						connectorId: latestIntegration.connectorId,
						integrationId: latestIntegration.id,
						integrationLabel: latestIntegration.label,
					}),
					throwIfCancelled: () => {
						if (integrationState.cancelRequested) {
							throw createSyncCancelledError(
								integrationState.cancelReason ?? "Sync cancelled by user.",
							);
						}
					},
					emitSnapshot: () => {
						syncOverallStatus();
						emitSnapshot();
					},
				});
			}

			return {
				exitCode,
				errorMessage:
					exitCode === EXIT_CODES.GENERAL_ERROR && integrationState.cancelReason
						? integrationState.cancelReason
						: integrationState.snapshot.lastError,
			};
		})();

		integrationState.runPromise = runPromise;

		try {
			return await runPromise;
		} finally {
			integrationState.runPromise = null;
			integrationState.snapshot.queuedImmediateRun = false;
			integrationState.cancelRequested = false;
			integrationState.cancelReason = null;
			emitSnapshot();
			await maybeReleaseLock();
		}
	}

	async function resetTargetIntegrations(
		entries: ReturnType<typeof getTargetIntegrations>,
		appSnapshot: AppSnapshot,
	): Promise<void> {
		const outputDir = requireOutputDir(appSnapshot.config);

		for (const entry of entries) {
			const integrationState = integrationStates.get(entry.integration.id);
			if (!integrationState) {
				continue;
			}

			if (integrationState.runPromise) {
				throw createSessionRunError(
					EXIT_CODES.GENERAL_ERROR,
					`Cannot reset ${entry.integration.label} while it is already running.`,
				);
			}

			await resetIntegrationState({
				integration: entry.integration,
				services,
				outputDir,
				io: createSessionIo({
					connectorId: entry.integration.connectorId,
					integrationId: entry.integration.id,
				}),
			});

			integrationState.snapshot.status = "idle";
			integrationState.snapshot.running = false;
			integrationState.snapshot.queuedImmediateRun = false;
			integrationState.cancelRequested = false;
			integrationState.cancelReason = null;
			integrationState.snapshot.lastStartedAt = null;
			integrationState.snapshot.lastFinishedAt = null;
			integrationState.snapshot.lastSuccessAt = null;
			integrationState.snapshot.lastError = null;
			integrationState.snapshot.lastDocumentsWritten = 0;
			integrationState.snapshot.nextRunAt = null;
			integrationState.snapshot.progress = null;
			emitSnapshot();
		}
	}

	async function runSelectedIntegrations(
		entries: ReturnType<typeof getTargetIntegrations>,
		appSnapshot: AppSnapshot,
	): Promise<{
		exitCode: ExitCode;
		wroteDocuments: number;
		errorMessage: string | null;
	}> {
		const results = await Promise.all(
			entries.map(async (entry) => {
				const result = await scheduleIntegrationRun(entry, appSnapshot);
				const snapshot = integrationStates.get(entry.integration.id)?.snapshot;
				const errorMessage =
					result.errorMessage ??
					(result.exitCode === EXIT_CODES.VALIDATION_ERROR
						? `${entry.integration.label} validation failed.`
						: null);

				return {
					entry,
					exitCode: result.exitCode,
					wroteDocuments: snapshot?.lastDocumentsWritten ?? 0,
					errorMessage,
				};
			}),
		);

		const firstFailure = results.find(
			(result) => result.exitCode !== EXIT_CODES.OK,
		);
		return {
			exitCode: firstFailure?.exitCode ?? EXIT_CODES.OK,
			wroteDocuments: results.reduce(
				(total, result) => total + result.wroteDocuments,
				0,
			),
			errorMessage: firstFailure?.errorMessage ?? null,
		};
	}

	async function runTarget(
		target: SyncRunTarget,
		options: RunNowOptions = {},
	): Promise<ExitCode> {
		if (disposed) {
			throw createSessionRunError(
				EXIT_CODES.GENERAL_ERROR,
				"Session has already been disposed.",
			);
		}

		setLastRunStart(target);
		const appSnapshot = await inspect();
		updateFromAppSnapshot(appSnapshot);

		if (!appSnapshot.config.outputDir) {
			const message = "No output directory configured. Run `syncdown` first.";
			createSessionIo().error(message);
			setLastRunFinish(EXIT_CODES.CONFIG_ERROR, message);
			return EXIT_CODES.CONFIG_ERROR;
		}

		const selectedIntegrations = getTargetIntegrations(
			services,
			appSnapshot,
			target,
		);
		if (target.kind === "all" && selectedIntegrations.length === 0) {
			createSessionIo().write("No enabled integrations configured.");
			setLastRunFinish(EXIT_CODES.OK, null);
			return EXIT_CODES.OK;
		}

		if (target.kind !== "all" && selectedIntegrations.length === 0) {
			createSessionIo().write(
				`Run skipped: ${getRunTargetLabel(target)} is disabled or missing.`,
			);
			setLastRunFinish(EXIT_CODES.OK, null);
			return EXIT_CODES.OK;
		}

		try {
			await ensureLockAcquired();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Run failed";
			if ((error as Partial<SessionRunError>).exitCode) {
				createSessionIo().error(message);
				setLastRunFinish((error as SessionRunError).exitCode, message);
				return (error as SessionRunError).exitCode;
			}

			throw error;
		}

		const sessionIo = createSessionIo();
		sessionIo.write(`Run started. integrations=${selectedIntegrations.length}`);

		try {
			if (options.resetState) {
				await resetTargetIntegrations(selectedIntegrations, appSnapshot);
			}

			const { exitCode, wroteDocuments, errorMessage } =
				await runSelectedIntegrations(selectedIntegrations, appSnapshot);
			if (exitCode !== EXIT_CODES.OK) {
				setLastRunFinish(exitCode, errorMessage);
				return exitCode;
			}

			sessionIo.write(`Sync finished. Documents written: ${wroteDocuments}`);
			setLastRunFinish(EXIT_CODES.OK, null);
			return EXIT_CODES.OK;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Run failed";
			const exitCode =
				(error as Partial<SessionRunError>).exitCode ?? EXIT_CODES.SYNC_ERROR;
			sessionIo.error(message);
			setLastRunFinish(exitCode, message);
			return exitCode;
		}
	}

	async function waitForStopOrTimeout(
		controller: WatchController,
		ms: number,
	): Promise<boolean> {
		if (controller.stopRequested) {
			return true;
		}

		const timeoutPromise = runtime.sleep(ms).then(() => false);
		const stopPromise = controller.stopPromise.then(() => true);
		return Promise.race([timeoutPromise, stopPromise]);
	}

	function clearNextRunTimes(): void {
		for (const integration of runtimeSnapshot.integrations) {
			integration.nextRunAt = null;
		}
	}

	async function stopWatchInternal(): Promise<void> {
		const controller = watchController;
		if (!controller) {
			return;
		}

		controller.stopRequested = true;
		controller.resolveStop();
		await controller.loopPromise.catch(() => {});
	}

	async function cancelActiveRunInternal(options: {
		updateLastRun: boolean;
	}): Promise<void> {
		const activeStates = Array.from(integrationStates.values()).filter(
			(state) =>
				state.runPromise !== null ||
				state.snapshot.running ||
				state.snapshot.queuedImmediateRun,
		);
		if (activeStates.length === 0) {
			return;
		}

		const message = "Sync cancelled by user.";
		appendLog("info", message);

		for (const state of activeStates) {
			state.cancelRequested = true;
			state.cancelReason = message;
			state.snapshot.status = "idle";
			state.snapshot.running = false;
			state.snapshot.queuedImmediateRun = false;
			state.snapshot.nextRunAt = null;
			state.snapshot.lastFinishedAt = runtime.now().toISOString();
			state.snapshot.lastError = null;
			state.snapshot.progress = null;
		}

		if (options.updateLastRun) {
			runtimeSnapshot.lastRunFinishedAt = runtime.now().toISOString();
			runtimeSnapshot.lastRunExitCode = EXIT_CODES.GENERAL_ERROR;
			runtimeSnapshot.lastRunError = message;
		}

		syncOverallStatus();
		emitSnapshot();
	}

	async function startWatch(strategy: WatchStrategy): Promise<void> {
		if (disposed) {
			throw createSessionRunError(
				EXIT_CODES.GENERAL_ERROR,
				"Session has already been disposed.",
			);
		}

		if (watchController) {
			return;
		}

		const appSnapshot = await inspect();
		updateFromAppSnapshot(appSnapshot);

		if (!appSnapshot.config.outputDir) {
			throw createSessionRunError(
				EXIT_CODES.CONFIG_ERROR,
				"No output directory configured. Run `syncdown` first.",
			);
		}

		if (getEnabledIntegrations(services, appSnapshot.config).length === 0) {
			throw createSessionRunError(
				EXIT_CODES.CONFIG_ERROR,
				"No enabled integrations configured.",
			);
		}

		await ensureLockAcquired();

		const controller = createWatchController(
			strategy,
			runtime.now().toISOString(),
		);
		watchController = controller;
		runtimeSnapshot.watch.active = true;
		runtimeSnapshot.watch.strategy = strategy;
		runtimeSnapshot.watch.startedAt = controller.startedAt;
		syncOverallStatus();
		emitSnapshot();

		const finalize = async () => {
			if (watchController !== controller) {
				return;
			}

			clearNextRunTimes();
			watchController = null;
			runtimeSnapshot.watch.active = false;
			runtimeSnapshot.watch.strategy = null;
			runtimeSnapshot.watch.startedAt = null;
			syncOverallStatus();
			emitSnapshot();
			await maybeReleaseLock();
		};

		if (strategy.kind === "global") {
			createSessionIo().write(
				`Watch mode enabled. interval=${strategy.interval}`,
			);

			controller.loopPromise = (async () => {
				try {
					const initialExitCode = await runTarget({ kind: "all" });
					if (
						initialExitCode !== EXIT_CODES.OK &&
						initialExitCode !== EXIT_CODES.SYNC_ERROR
					) {
						throw createSessionRunError(
							initialExitCode,
							runtimeSnapshot.lastRunError ??
								`Watch failed with exit code ${initialExitCode}.`,
						);
					}

					controller.resolveStarted();

					while (!controller.stopRequested) {
						const latestSnapshot = await inspect();
						updateFromAppSnapshot(latestSnapshot);
						const nextRunAt = new Date(
							runtime.now().getTime() + intervalPresetToMs(strategy.interval),
						).toISOString();
						for (const integration of latestSnapshot.integrations) {
							const integrationState = integrationStates.get(integration.id);
							if (integrationState?.snapshot.enabled) {
								integrationState.snapshot.nextRunAt = nextRunAt;
							}
						}
						emitSnapshot();
						createSessionIo().write(`Watch sleeping for ${strategy.interval}.`);

						const interrupted = await waitForStopOrTimeout(
							controller,
							intervalPresetToMs(strategy.interval),
						);
						clearNextRunTimes();
						emitSnapshot();
						if (interrupted) {
							return null;
						}

						const exitCode = await runTarget({ kind: "all" });
						if (
							exitCode !== EXIT_CODES.OK &&
							exitCode !== EXIT_CODES.SYNC_ERROR
						) {
							return exitCode;
						}
					}

					return null;
				} catch (error) {
					controller.rejectStarted(error);
					throw error;
				} finally {
					await finalize();
				}
			})();

			await controller.startedPromise;
			return;
		}

		controller.resolveStarted();
		controller.loopPromise = (async () => {
			try {
				const enabledStates = Array.from(integrationStates.values()).filter(
					(state) => state.snapshot.enabled,
				);
				const results = await Promise.all(
					enabledStates.map(async (integrationState) => {
						while (!controller.stopRequested) {
							const exitCode = await runTarget({
								kind: "integration",
								integrationId: integrationState.snapshot.id,
							});
							if (
								exitCode !== EXIT_CODES.OK &&
								exitCode !== EXIT_CODES.SYNC_ERROR
							) {
								controller.stopRequested = true;
								controller.resolveStop();
								return exitCode;
							}

							if (controller.stopRequested) {
								return null;
							}

							const latestSnapshot = await inspect();
							updateFromAppSnapshot(latestSnapshot);
							const latestState = integrationStates.get(
								integrationState.snapshot.id,
							);
							if (!latestState?.snapshot.enabled) {
								return null;
							}

							const waitMs = intervalPresetToMs(latestState.snapshot.interval);
							latestState.snapshot.nextRunAt = new Date(
								runtime.now().getTime() + waitMs,
							).toISOString();
							emitSnapshot();
							const interrupted = await waitForStopOrTimeout(
								controller,
								waitMs,
							);
							latestState.snapshot.nextRunAt = null;
							emitSnapshot();
							if (interrupted) {
								return null;
							}
						}

						return null;
					}),
				);

				const fatalResult = results.find((result) => result !== null);
				return fatalResult ?? null;
			} finally {
				await finalize();
			}
		})();
	}

	return {
		getSnapshot(): SyncRuntimeSnapshot {
			return cloneRuntimeSnapshot(runtimeSnapshot);
		},

		subscribe(listener: (event: SyncRuntimeEvent) => void): () => void {
			subscribers.add(listener);
			return () => {
				subscribers.delete(listener);
			};
		},

		async runNow(
			target: SyncRunTarget,
			options: RunNowOptions = {},
		): Promise<void> {
			await runTarget(target, options);
		},

		async startWatch(strategy: WatchStrategy): Promise<void> {
			await startWatch(strategy);
		},

		async stopWatch(): Promise<void> {
			await stopWatchInternal();
		},

		async cancelActiveRun(): Promise<void> {
			await cancelActiveRunInternal({ updateLastRun: true });
		},

		async dispose(): Promise<void> {
			if (disposed) {
				return;
			}

			disposed = true;
			await stopWatchInternal();
			const runningPromises = Array.from(integrationStates.values()).flatMap(
				(state) => (state.runPromise ? [state.runPromise] : []),
			);
			await Promise.allSettled(runningPromises);
			await maybeReleaseLock();
			subscribers.clear();
		},

		async waitForWatchCompletion(): Promise<ExitCode | null> {
			return watchController?.loopPromise ?? null;
		},
	};
}
