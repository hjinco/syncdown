import {
	findConnection,
	findIntegration,
	findOAuthApp,
	getDefaultIntegration,
	isNotionOAuthConnection,
	toIntegrationSummary,
} from "./config-model.js";
import {
	hasGoogleConnectionCredentials,
	isGoogleProviderAuth,
	readGoogleConnectionCredentials,
} from "./google-auth.js";
import {
	getNotionOAuthConnectionSecretNames,
	hasNotionOAuthConnectionCredentials,
	readNotionOAuthConnectionCredentials,
	refreshNotionAccessToken,
} from "./notion-auth.js";
import type { AppRuntime } from "./runtime.js";
import { isSyncCancelledError } from "./session-internals.js";
import type {
	AppIo,
	AppPaths,
	AppSnapshot,
	ConnectionConfig,
	Connector,
	ConnectorId,
	ConnectorSyncRequest,
	ExitCode,
	HealthCheck,
	IntegrationConfig,
	IntegrationRuntimeSnapshot,
	IntegrationSummary,
	ResolvedConnectionAuth,
	SyncdownConfig,
	SyncdownServices,
	SyncRunTarget,
} from "./types.js";
import { EXIT_CODES } from "./types.js";

const CONNECTOR_SYNC_RETRY_ATTEMPTS = 3;
const CONNECTOR_SYNC_RETRY_DELAY_MS = 1_000;

export function getNotionConnectionSecretName(connectionId: string): string {
	return `connections.${connectionId}.token`;
}

export function buildIntegrationSummary(
	connector: Connector,
	integration: IntegrationConfig,
	lastSyncAt: string | null,
): IntegrationSummary {
	return toIntegrationSummary(integration, connector, lastSyncAt);
}

export function getConnectorForIntegration(
	services: SyncdownServices,
	integration: IntegrationConfig,
): Connector | undefined {
	return services.connectors.find(
		(candidate) => candidate.id === integration.connectorId,
	);
}

export function getRunTargetLabel(target: SyncRunTarget): string {
	switch (target.kind) {
		case "all":
			return "all";
		case "connector":
			return `connector:${target.connectorId}`;
		case "integration":
			return `integration:${target.integrationId}`;
	}
}

export function getIntegrationRenderVersion(
	services: SyncdownServices,
	integration: IntegrationConfig,
): string {
	return services.renderer.getVersion(integration.connectorId);
}

async function resolveConnectionAuth(
	integration: IntegrationConfig,
	connector: Connector,
	config: SyncdownConfig,
	paths: AppPaths,
	services: SyncdownServices,
): Promise<{
	connection: ConnectionConfig;
	resolvedAuth: ResolvedConnectionAuth | null;
}> {
	const connection = findConnection(config, integration.connectionId);
	if (!connection) {
		throw new Error(`Missing connection: ${integration.connectionId}`);
	}

	if (
		integration.connectorId === "gmail" ||
		integration.connectorId === "google-calendar"
	) {
		if (connection.kind !== "google-account") {
			throw new Error(
				`Integration ${integration.id} requires a google-account connection`,
			);
		}

		const googleSetupMethod = connector.setupMethods.find((setupMethod) =>
			isGoogleProviderAuth(setupMethod),
		);
		if (!googleSetupMethod) {
			throw new Error(
				`Connector ${connector.id} is not configured for Google provider auth`,
			);
		}

		const oauthApp = findOAuthApp(config, connection.oauthAppId);
		if (!oauthApp) {
			throw new Error(`Missing oauth app: ${connection.oauthAppId}`);
		}

		const hasCredentials = await hasGoogleConnectionCredentials(
			services.secrets,
			paths,
			{
				oauthAppId: oauthApp.id,
				connectionId: connection.id,
			},
		);
		return {
			connection,
			resolvedAuth: hasCredentials
				? {
						kind: "google-oauth",
						...(await readGoogleConnectionCredentials(services.secrets, paths, {
							oauthAppId: oauthApp.id,
							connectionId: connection.id,
						})),
						requiredScopes: googleSetupMethod.requiredScopes,
					}
				: null,
		};
	}

	if (connection.kind === "notion-token") {
		const token = await services.secrets.getSecret(
			getNotionConnectionSecretName(connection.id),
			paths,
		);

		return {
			connection,
			resolvedAuth: token
				? {
						kind: "notion-token",
						token,
					}
				: null,
		};
	}

	if (!isNotionOAuthConnection(connection)) {
		throw new Error(
			`Integration ${integration.id} requires a notion connection`,
		);
	}

	if (
		!(await hasNotionOAuthConnectionCredentials(services.secrets, paths, {
			oauthAppId: connection.oauthAppId,
			connectionId: connection.id,
		}))
	) {
		return {
			connection,
			resolvedAuth: null,
		};
	}

	const refreshed = await refreshNotionAccessToken(
		fetch,
		await readNotionOAuthConnectionCredentials(services.secrets, paths, {
			oauthAppId: connection.oauthAppId,
			connectionId: connection.id,
		}),
	);
	await services.secrets.setSecret(
		getNotionOAuthConnectionSecretNames(connection.id).refreshToken,
		refreshed.refreshToken,
		paths,
	);
	return {
		connection,
		resolvedAuth: {
			kind: "notion-oauth",
			accessToken: refreshed.accessToken,
			workspaceId: refreshed.workspaceId ?? connection.workspaceId,
			workspaceName: refreshed.workspaceName ?? connection.workspaceName,
			botId: refreshed.botId ?? connection.botId,
			ownerUserId: refreshed.ownerUserId ?? connection.ownerUserId,
			ownerUserName: refreshed.ownerUserName ?? connection.ownerUserName,
		},
	};
}

