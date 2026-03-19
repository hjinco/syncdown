import { randomUUID } from "node:crypto";

import {
	Client,
	collectPaginatedAPI,
	isFullDataSource,
	isFullPage,
} from "@notionhq/client";

import type {
	Connector,
	ConnectorPlugin,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	HealthCheck,
	IntegrationConfig,
} from "@syncdown/core";
import {
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	defineConnectorPlugin,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
} from "@syncdown/core";
import {
	toNotionCandidatePage,
	toNotionDataSource,
	toNotionPage,
} from "./notion-api-mappers.js";
import {
	extractDataSourceTitle,
	NOTION_SNAPSHOT_SCHEMA_VERSION,
	toSourceId,
	toSourceSnapshot,
} from "./notion-source.js";
import type {
	CreateNotionConnectorOptions,
	NotionAdapter,
	NotionCandidatePage,
	NotionClientFactory,
	NotionDataSource,
	NotionPage,
} from "./notion-types.js";

export type {
	CreateNotionConnectorOptions,
	NotionAdapter,
	NotionCandidatePage,
	NotionClientFactory,
	NotionDataSource,
	NotionDateValue,
	NotionFile,
	NotionFormulaValue,
	NotionPage,
	NotionParent,
	NotionPropertyValue,
	NotionRichText,
	NotionUser,
} from "./notion-types.js";

const PAGE_FETCH_CONCURRENCY = 4;
const PROGRESS_LOG_INTERVAL = 25;
const NOTION_API_VERSION = "2026-03-11";

function createNotionClient(
	token: string,
	clientFactory: NotionClientFactory = (options) => new Client(options),
): Client {
	return clientFactory({
		auth: token,
		notionVersion: NOTION_API_VERSION,
	});
}

class OfficialNotionAdapter implements NotionAdapter {
	constructor(
		private readonly clientFactory: NotionClientFactory = (options) =>
			new Client(options),
	) {}

	private getClient(token: string): Client {
		return createNotionClient(token, this.clientFactory);
	}

	async validateToken(token: string): Promise<void> {
		await this.getClient(token).search({ page_size: 1 });
	}

	async listSharedPages(token: string): Promise<NotionCandidatePage[]> {
		const results = await collectPaginatedAPI(this.getClient(token).search, {
			page_size: 100,
			filter: {
				property: "object",
				value: "page",
			},
		});

		return results
			.filter(isFullPage)
			.map((page) => toNotionCandidatePage(page));
	}

	async listSharedDataSources(token: string): Promise<NotionDataSource[]> {
		const results = await collectPaginatedAPI(this.getClient(token).search, {
			page_size: 100,
			filter: {
				property: "object",
				value: "data_source",
			},
		});

		return results
			.filter(isFullDataSource)
			.map((dataSource) => toNotionDataSource(dataSource));
	}

	async listDataSourcePages(
		token: string,
		dataSourceId: string,
		since: string | null,
	): Promise<NotionCandidatePage[]> {
		const results = await collectPaginatedAPI(
			this.getClient(token).dataSources.query,
			{
				data_source_id: dataSourceId,
				page_size: 100,
				result_type: "page",
				...(since
					? {
							filter: {
								timestamp: "last_edited_time" as const,
								last_edited_time: {
									after: since,
								},
							},
						}
					: {}),
			},
		);

		return results
			.filter(isFullPage)
			.map((page) => toNotionCandidatePage(page));
	}

	async retrievePage(token: string, pageId: string): Promise<NotionPage> {
		const page = await this.getClient(token).pages.retrieve({
			page_id: pageId,
		});
		if (!isFullPage(page)) {
			throw new Error(
				`Notion page ${pageId} is not available as a full page response`,
			);
		}

		return toNotionPage(page);
	}

	async retrievePageMarkdown(token: string, pageId: string): Promise<string> {
		const response = await this.getClient(token).pages.retrieveMarkdown({
			page_id: pageId,
		});
		return response.markdown;
	}
}

interface NotionSyncProgress {
	discovered: number;
	processed: number;
	saved: number;
	skipped: number;
	failed: number;
}

interface NotionDiscoveryResult {
	sharedPages: NotionCandidatePage[];
	sharedDataSources: NotionDataSource[];
	dataSourceMap: Map<string, string>;
}

