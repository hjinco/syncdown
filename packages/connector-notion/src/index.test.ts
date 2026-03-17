import { expect, test } from "bun:test";

import type {
	AppIo,
	AppPaths,
	ConnectorSyncRequest,
	IntegrationRuntimeProgress,
	SecretsStore,
	SourceRecord,
	SourceSnapshot,
	StateStore,
	StoredSourceSnapshot,
} from "@syncdown/core";
import {
	createDefaultConfig,
	getDefaultConnection,
	getDefaultIntegration,
} from "@syncdown/core";

import {
	createNotionConnector,
	type NotionAdapter,
	type NotionCandidatePage,
	type NotionClientFactory,
	type NotionDataSource,
	type NotionPage,
} from "./index.js";

const NOTION_INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";

class MemoryStateStore implements StateStore {
	readonly records = new Map<string, SourceRecord>();
	readonly snapshots = new Map<string, StoredSourceSnapshot>();

	async getCursor(): Promise<string | null> {
		return null;
	}

	async setCursor(): Promise<void> {}

	async getLastSyncAt(): Promise<string | null> {
		return null;
	}

	async setLastSyncAt(): Promise<void> {}

	async resetIntegration(integrationId: string): Promise<SourceRecord[]> {
		const deletedRecords = [...this.records.values()].filter(
			(record) => record.integrationId === integrationId,
		);

		for (const record of deletedRecords) {
			this.records.delete(`${record.integrationId}:${record.sourceId}`);
			this.snapshots.delete(`${record.integrationId}:${record.sourceId}`);
		}

		return deletedRecords;
	}

	async getSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<SourceRecord | null> {
		return this.records.get(`${integrationId}:${sourceId}`) ?? null;
	}

	async listSourceRecords(integrationId: string): Promise<SourceRecord[]> {
		return [...this.records.values()].filter(
			(record) => record.integrationId === integrationId,
		);
	}

	async upsertSourceRecord(record: SourceRecord): Promise<void> {
		this.records.set(`${record.integrationId}:${record.sourceId}`, record);
	}

	async deleteSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		this.records.delete(`${integrationId}:${sourceId}`);
	}

	async getSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<StoredSourceSnapshot | null> {
		return this.snapshots.get(`${integrationId}:${sourceId}`) ?? null;
	}

	async upsertSourceSnapshot(snapshot: StoredSourceSnapshot): Promise<void> {
		this.snapshots.set(
			`${snapshot.integrationId}:${snapshot.sourceId}`,
			snapshot,
		);
	}

	async deleteSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		this.snapshots.delete(`${integrationId}:${sourceId}`);
	}

	async describe(): Promise<string[]> {
		return [];
	}
}

class StaticSecretsStore implements SecretsStore {
	async hasSecret(): Promise<boolean> {
		return true;
	}

	async getSecret(): Promise<string | null> {
		return "secret-token";
	}

	async setSecret(): Promise<void> {}

	async deleteSecret(): Promise<void> {}

	describe(): string {
		return "memory";
	}
}

function createRequest(
	state: StateStore,
	persistSource: (source: SourceSnapshot) => Promise<void>,
	io: AppIo = { write() {}, error() {} },
	options: {
		connectionId?: string;
		resolvedAuth?: ConnectorSyncRequest["resolvedAuth"];
		setProgress?: ConnectorSyncRequest["setProgress"];
	} = {},
): ConnectorSyncRequest {
	const paths: AppPaths = {
		configDir: "/tmp/config",
		dataDir: "/tmp/data",
		configPath: "/tmp/config/config.json",
		statePath: "/tmp/data/state.db",
		secretsPath: "/tmp/data/secrets.enc",
		masterKeyPath: "/tmp/data/master.key",
		lockPath: "/tmp/data/sync.lock",
	};
	const config = createDefaultConfig();
	config.outputDir = "/tmp/output";
	const integration = getDefaultIntegration(config, "notion");
	integration.enabled = true;
	integration.id = NOTION_INTEGRATION_ID;
	if (options.connectionId) {
		integration.connectionId = options.connectionId;
	}
	const connection = getDefaultConnection(config, "notion");

	return {
		config,
		integration,
		connection,
		io,
		paths,
		since: null,
		renderVersion: "renderer-v1",
		secrets: new StaticSecretsStore(),
		state,
		throwIfCancelled() {},
		resolvedAuth: options.resolvedAuth ?? {
			kind: "notion-token",
			token: "secret-token",
		},
		persistSource,
		deleteSource: async () => {},
		resetIntegrationState: async () => {},
		setProgress: options.setProgress ?? (() => {}),
	};
}