export async function buildSyncRequest(
	connector: Connector,
	integration: IntegrationConfig,
	services: SyncdownServices,
	config: SyncdownConfig,
	paths: AppPaths,
	io: AppIo,
	renderVersion: string,
	throwIfCancelled: ConnectorSyncRequest["throwIfCancelled"],
	persistSource: ConnectorSyncRequest["persistSource"],
	deleteSource: ConnectorSyncRequest["deleteSource"],
	resetIntegrationState: ConnectorSyncRequest["resetIntegrationState"],
	setProgress: ConnectorSyncRequest["setProgress"],
): Promise<ConnectorSyncRequest> {
	const { connection, resolvedAuth } = await resolveConnectionAuth(
		integration,
		connector,
		config,
		paths,
		services,
	);
	return {
		config,
		integration,
		connection,
		io,
		paths,
		since: await services.state.getCursor(integration.id),
		renderVersion,
		secrets: services.secrets,
		state: services.state,
		resolvedAuth,
		throwIfCancelled,
		persistSource,
		deleteSource,
		resetIntegrationState,
		setProgress,
	};
}

export function formatHealth(label: string, check: HealthCheck): string {
	return `${label}: ${check.status.toUpperCase()} - ${check.message}`;
}

export async function hasIntegrationStoredCredentials(
	integration: IntegrationConfig,
	services: SyncdownServices,
	config: SyncdownConfig,
	paths: AppPaths,
): Promise<boolean> {
	const connection = findConnection(config, integration.connectionId);
	if (!connection) {
		return false;
	}

	if (
		integration.connectorId === "gmail" ||
		integration.connectorId === "google-calendar"
	) {
		if (connection.kind !== "google-account") {
			return false;
		}

		return hasGoogleConnectionCredentials(services.secrets, paths, {
			oauthAppId: connection.oauthAppId,
			connectionId: connection.id,
		});
	}

	if (connection.kind === "notion-token") {
		return services.secrets.hasSecret(
			getNotionConnectionSecretName(connection.id),
			paths,
		);
	}

	if (isNotionOAuthConnection(connection)) {
		return hasNotionOAuthConnectionCredentials(services.secrets, paths, {
			oauthAppId: connection.oauthAppId,
			connectionId: connection.id,
		});
	}

	return false;
}

export async function hasStoredCredentials(
	connectorId: ConnectorId,
	services: SyncdownServices,
	config: SyncdownConfig,
	paths: AppPaths,
): Promise<boolean> {
	return hasIntegrationStoredCredentials(
		getDefaultIntegration(config, connectorId),
		services,
		config,
		paths,
	);
}

export function getEnabledIntegrations(
	services: SyncdownServices,
	config: SyncdownConfig,
): Array<{ connector: Connector; integration: IntegrationConfig }> {
	return config.integrations.flatMap((integration) => {
		if (!integration.enabled) {
			return [];
		}

		const connector = getConnectorForIntegration(services, integration);
		return connector ? [{ connector, integration }] : [];
	});
}