type StoredSnapshotReuseResult = "miss" | "skipped" | "restored";
type ListableStateStore = ConnectorSyncRequest["state"] & {
	listSourceRecords?: (
		integrationId: string,
	) => Promise<Array<{ sourceId: string }>>;
};

async function processWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	handler: (item: T, index: number) => Promise<void>,
	throwIfCancelled?: () => void,
): Promise<void> {
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	let nextIndex = 0;
	let failure: unknown = null;

	const worker = async (): Promise<void> => {
		while (!failure) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) {
				return;
			}

			try {
				throwIfCancelled?.();
				await handler(items[index], index);
			} catch (error) {
				failure ??= error;
			}
		}
	};

	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (failure) {
		throw failure;
	}
}

class NotionConnector implements Connector {
	readonly id = "notion";
	readonly label = "Notion";
	readonly setupMethods = [
		{
			kind: "token",
			connectionId: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
			connectionKind: "notion-token",
			label: "Token",
			secretName(connectionId: string) {
				return `connections.${connectionId}.token`;
			},
		},
		{
			kind: "provider-oauth",
			providerId: "notion",
			requiredScopes: [],
			connectionId: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
			connectionKind: "notion-oauth-account",
			label: "OAuth",
		},
	] as const;

	constructor(private readonly adapter: NotionAdapter) {}

