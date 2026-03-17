import type {
	ExitCode,
	IntegrationConfig,
	IntegrationRuntimeSnapshot,
	SyncRuntimeSnapshot,
	SyncSession,
	WatchStrategy,
} from "./types.js";

export interface IntegrationRunResult {
	exitCode: ExitCode;
	errorMessage: string | null;
}

export interface SessionRunError extends Error {
	exitCode: ExitCode;
}

export interface InternalIntegrationState {
	integration: IntegrationConfig;
	snapshot: IntegrationRuntimeSnapshot;
	runPromise: Promise<IntegrationRunResult> | null;
	cancelRequested: boolean;
	cancelReason: string | null;
}

export interface WatchController {
	strategy: WatchStrategy;
	startedAt: string;
	stopRequested: boolean;
	stopPromise: Promise<void>;
	resolveStop: () => void;
	loopPromise: Promise<ExitCode | null>;
	startedPromise: Promise<void>;
	resolveStarted: () => void;
	rejectStarted: (error: unknown) => void;
}

export interface InternalSyncSession extends SyncSession {
	waitForWatchCompletion(): Promise<ExitCode | null>;
}

export function createSessionRunError(
	exitCode: ExitCode,
	message: string,
): SessionRunError {
	const error = new Error(message) as SessionRunError;
	error.name = "SessionRunError";
	error.exitCode = exitCode;
	return error;
}

export function createSyncCancelledError(
	message = "Sync cancelled by user.",
): Error {
	const error = new Error(message);
	error.name = "SyncCancelledError";
	return error;
}

export function isSyncCancelledError(error: unknown): error is Error {
	return error instanceof Error && error.name === "SyncCancelledError";
}

export function cloneRuntimeSnapshot(
	snapshot: SyncRuntimeSnapshot,
): SyncRuntimeSnapshot {
	return {
		status: snapshot.status,
		watch: {
			...snapshot.watch,
			strategy: snapshot.watch.strategy ? { ...snapshot.watch.strategy } : null,
		},
		lastRunTarget: snapshot.lastRunTarget,
		lastRunStartedAt: snapshot.lastRunStartedAt,
		lastRunFinishedAt: snapshot.lastRunFinishedAt,
		lastRunExitCode: snapshot.lastRunExitCode,
		lastRunError: snapshot.lastRunError,
		integrations: snapshot.integrations.map((integration) => ({
			...integration,
			progress: integration.progress ? { ...integration.progress } : null,
		})),
		logs: snapshot.logs.map((entry) => ({ ...entry })),
	};
}

export function createIntegrationRuntimeSnapshot(summary: {
	id: string;
	connectorId: string;
	connectionId: string;
	label: string;
	enabled: boolean;
	interval: IntegrationRuntimeSnapshot["interval"];
	lastSyncAt: string | null;
}): IntegrationRuntimeSnapshot {
	return {
		id: summary.id,
		connectorId:
			summary.connectorId as IntegrationRuntimeSnapshot["connectorId"],
		connectionId: summary.connectionId,
		label: summary.label,
		enabled: summary.enabled,
		interval: summary.interval,
		status: "idle",
		running: false,
		queuedImmediateRun: false,
		lastStartedAt: null,
		lastFinishedAt: null,
		lastSuccessAt: summary.lastSyncAt,
		lastError: null,
		lastDocumentsWritten: 0,
		nextRunAt: null,
		progress: null,
	};
}

export function createWatchController(
	strategy: WatchStrategy,
	startedAt: string,
): WatchController {
	let resolveStop = () => {};
	const stopPromise = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});

	let resolveStarted = () => {};
	let rejectStarted = (_error: unknown) => {};
	const startedPromise = new Promise<void>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});

	return {
		strategy,
		startedAt,
		stopRequested: false,
		stopPromise,
		resolveStop,
		loopPromise: Promise.resolve(null),
		startedPromise,
		resolveStarted,
		rejectStarted,
	};
}