function hashSnapshotPayload(value: unknown): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(value))
		.digest("hex");
}

export function requireOutputDir(config: SyncdownConfig): string {
	if (!config.outputDir) {
		throw new Error("Output directory is not configured.");
	}

	return config.outputDir;
}

async function withRetries<T>(
	label: string,
	io: AppIo,
	action: () => Promise<T>,
	runtime: AppRuntime,
	attempts = CONNECTOR_SYNC_RETRY_ATTEMPTS,
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			if (attempt > 1) {
				io.write(`${label}: retry ${attempt}/${attempts}`);
			}
			return await action();
		} catch (error) {
			if (isSyncCancelledError(error)) {
				throw error;
			}
			lastError = error;
			if (attempt === attempts) {
				throw error;
			}
			const message = error instanceof Error ? error.message : "unknown error";
			io.error(`${label}: attempt ${attempt}/${attempts} failed: ${message}`);
			await runtime.sleep(CONNECTOR_SYNC_RETRY_DELAY_MS * attempt);
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error(`${label}: retry failed`);
}

export async function runIntegrationSync({
	connector,
	integration,
	snapshot,
	services,
	appSnapshot,
	runtime,
	io,
	throwIfCancelled,
	emitSnapshot,
}: {
	connector: Connector;
	integration: IntegrationConfig;
	snapshot: IntegrationRuntimeSnapshot;
	services: SyncdownServices;
	appSnapshot: AppSnapshot;
	runtime: AppRuntime;
	io: AppIo;
	throwIfCancelled(): void;
	emitSnapshot(): void;
}): Promise<ExitCode> {
	const startedAt = runtime.now().toISOString();
	const renderVersion = getIntegrationRenderVersion(services, integration);
	snapshot.running = true;
	snapshot.status = "running";
	snapshot.lastStartedAt = startedAt;
	snapshot.lastFinishedAt = null;
	snapshot.lastError = null;
	snapshot.lastDocumentsWritten = 0;
	snapshot.nextRunAt = null;
	snapshot.progress = null;
	emitSnapshot();

	try {
		const outputDir = requireOutputDir(appSnapshot.config);
		io.write(`Integration start: ${integration.label}`);
		let integrationWrites = 0;
		const persistSource: ConnectorSyncRequest["persistSource"] = async (
			source,
		) => {
			throwIfCancelled();
			const withIds = {
				...source,
				integrationId: integration.id,
				connectorId: integration.connectorId,
			};
			const rendered = services.renderer.render(withIds);
			const previousRecord = await services.state.getSourceRecord(
				integration.id,
				withIds.sourceId,
			);
			const sinkResult = await services.sink.write({
				outputDir,
				document: rendered,
			});
			const snapshotHash = hashSnapshotPayload(withIds);

			if (
				previousRecord &&
				previousRecord.relativePath !== rendered.relativePath
			) {
				await services.sink.delete(outputDir, previousRecord.relativePath);
			}

			await services.state.upsertSourceSnapshot({
				integrationId: integration.id,
				connectorId: integration.connectorId,
				sourceId: withIds.sourceId,
				snapshotHash,
				snapshotSchemaVersion: withIds.snapshotSchemaVersion,
				payload: withIds,
			});

			await services.state.upsertSourceRecord({
				integrationId: integration.id,
				connectorId: integration.connectorId,
				sourceId: withIds.sourceId,
				entityType: withIds.entityType,
				relativePath: rendered.relativePath,
				sourceHash: withIds.sourceHash,
				renderVersion,
				snapshotHash,
				sourceUpdatedAt: withIds.metadata.updatedAt,
				lastRenderedAt: runtime.now().toISOString(),
			});

			integrationWrites += 1;
			snapshot.lastDocumentsWritten = integrationWrites;
			emitSnapshot();
			throwIfCancelled();
			io.write(`Document ${sinkResult.action}: ${rendered.relativePath}`);
		};
		const deleteSource: ConnectorSyncRequest["deleteSource"] = async (
			sourceId,
		) => {
			throwIfCancelled();
			const previousRecord = await services.state.getSourceRecord(
				integration.id,
				sourceId,
			);
			if (!previousRecord) {
				return;
			}

			await services.sink.delete(outputDir, previousRecord.relativePath);
			await services.state.deleteSourceSnapshot(integration.id, sourceId);
			await services.state.deleteSourceRecord(integration.id, sourceId);
			throwIfCancelled();
			io.write(`Document deleted: ${previousRecord.relativePath}`);
		};
		const resetIntegrationRequestState: ConnectorSyncRequest["resetIntegrationState"] =
			async () => {
				throwIfCancelled();
				await resetIntegrationState({
					integration,
					services,
					outputDir,
					io,
				});
				throwIfCancelled();
			};
		const setProgress: ConnectorSyncRequest["setProgress"] = (progress) => {
			snapshot.progress = progress ? { ...progress } : null;
			emitSnapshot();
		};

		const request = await buildSyncRequest(
			connector,
			integration,
			services,
			appSnapshot.config,
			appSnapshot.paths,
			io,
			renderVersion,
			throwIfCancelled,
			persistSource,
			deleteSource,
			resetIntegrationRequestState,
			setProgress,
		);
		request.throwIfCancelled();
		const check = await connector.validate(request);
		request.throwIfCancelled();
		io.write(formatHealth(integration.label, check));

		if (check.status === "error") {
			snapshot.status = "error";
			snapshot.running = false;
			snapshot.lastFinishedAt = runtime.now().toISOString();
			snapshot.lastError = check.message;
			snapshot.progress = null;
			emitSnapshot();
			return EXIT_CODES.VALIDATION_ERROR;
		}

		const result = await withRetries(
			`${integration.label} sync`,
			io,
			() => connector.sync(request),
			runtime,
		);
		request.throwIfCancelled();
		await services.state.setCursor(integration.id, result.nextCursor);
		const completedAt = runtime.now().toISOString();
		await services.state.setLastSyncAt(integration.id, completedAt);
		snapshot.status = "success";
		snapshot.running = false;
		snapshot.lastFinishedAt = completedAt;
		snapshot.lastSuccessAt = completedAt;
		snapshot.lastError = null;
		snapshot.progress = null;
		emitSnapshot();
		io.write(
			`Integration done: ${integration.label} documents=${integrationWrites}`,
		);
		return EXIT_CODES.OK;
	} catch (error) {
		if (isSyncCancelledError(error)) {
			io.write(`Integration cancelled: ${integration.label}`);
			snapshot.status = "idle";
			snapshot.running = false;
			snapshot.lastFinishedAt = runtime.now().toISOString();
			snapshot.lastError = null;
			snapshot.progress = null;
			emitSnapshot();
			return EXIT_CODES.GENERAL_ERROR;
		}

		const message = error instanceof Error ? error.message : "Run failed";
		io.error(message);
		snapshot.status = "error";
		snapshot.running = false;
		snapshot.lastFinishedAt = runtime.now().toISOString();
		snapshot.lastError = message;
		snapshot.progress = null;
		emitSnapshot();
		return EXIT_CODES.SYNC_ERROR;
	}
}