	private async getAuthToken(request: ConnectorSyncRequest): Promise<string> {
		if (request.resolvedAuth?.kind === "notion-token") {
			return request.resolvedAuth.token;
		}

		if (request.resolvedAuth?.kind === "notion-oauth") {
			return request.resolvedAuth.accessToken;
		}

		throw new Error("Missing Notion credentials");
	}

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return {
				status: "warn",
				message: "integration disabled",
			};
		}

		if (
			!request.resolvedAuth ||
			(request.resolvedAuth.kind !== "notion-token" &&
				request.resolvedAuth.kind !== "notion-oauth")
		) {
			return {
				status: "error",
				message: "credentials missing in encrypted store",
			};
		}

		try {
			const authToken = await this.getAuthToken(request);
			await this.adapter.validateToken(authToken);
			return {
				status: "ok",
				message:
					request.resolvedAuth.kind === "notion-token"
						? "token valid"
						: "oauth credentials valid",
			};
		} catch (error) {
			return {
				status: "error",
				message:
					error instanceof Error ? error.message : "unknown validation error",
			};
		}
	}

	private createProgressLogger(
		request: ConnectorSyncRequest,
		progress: NotionSyncProgress,
	): (force?: boolean) => void {
		return (force = false): void => {
			this.publishSyncProgress(request, progress);
			if (
				!force &&
				progress.processed > 0 &&
				progress.processed % PROGRESS_LOG_INTERVAL !== 0
			) {
				return;
			}

			request.io.write(
				`Notion progress: discovered=${progress.discovered} processed=${progress.processed} saved=${progress.saved} skipped=${progress.skipped} failed=${progress.failed}`,
			);
		};
	}

	private formatProgressDetail(progress: NotionSyncProgress): string {
		return `saved ${progress.saved} | skipped ${progress.skipped} | failed ${progress.failed}`;
	}

	private publishDiscoveryProgress(request: ConnectorSyncRequest): void {
		request.setProgress({
			mode: "indeterminate",
			phase: "Discovering workspace",
			detail: "Listing shared pages and data sources",
			completed: null,
			total: null,
			unit: "pages",
		});
	}

	private publishSyncProgress(
		request: ConnectorSyncRequest,
		progress: NotionSyncProgress,
	): void {
		request.setProgress({
			mode: "determinate",
			phase: "Syncing pages",
			detail: this.formatProgressDetail(progress),
			completed: progress.processed,
			total: Math.max(progress.discovered, progress.processed),
			unit: "pages",
		});
	}

	private publishCleanupProgress(
		request: ConnectorSyncRequest,
		progress: NotionSyncProgress,
	): void {
		request.setProgress({
			mode: "indeterminate",
			phase: "Cleaning up removed pages",
			detail: this.formatProgressDetail(progress),
			completed: null,
			total: null,
			unit: "pages",
		});
	}

	private async discoverSharedContent(
		request: ConnectorSyncRequest,
		token: string,
	): Promise<NotionDiscoveryResult> {
		this.publishDiscoveryProgress(request);
		request.io.write("Discovering shared Notion pages and data sources...");

		const [sharedPages, sharedDataSources] = await Promise.all([
			this.adapter.listSharedPages(token),
			this.adapter.listSharedDataSources(token),
		]);

		request.io.write(
			`Notion discovery: shared_pages=${sharedPages.length} data_sources=${sharedDataSources.length}`,
		);

		const dataSourceMap = new Map<string, string>();
		for (const dataSource of sharedDataSources) {
			request.throwIfCancelled();
			dataSourceMap.set(dataSource.id, extractDataSourceTitle(dataSource));
		}

		return {
			sharedPages,
			sharedDataSources,
			dataSourceMap,
		};
	}

	private async reuseStoredSnapshot(
		request: ConnectorSyncRequest,
		candidate: NotionCandidatePage,
	): Promise<StoredSnapshotReuseResult> {
		const sourceId = toSourceId(candidate.id);
		request.throwIfCancelled();
		const record = await request.state.getSourceRecord(
			request.integration.id,
			sourceId,
		);
		if (record?.sourceUpdatedAt !== candidate.lastEditedTime) {
			return "miss";
		}

		if (record.renderVersion === request.renderVersion) {
			return "skipped";
		}

		const storedSnapshot = await request.state.getSourceSnapshot(
			request.integration.id,
			sourceId,
		);
		if (
			storedSnapshot?.snapshotSchemaVersion !== NOTION_SNAPSHOT_SCHEMA_VERSION
		) {
			return "miss";
		}

		await request.persistSource(storedSnapshot.payload);
		return "restored";
	}

	private async fetchAndPersistCandidate(
		request: ConnectorSyncRequest,
		token: string,
		candidate: NotionCandidatePage,
		dataSourceMap: Map<string, string>,
	): Promise<void> {
		const [page, markdown] = await Promise.all([
			this.adapter.retrievePage(token, candidate.id),
			this.adapter.retrievePageMarkdown(token, candidate.id),
		]);
		request.throwIfCancelled();
		const source = toSourceSnapshot(
			request.integration.id,
			page,
			markdown,
			dataSourceMap,
		);
		await request.persistSource(source);
	}

	private async processCandidateBatch(
		request: ConnectorSyncRequest,
		token: string,
		label: string,
		candidates: NotionCandidatePage[],
		dataSourceMap: Map<string, string>,
		progress: NotionSyncProgress,
		seenCandidateIds: Set<string>,
		logProgress: (force?: boolean) => void,
	): Promise<void> {
		const newCandidates: NotionCandidatePage[] = [];
		let duplicateCount = 0;

		for (const candidate of candidates) {
			request.throwIfCancelled();
			if (seenCandidateIds.has(candidate.id)) {
				duplicateCount += 1;
				continue;
			}

			seenCandidateIds.add(candidate.id);
			newCandidates.push(candidate);
		}

		progress.discovered += newCandidates.length;
		this.publishSyncProgress(request, progress);
		request.io.write(
			`${label}: candidates=${candidates.length} new=${newCandidates.length} duplicates=${duplicateCount}`,
		);

		if (newCandidates.length === 0) {
			logProgress(true);
			return;
		}

		await processWithConcurrency(
			newCandidates,
			PAGE_FETCH_CONCURRENCY,
			async (candidate) => {
				try {
					request.throwIfCancelled();
					const reuseResult = await this.reuseStoredSnapshot(
						request,
						candidate,
					);
					if (reuseResult === "skipped") {
						progress.skipped += 1;
						progress.processed += 1;
						logProgress();
						return;
					}
					if (reuseResult === "restored") {
						progress.saved += 1;
						progress.processed += 1;
						logProgress();
						return;
					}

					await this.fetchAndPersistCandidate(
						request,
						token,
						candidate,
						dataSourceMap,
					);
					progress.saved += 1;
					progress.processed += 1;
					logProgress();
				} catch (error) {
					progress.failed += 1;
					request.io.error(
						`${label}: failed for page=${candidate.id} message=${error instanceof Error ? error.message : "unknown error"}`,
					);
					throw error;
				}
			},
			() => request.throwIfCancelled(),
		);

		logProgress(true);
	}

	private async processDataSources(
		request: ConnectorSyncRequest,
		token: string,
		sharedDataSources: NotionDataSource[],
		dataSourceMap: Map<string, string>,
		progress: NotionSyncProgress,
		seenCandidateIds: Set<string>,
		activeSourceIds: Set<string>,
		logProgress: (force?: boolean) => void,
	): Promise<void> {
		for (const [index, dataSource] of sharedDataSources.entries()) {
			request.throwIfCancelled();
			const label = `Data source ${index + 1}/${sharedDataSources.length}: ${dataSourceMap.get(dataSource.id) ?? dataSource.id}`;
			request.io.write(`Querying ${label}`);
			const currentPages = request.since
				? await this.adapter.listDataSourcePages(token, dataSource.id, null)
				: null;
			const pages = await this.adapter.listDataSourcePages(
				token,
				dataSource.id,
				request.since,
			);
			for (const candidate of currentPages ?? pages) {
				activeSourceIds.add(toSourceId(candidate.id));
			}
			request.io.write(
				`${label}: incremental=${request.since ? "yes" : "no"} candidates=${pages.length}${currentPages ? ` current=${currentPages.length}` : ""}`,
			);
			await this.processCandidateBatch(
				request,
				token,
				label,
				pages,
				dataSourceMap,
				progress,
				seenCandidateIds,
				logProgress,
			);
		}
	}

	private async deleteStaleSources(
		request: ConnectorSyncRequest,
		activeSourceIds: Set<string>,
	): Promise<number> {
		const state = request.state as ListableStateStore;
		if (typeof state.listSourceRecords !== "function") {
			return 0;
		}

		const records = await state.listSourceRecords(request.integration.id);
		let deletedCount = 0;

		for (const record of records) {
			request.throwIfCancelled();
			if (activeSourceIds.has(record.sourceId)) {
				continue;
			}

			await request.deleteSource(record.sourceId);
			deletedCount += 1;
		}

		return deletedCount;
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		request.throwIfCancelled();
		const token = await this.getAuthToken(request);
		const nextCursor = new Date().toISOString();
		const progress: NotionSyncProgress = {
			discovered: 0,
			processed: 0,
			saved: 0,
			skipped: 0,
			failed: 0,
		};
		const seenCandidateIds = new Set<string>();
		const activeSourceIds = new Set<string>();
		const logProgress = this.createProgressLogger(request, progress);
		request.throwIfCancelled();
		const { sharedPages, sharedDataSources, dataSourceMap } =
			await this.discoverSharedContent(request, token);
		for (const candidate of sharedPages) {
			activeSourceIds.add(toSourceId(candidate.id));
		}

		request.throwIfCancelled();
		await this.processCandidateBatch(
			request,
			token,
			"Shared pages",
			sharedPages,
			dataSourceMap,
			progress,
			seenCandidateIds,
			logProgress,
		);
		request.throwIfCancelled();
		await this.processDataSources(
			request,
			token,
			sharedDataSources,
			dataSourceMap,
			progress,
			seenCandidateIds,
			activeSourceIds,
			logProgress,
		);
		request.throwIfCancelled();
		this.publishCleanupProgress(request, progress);
		const deletedCount = await this.deleteStaleSources(
			request,
			activeSourceIds,
		);

		request.io.write(
			`Notion sync complete. discovered=${progress.discovered} processed=${progress.processed} saved=${progress.saved} skipped=${progress.skipped} failed=${progress.failed} deleted=${deletedCount}`,
		);

		return {
			nextCursor,
		};
	}
}