function createPage(
	pageId: string,
	lastEditedTime: string,
	title = pageId,
): NotionPage {
	return {
		id: pageId,
		created_time: "2026-03-01T00:00:00.000Z",
		last_edited_time: lastEditedTime,
		archived: false,
		in_trash: false,
		url: `https://notion.so/${pageId}`,
		public_url: null,
		parent: {
			type: "workspace",
			workspace: true,
		},
		properties: {
			Name: {
				type: "title",
				title: [{ plain_text: title }],
			},
		},
	};
}

function createSourceRecord(
	sourceId: string,
	overrides: Partial<SourceRecord> = {},
): SourceRecord {
	return {
		integrationId: NOTION_INTEGRATION_ID,
		connectorId: "notion",
		sourceId,
		entityType: "page",
		relativePath: `notion/pages/${sourceId}.md`,
		sourceHash: `hash-${sourceId}`,
		renderVersion: "renderer-v1",
		snapshotHash: `snapshot-${sourceId}`,
		sourceUpdatedAt: "2026-03-16T00:00:00.000Z",
		...overrides,
	};
}

function createStoredSnapshot(
	sourceId: string,
	overrides: Partial<StoredSourceSnapshot> = {},
): StoredSourceSnapshot {
	return {
		integrationId: NOTION_INTEGRATION_ID,
		connectorId: "notion",
		sourceId,
		snapshotHash: `snapshot-${sourceId}`,
		snapshotSchemaVersion: "1",
		payload: {
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId,
			entityType: "page",
			title: "Alpha",
			slug: "",
			pathHint: { kind: "page" },
			metadata: {
				archived: false,
				updatedAt: "2026-03-16T00:00:00.000Z",
			},
			bodyMd: "body",
			sourceHash: `hash-${sourceId}`,
			snapshotSchemaVersion: "1",
		},
		...overrides,
	};
}

function createAdapter(overrides: Partial<NotionAdapter>): NotionAdapter {
	return {
		async validateToken(): Promise<void> {},
		async listSharedPages(): Promise<NotionCandidatePage[]> {
			return [];
		},
		async listSharedDataSources(): Promise<NotionDataSource[]> {
			return [];
		},
		async listDataSourcePages(): Promise<NotionCandidatePage[]> {
			return [];
		},
		async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
			return createPage(pageId, "2026-03-16T00:00:00.000Z");
		},
		async retrievePageMarkdown(): Promise<string> {
			return "body";
		},
		...overrides,
	};
}

test("uses the latest Notion API version when creating the official client", async () => {
	const clientOptions: Array<{ auth?: string; notionVersion?: string }> = [];
	const clientFactory: NotionClientFactory = ((options) => {
		clientOptions.push({
			auth: typeof options?.auth === "string" ? options.auth : undefined,
			notionVersion: options?.notionVersion,
		});

		return {
			async search() {},
		} as unknown as ReturnType<NotionClientFactory>;
	}) as NotionClientFactory;

	const connector = createNotionConnector({
		clientFactory,
	});

	const health = await connector.validate(
		createRequest(new MemoryStateStore(), async () => {}),
	);

	expect(health).toEqual({
		status: "ok",
		message: "token valid",
	});
	expect(clientOptions).toEqual([
		{
			auth: "secret-token",
			notionVersion: "2026-03-11",
		},
	]);
});