export async function resetIntegrationState({
	integration,
	services,
	outputDir,
	io,
}: {
	integration: IntegrationConfig;
	services: SyncdownServices;
	outputDir: string;
	io: AppIo;
}): Promise<number> {
	io.write(`Resetting integration state: ${integration.label}`);

	const deletedRecords = await services.state.resetIntegration(integration.id);
	const deletedPaths = new Set(
		deletedRecords.map((record) => record.relativePath),
	);

	for (const relativePath of deletedPaths) {
		await services.sink.delete(outputDir, relativePath);
	}

	io.write(
		`Integration reset: ${integration.label} documents_removed=${deletedPaths.size}`,
	);

	return deletedPaths.size;
}

export function getTargetIntegrations(
	services: SyncdownServices,
	appSnapshot: AppSnapshot,
	target: SyncRunTarget,
): Array<{ connector: Connector; integration: IntegrationConfig }> {
	if (target.kind === "all") {
		return getEnabledIntegrations(services, appSnapshot.config);
	}

	if (target.kind === "connector") {
		return getEnabledIntegrations(services, appSnapshot.config).filter(
			(entry) => entry.integration.connectorId === target.connectorId,
		);
	}

	const integration = findIntegration(appSnapshot.config, target.integrationId);
	if (!integration || !integration.enabled) {
		return [];
	}

	const connector = getConnectorForIntegration(services, integration);
	return connector ? [{ connector, integration }] : [];
}