function normalizeNotionConnection(
	entry: Partial<{
		id: string;
		kind: string;
		label: string;
		oauthAppId?: string;
		workspaceId?: string;
		workspaceName?: string;
		botId?: string;
		ownerUserId?: string;
		ownerUserName?: string;
	}>,
) {
	if (typeof entry.id !== "string" || typeof entry.label !== "string") {
		return [];
	}

	if (entry.kind === "notion-token") {
		return [
			{
				id: entry.id,
				kind: "notion-token" as const,
				label: entry.label,
				workspaceName:
					typeof entry.workspaceName === "string"
						? entry.workspaceName
						: undefined,
			},
		];
	}

	if (
		entry.kind === "notion-oauth-account" &&
		typeof entry.oauthAppId === "string"
	) {
		return [
			{
				id: entry.id,
				kind: "notion-oauth-account" as const,
				label: entry.label,
				oauthAppId: entry.oauthAppId,
				workspaceId:
					typeof entry.workspaceId === "string" ? entry.workspaceId : undefined,
				workspaceName:
					typeof entry.workspaceName === "string"
						? entry.workspaceName
						: undefined,
				botId: typeof entry.botId === "string" ? entry.botId : undefined,
				ownerUserId:
					typeof entry.ownerUserId === "string" ? entry.ownerUserId : undefined,
				ownerUserName:
					typeof entry.ownerUserName === "string"
						? entry.ownerUserName
						: undefined,
			},
		];
	}

	return [];
}

