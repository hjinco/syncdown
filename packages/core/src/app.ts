import { rm } from "node:fs/promises";
import {
	createNullIo,
	createStdIo,
	describeOutputDirectory,
	ensureAppDirectories,
	readConfig,
	resolveAppPaths,
} from "./config.js";
import {
	toConnectionSummaries,
	toConnectorDefinitions,
} from "./config-model.js";
import {
	buildIntegrationSummary,
	buildSyncRequest,
	formatHealth,
	getIntegrationRenderVersion,
	hasStoredCredentials,
} from "./execution.js";
import { acquireRunLock } from "./run-lock.js";
import {
	type AppRuntime,
	createRuntime,
	createSignalWaiter,
} from "./runtime.js";
import { openSyncSession } from "./session.js";
import type {
	InternalSyncSession,
	SessionRunError,
} from "./session-internals.js";
import type {
	AppSnapshot,
	RunOptions,
	SyncdownApp,
	SyncdownServices,
} from "./types.js";
import { EXIT_CODES } from "./types.js";

const WATCH_DEFAULT_INTERVAL = "1h";

export function createSyncdownApp(
	services: SyncdownServices,
	runtimeOverrides: Partial<AppRuntime> = {},
): SyncdownApp {
	const runtime = createRuntime(runtimeOverrides);
	const resetPaths = (paths: AppSnapshot["paths"]) => [
		paths.configPath,
		paths.statePath,
		`${paths.statePath}-shm`,
		`${paths.statePath}-wal`,
		paths.secretsPath,
		paths.masterKeyPath,
	];

	const inspect = async (): Promise<AppSnapshot> => {
		const paths = resolveAppPaths();
		await ensureAppDirectories(paths);
		const config = await readConfig(paths);
		const integrations = await Promise.all(
			config.integrations.flatMap(async (integration) => {
				const connector = services.connectors.find(
					(candidate) => candidate.id === integration.connectorId,
				);
				if (!connector) {
					return [];
				}

				return [
					buildIntegrationSummary(
						connector,
						integration,
						await services.state.getLastSyncAt(integration.id),
					),
				];
			}),
		);

		return {
			paths,
			config,
			connectors: toConnectorDefinitions(services.connectors),
			connections: toConnectionSummaries(config),
			integrations: integrations.flat(),
		};
	};

	return {
		inspect,

		openSession(io = createNullIo()) {
			return openSyncSession(services, runtime, inspect, io);
		},

		async run(io = createStdIo(), options: RunOptions = {}): Promise<number> {
			const session = (await openSyncSession(
				services,
				runtime,
				inspect,
				io,
			)) as InternalSyncSession;
			const watch = options.watch ?? false;
			const watchInterval = options.watchInterval ?? WATCH_DEFAULT_INTERVAL;
			const target = options.target ?? { kind: "all" as const };

			if (!watch) {
				try {
					await session.runNow(target, { resetState: options.resetState });
					return session.getSnapshot().lastRunExitCode ?? EXIT_CODES.OK;
				} finally {
					await session.dispose();
				}
			}

			const signalWaiter = createSignalWaiter(runtime);
			try {
				await session.startWatch({ kind: "global", interval: watchInterval });
				const watchCompletion = session.waitForWatchCompletion();
				const winner = await Promise.race([
					signalWaiter.promise.then(() => "signal" as const),
					watchCompletion.then((exitCode) => ({
						kind: "watch" as const,
						exitCode,
					})),
				]);

				if (winner === "signal") {
					io.write("Shutdown requested. Exiting watch mode.");
					await session.stopWatch();
					return EXIT_CODES.OK;
				}

				const exitCode = winner.exitCode;
				if (exitCode === null) {
					return EXIT_CODES.OK;
				}

				return exitCode;
			} catch (error) {
				const message = error instanceof Error ? error.message : "Run failed";
				io.error(message);
				if ((error as Partial<SessionRunError>).exitCode) {
					return (error as SessionRunError).exitCode;
				}
				return EXIT_CODES.SYNC_ERROR;
			} finally {
				signalWaiter.dispose();
				await session.dispose();
			}
		},

		async reset(io = createStdIo()): Promise<number> {
			const paths = resolveAppPaths();

			try {
				const lock = await acquireRunLock(paths, runtime);
				let released = false;
				try {
					const deletedPaths = resetPaths(paths);
					await services.state.dispose?.();

					await Promise.all(
						deletedPaths.map((filePath) => rm(filePath, { force: true })),
					);

					await lock.release();
					released = true;

					io.write("Removed app data:");
					for (const filePath of [...deletedPaths, paths.lockPath]) {
						io.write(`- ${filePath}`);
					}
					io.write("Synced output files were not removed.");
					return EXIT_CODES.OK;
				} finally {
					if (!released) {
						await lock.release();
					}
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "App reset failed.";
				io.error(message);
				if (error instanceof Error && error.name === "RunLockError") {
					return EXIT_CODES.LOCKED;
				}
				if ((error as Partial<SessionRunError>).exitCode) {
					return (error as SessionRunError).exitCode;
				}
				return EXIT_CODES.GENERAL_ERROR;
			}
		},

		async listConnectors(io = createStdIo()): Promise<number> {
			const snapshot = await inspect();
			for (const integration of snapshot.integrations) {
				const lastSyncLabel = integration.lastSyncAt ?? "never";
				const hasCredentials = await hasStoredCredentials(
					integration.connectorId,
					services,
					snapshot.config,
					snapshot.paths,
				);
				io.write(
					`${integration.label} | connector=${integration.connectorId} | enabled=${integration.enabled} | interval=${integration.interval} | credentials=${hasCredentials ? "complete" : "missing"} | last_sync=${lastSyncLabel}`,
				);
			}
			return 0;
		},

		async doctor(io = createStdIo()): Promise<number> {
			const snapshot = await inspect();
			io.write(`config_path=${snapshot.paths.configPath}`);
			io.write(`state_path=${snapshot.paths.statePath}`);
			io.write(`secrets_path=${snapshot.paths.secretsPath}`);
			io.write(`lock_path=${snapshot.paths.lockPath}`);
			io.write(`secrets=${services.secrets.describe(snapshot.paths)}`);

			for (const line of await services.state.describe()) {
				io.write(`state=${line}`);
			}

			for (const integrationSummary of snapshot.integrations) {
				const connector = services.connectors.find(
					(candidate) => candidate.id === integrationSummary.connectorId,
				);
				if (!connector) {
					continue;
				}
				const integration = snapshot.config.integrations.find(
					(candidate) => candidate.id === integrationSummary.id,
				);
				if (!integration) {
					continue;
				}
				const request = await buildSyncRequest(
					connector,
					integration,
					services,
					snapshot.config,
					snapshot.paths,
					io,
					getIntegrationRenderVersion(services, integration),
					async () => {},
					async () => {},
					async () => {},
					async () => {},
					() => {},
				);
				const check = await connector.validate(request);
				io.write(formatHealth(integration.label, check));
			}

			io.write(
				`output_dir=${await describeOutputDirectory(snapshot.config.outputDir)}`,
			);

			return 0;
		},
	};
}
