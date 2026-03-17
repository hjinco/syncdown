import {
	Client,
	collectPaginatedAPI,
	isFullDataSource,
	isFullPage,
} from "@notionhq/client";

import type {
	Connector,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	HealthCheck,
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
		},
		{
			kind: "provider-oauth",
			providerId: "notion",
			requiredScopes: [],
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

export function createNotionConnector(
	options: CreateNotionConnectorOptions = {},
): Connector {
	return new NotionConnector(
		options.adapter ?? new OfficialNotionAdapter(options.clientFactory),
	);
}