function normalizeNotionIntegration(entry: Partial<IntegrationConfig>) {
	if (
		entry.connectorId !== "notion" ||
		typeof entry.id !== "string" ||
		typeof entry.connectionId !== "string" ||
		typeof entry.label !== "string" ||
		typeof entry.enabled !== "boolean" ||
		(entry.interval !== "5m" &&
			entry.interval !== "15m" &&
			entry.interval !== "1h" &&
			entry.interval !== "6h" &&
			entry.interval !== "24h")
	) {
		return [];
	}

	return [
		{
			id: entry.id,
			connectorId: "notion" as const,
			connectionId: entry.connectionId,
			label: entry.label,
			enabled: entry.enabled,
			interval: entry.interval,
			config: {},
		},
	];
}

export function createNotionConnectorPlugin(
	options: CreateNotionConnectorOptions = {},
): ConnectorPlugin {
	const runtime = new NotionConnector(
		options.adapter ?? new OfficialNotionAdapter(options.clientFactory),
	);
	return defineConnectorPlugin({
		id: runtime.id,
		label: runtime.label,
		setupMethods: [
			{
				kind: "token",
				connectionId: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
				connectionKind: "notion-token",
				label: "Token",
				secretName(connectionId) {
					return `connections.${connectionId}.token`;
				},
			},
			{
				kind: "provider-oauth",
				providerId: "notion",
				requiredScopes: [],
				connectionId: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
				connectionKind: "notion-oauth-account",
				label: "OAuth",
			},
		],
		validate: runtime.validate.bind(runtime),
		sync: runtime.sync.bind(runtime),
		manifest: {
			id: runtime.id,
			label: runtime.label,
			setupMethods: [
				{
					kind: "token",
					connectionId: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
					connectionKind: "notion-token",
					label: "Token",
					secretName(connectionId) {
						return `connections.${connectionId}.token`;
					},
				},
				{
					kind: "provider-oauth",
					providerId: "notion",
					requiredScopes: [],
					connectionId: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
					connectionKind: "notion-oauth-account",
					label: "OAuth",
				},
			],
			cliAliases: [
				{
					key: "notion.enabled",
					async setValue(context, rawValue) {
						if (rawValue !== "true" && rawValue !== "false") {
							throw new Error("notion.enabled must be `true` or `false`.");
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "notion",
						);
						if (!integration) {
							throw new Error("Missing default Notion integration.");
						}
						integration.enabled = rawValue === "true";
						return `Set notion.enabled=${integration.enabled}`;
					},
				},
				{
					key: "notion.interval",
					async setValue(context, rawValue) {
						if (
							rawValue !== "5m" &&
							rawValue !== "15m" &&
							rawValue !== "1h" &&
							rawValue !== "6h" &&
							rawValue !== "24h"
						) {
							throw new Error(
								"notion.interval must be one of: 5m, 15m, 1h, 6h, 24h",
							);
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "notion",
						);
						if (!integration) {
							throw new Error("Missing default Notion integration.");
						}
						integration.interval = rawValue;
						return `Set notion.interval=${integration.interval}`;
					},
				},
				{
					key: "notion.authMethod",
					async setValue(context, rawValue) {
						if (rawValue !== "token" && rawValue !== "oauth") {
							throw new Error("notion.authMethod must be `token` or `oauth`.");
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "notion",
						);
						if (!integration) {
							throw new Error("Missing default Notion integration.");
						}
						integration.connectionId =
							rawValue === "oauth"
								? DEFAULT_NOTION_OAUTH_CONNECTION_ID
								: DEFAULT_NOTION_TOKEN_CONNECTION_ID;
						return `Set notion.authMethod=${rawValue}`;
					},
				},
				{
					key: "notion.token",
					secret: true,
					async setValue(context, rawValue) {
						const value = rawValue.trim();
						if (!value) {
							throw new Error("notion.token cannot be empty.");
						}
						await context.secrets.setSecret(
							`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
							value,
							context.paths,
						);
						return "Stored notion.token in encrypted secrets store.";
					},
					async unsetValue(context) {
						await context.secrets.deleteSecret(
							`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
							context.paths,
						);
						return "Removed notion.token from encrypted secrets store.";
					},
				},
				{
					key: "notion.oauth.clientId",
					secret: true,
					async setValue(context, rawValue) {
						const value = rawValue.trim();
						if (!value) {
							throw new Error("notion.oauth.clientId cannot be empty.");
						}
						await context.secrets.setSecret(
							getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID)
								.clientId,
							value,
							context.paths,
						);
						return "Stored notion.oauth.clientId in encrypted secrets store.";
					},
					async unsetValue(context) {
						await context.secrets.deleteSecret(
							getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID)
								.clientId,
							context.paths,
						);
						return "Removed notion.oauth.clientId from encrypted secrets store.";
					},
				},
				{
					key: "notion.oauth.clientSecret",
					secret: true,
					async setValue(context, rawValue) {
						const value = rawValue.trim();
						if (!value) {
							throw new Error("notion.oauth.clientSecret cannot be empty.");
						}
						await context.secrets.setSecret(
							getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID)
								.clientSecret,
							value,
							context.paths,
						);
						return "Stored notion.oauth.clientSecret in encrypted secrets store.";
					},
					async unsetValue(context) {
						await context.secrets.deleteSecret(
							getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID)
								.clientSecret,
							context.paths,
						);
						return "Removed notion.oauth.clientSecret from encrypted secrets store.";
					},
				},
				{
					key: "notion.oauth.refreshToken",
					secret: true,
					async setValue(context, rawValue) {
						const value = rawValue.trim();
						if (!value) {
							throw new Error("notion.oauth.refreshToken cannot be empty.");
						}
						await context.secrets.setSecret(
							getNotionOAuthConnectionSecretNames(
								DEFAULT_NOTION_OAUTH_CONNECTION_ID,
							).refreshToken,
							value,
							context.paths,
						);
						return "Stored notion.oauth.refreshToken in encrypted secrets store.";
					},
					async unsetValue(context) {
						await context.secrets.deleteSecret(
							getNotionOAuthConnectionSecretNames(
								DEFAULT_NOTION_OAUTH_CONNECTION_ID,
							).refreshToken,
							context.paths,
						);
						return "Removed notion.oauth.refreshToken from encrypted secrets store.";
					},
				},
			],
		},
		render: {
			version: "1",
		},
		seedOAuthApps() {
			return [
				{
					id: DEFAULT_NOTION_OAUTH_APP_ID,
					providerId: "notion",
					label: "Default Notion OAuth App",
				},
			];
		},
		seedConnections() {
			return [
				{
					id: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
					kind: "notion-token",
					label: "Default Notion Token Connection",
				},
				{
					id: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
					kind: "notion-oauth-account",
					label: "Default Notion OAuth Connection",
					oauthAppId: DEFAULT_NOTION_OAUTH_APP_ID,
				},
			];
		},
		seedIntegrations() {
			return [
				{
					id: randomUUID(),
					connectorId: "notion",
					connectionId: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
					label: "Notion",
					enabled: false,
					interval: "1h",
					config: {},
				},
			];
		},
		normalizeConnection: normalizeNotionConnection,
		normalizeIntegration: normalizeNotionIntegration,
	});
}

export function createNotionConnector(
	options: CreateNotionConnectorOptions = {},
): Connector {
	return createNotionConnectorPlugin(options);
}