test("oauth credentials validate and sync through the same bearer token path", async () => {
	const persisted: SourceSnapshot[] = [];
	const connector = createNotionConnector({
		adapter: createAdapter({
			async validateToken(token): Promise<void> {
				expect(token).toBe("oauth-access-token");
			},
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-17T00:00:00.000Z" }];
			},
			async retrievePage(token, pageId): Promise<NotionPage> {
				expect(token).toBe("oauth-access-token");
				return createPage(pageId, "2026-03-17T00:00:00.000Z", "OAuth Page");
			},
			async retrievePageMarkdown(token): Promise<string> {
				expect(token).toBe("oauth-access-token");
				return "oauth-body";
			},
		}),
	});

	const request = createRequest(
		new MemoryStateStore(),
		async (source) => {
			persisted.push(source);
		},
		{ write() {}, error() {} },
		{
			connectionId: "notion-oauth-default",
			resolvedAuth: {
				kind: "notion-oauth",
				accessToken: "oauth-access-token",
			},
		},
	);

	expect(await connector.validate(request)).toEqual({
		status: "ok",
		message: "oauth credentials valid",
	});

	await connector.sync(request);
	expect(persisted[0]?.bodyMd).toBe("oauth-body");
});

test("skips retrieval when candidate updatedAt matches stored record", async () => {
	const state = new MemoryStateStore();
	await state.upsertSourceRecord(
		createSourceRecord("page1", { snapshotHash: "hash-page1" }),
	);

	let retrieveCalls = 0;
	let persistCalls = 0;
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
			},
			async retrievePage(): Promise<NotionPage> {
				retrieveCalls += 1;
				throw new Error("retrievePage should not be called");
			},
			async retrievePageMarkdown(): Promise<string> {
				retrieveCalls += 1;
				throw new Error("retrievePageMarkdown should not be called");
			},
		}),
	});

	const request = createRequest(state, async () => {
		persistCalls += 1;
	});

	expect(await connector.validate(request)).toEqual({
		status: "ok",
		message: "token valid",
	});

	await connector.sync(request);

	expect(retrieveCalls).toBe(0);
	expect(persistCalls).toBe(0);
});

test("fetches changed pages and persists the refreshed snapshot", async () => {
	const state = new MemoryStateStore();
	const persisted: SourceSnapshot[] = [];
	let retrieveCalls = 0;
	const adapter = createAdapter({
		async listSharedPages(): Promise<NotionCandidatePage[]> {
			return [{ id: "page-1", lastEditedTime: "2026-03-17T00:00:00.000Z" }];
		},
		async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
			retrieveCalls += 1;
			return createPage(pageId, "2026-03-17T00:00:00.000Z", "Alpha");
		},
		async retrievePageMarkdown(): Promise<string> {
			return "body";
		},
	});
	const connector = createNotionConnector({ adapter });

	await state.upsertSourceRecord(
		createSourceRecord("page1", {
			sourceHash: "old-hash",
			snapshotHash: "old-hash",
			sourceUpdatedAt: "2026-03-15T00:00:00.000Z",
		}),
	);

	await connector.sync(
		createRequest(state, async (source) => {
			persisted.push(source);
		}),
	);

	expect(retrieveCalls).toBe(1);
	expect(persisted.length).toBe(1);
	expect(persisted[0]?.sourceHash).not.toBe("old-hash");
});

test("rebuilds from stored snapshot when render version changes", async () => {
	const state = new MemoryStateStore();
	await state.upsertSourceRecord(createSourceRecord("page1"));
	await state.upsertSourceSnapshot(createStoredSnapshot("page1"));

	let retrieveCalls = 0;
	let persistedBodyMd = "";
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
			},
			async retrievePage(): Promise<NotionPage> {
				retrieveCalls += 1;
				throw new Error("retrievePage should not be called");
			},
			async retrievePageMarkdown(): Promise<string> {
				retrieveCalls += 1;
				throw new Error("retrievePageMarkdown should not be called");
			},
		}),
	});

	await connector.sync({
		...createRequest(state, async (source) => {
			persistedBodyMd = source.bodyMd;
		}),
		renderVersion: "renderer-v2",
	});

	expect(retrieveCalls).toBe(0);
	expect(persistedBodyMd).toBe("body");
});

test("refetches page when stored snapshot schema version is outdated", async () => {
	const state = new MemoryStateStore();
	await state.upsertSourceRecord(createSourceRecord("page1"));
	await state.upsertSourceSnapshot(
		createStoredSnapshot("page1", {
			snapshotSchemaVersion: "0",
			payload: {
				integrationId: NOTION_INTEGRATION_ID,
				connectorId: "notion",
				sourceId: "page1",
				entityType: "page",
				title: "Alpha",
				slug: "",
				pathHint: { kind: "page" },
				metadata: {
					archived: false,
					updatedAt: "2026-03-16T00:00:00.000Z",
				},
				bodyMd: "stale-body",
				sourceHash: "hash-page1",
				snapshotSchemaVersion: "0",
			},
		}),
	);

	let retrieveCalls = 0;
	let persistedBodyMd = "";
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
			},
			async retrievePage(): Promise<NotionPage> {
				retrieveCalls += 1;
				return createPage("page-1", "2026-03-16T00:00:00.000Z", "Alpha");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "fresh-body";
			},
		}),
	});

	await connector.sync({
		...createRequest(state, async (source) => {
			persistedBodyMd = source.bodyMd;
		}),
		renderVersion: "renderer-v2",
	});

	expect(retrieveCalls).toBe(1);
	expect(persistedBodyMd).toBe("fresh-body");
});

test("persists discovered pages before querying later data sources", async () => {
	const state = new MemoryStateStore();
	const persisted: string[] = [];
	let secondQuerySawPersistedPage = false;
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedDataSources(): Promise<NotionDataSource[]> {
				return [
					{ id: "ds-1", name: "First" },
					{ id: "ds-2", name: "Second" },
				];
			},
			async listDataSourcePages(
				_token: string,
				dataSourceId: string,
				_since: string | null,
			): Promise<NotionCandidatePage[]> {
				if (dataSourceId === "ds-1") {
					return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
				}

				secondQuerySawPersistedPage = persisted.includes("page1");
				return [];
			},
			async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
				return createPage(pageId, "2026-03-16T00:00:00.000Z");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "body";
			},
		}),
	});

	await connector.sync(
		createRequest(state, async (source) => {
			persisted.push(source.sourceId);
		}),
	);

	expect(secondQuerySawPersistedPage).toBe(true);
	expect(persisted).toEqual(["page1"]);
});

test("sync publishes discovery and determinate page progress", async () => {
	const state = new MemoryStateStore();
	const progressUpdates: Array<IntegrationRuntimeProgress | null> = [];
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
			},
			async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
				return createPage(pageId, "2026-03-16T00:00:00.000Z");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "body";
			},
		}),
	});

	await connector.sync(
		createRequest(
			state,
			async () => {},
			{ write() {}, error() {} },
			{
				setProgress(progress) {
					progressUpdates.push(progress ? { ...progress } : null);
				},
			},
		),
	);

	expect(progressUpdates[0]).toEqual({
		mode: "indeterminate",
		phase: "Discovering workspace",
		detail: "Listing shared pages and data sources",
		completed: null,
		total: null,
		unit: "pages",
	});
	expect(progressUpdates).toContainEqual({
		mode: "determinate",
		phase: "Syncing pages",
		detail: "saved 1 | skipped 0 | failed 0",
		completed: 1,
		total: 1,
		unit: "pages",
	});
});

test("queries data source pages without a filter on the first sync", async () => {
	const state = new MemoryStateStore();
	const sinceValues: Array<string | null> = [];
	const persisted: string[] = [];
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedDataSources(): Promise<NotionDataSource[]> {
				return [{ id: "ds-1", name: "First" }];
			},
			async listDataSourcePages(
				_token: string,
				_dataSourceId: string,
				since: string | null,
			): Promise<NotionCandidatePage[]> {
				sinceValues.push(since);
				return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
			},
			async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
				return createPage(pageId, "2026-03-16T00:00:00.000Z");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "body";
			},
		}),
	});

	await connector.sync(
		createRequest(state, async (source) => {
			persisted.push(source.sourceId);
		}),
	);

	expect(sinceValues).toEqual([null]);
	expect(persisted).toEqual(["page1"]);
});

test("passes the sync cursor to incremental data source queries", async () => {
	const state = new MemoryStateStore();
	const sinceValues: Array<string | null> = [];
	const persisted: string[] = [];
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedDataSources(): Promise<NotionDataSource[]> {
				return [{ id: "ds-1", name: "First" }];
			},
			async listDataSourcePages(
				_token: string,
				_dataSourceId: string,
				since: string | null,
			): Promise<NotionCandidatePage[]> {
				sinceValues.push(since);
				return [{ id: "page-2", lastEditedTime: "2026-03-17T00:00:00.000Z" }];
			},
			async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
				return createPage(pageId, "2026-03-17T00:00:00.000Z");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "body";
			},
		}),
	});

	await connector.sync({
		...createRequest(state, async (source) => {
			persisted.push(source.sourceId);
		}),
		since: "2026-03-16T12:00:00.000Z",
	});

	expect(sinceValues).toEqual([null, "2026-03-16T12:00:00.000Z"]);
	expect(persisted).toEqual(["page2"]);
});

test("deduplicates pages returned by shared pages and incremental data source queries", async () => {
	const state = new MemoryStateStore();
	const persisted: string[] = [];
	let retrieveCalls = 0;
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-17T00:00:00.000Z" }];
			},
			async listSharedDataSources(): Promise<NotionDataSource[]> {
				return [{ id: "ds-1", name: "First" }];
			},
			async listDataSourcePages(): Promise<NotionCandidatePage[]> {
				return [{ id: "page-1", lastEditedTime: "2026-03-17T00:00:00.000Z" }];
			},
			async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
				retrieveCalls += 1;
				return createPage(pageId, "2026-03-17T00:00:00.000Z");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "body";
			},
		}),
	});

	await connector.sync({
		...createRequest(state, async (source) => {
			persisted.push(source.sourceId);
		}),
		since: "2026-03-16T12:00:00.000Z",
	});

	expect(retrieveCalls).toBe(1);
	expect(persisted).toEqual(["page1"]);
});

test("deletes stale records that are no longer present in Notion", async () => {
	const state = new MemoryStateStore();
	const deleted: string[] = [];
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedDataSources(): Promise<NotionDataSource[]> {
				return [{ id: "ds-1", name: "First" }];
			},
			async listDataSourcePages(
				_token: string,
				_dataSourceId: string,
				since: string | null,
			): Promise<NotionCandidatePage[]> {
				if (since === null) {
					return [{ id: "page-1", lastEditedTime: "2026-03-16T00:00:00.000Z" }];
				}

				return [];
			},
		}),
	});

	await state.upsertSourceRecord(createSourceRecord("page1"));
	await state.upsertSourceRecord(createSourceRecord("page2"));

	await connector.sync({
		...createRequest(state, async () => {}, { write() {}, error() {} }),
		since: "2026-03-16T12:00:00.000Z",
		deleteSource: async (sourceId) => {
			deleted.push(sourceId);
		},
	});

	expect(deleted).toEqual(["page2"]);
});

test("limits concurrent page fetches while persisting every changed candidate", async () => {
	const state = new MemoryStateStore();
	const persisted: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const connector = createNotionConnector({
		adapter: createAdapter({
			async listSharedPages(): Promise<NotionCandidatePage[]> {
				return Array.from({ length: 10 }, (_, index) => ({
					id: `page-${index + 1}`,
					lastEditedTime: `2026-03-16T00:00:${String(index).padStart(2, "0")}.000Z`,
				}));
			},
			async retrievePage(_token: string, pageId: string): Promise<NotionPage> {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 10));
				inFlight -= 1;
				return createPage(pageId, "2026-03-16T00:00:00.000Z");
			},
			async retrievePageMarkdown(): Promise<string> {
				return "body";
			},
		}),
	});

	await connector.sync(
		createRequest(state, async (source) => {
			persisted.push(source.sourceId);
		}),
	);

	expect(persisted.length).toBe(10);
	expect(maxInFlight <= 4).toBe(true);
});
