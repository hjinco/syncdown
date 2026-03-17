import { expect, test } from "bun:test";

import type {
	AppIo,
	AppPaths,
	ConnectorSyncRequest,
	GoogleResolvedAuth,
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
	createGmailConnector,
	extractMessageBody,
	type GmailAdapter,
	type GmailHistoryResult,
	type GmailMessage,
	type GmailProfile,
	stripHtml,
} from "./index.js";

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

class MemorySecretsStore implements SecretsStore {
	constructor(private readonly secrets = new Map<string, string>()) {}

	async hasSecret(name: string): Promise<boolean> {
		return this.secrets.has(name);
	}

	async getSecret(name: string): Promise<string | null> {
		return this.secrets.get(name) ?? null;
	}

	async setSecret(name: string, value: string): Promise<void> {
		this.secrets.set(name, value);
	}

	async deleteSecret(name: string): Promise<void> {
		this.secrets.delete(name);
	}

	describe(): string {
		return "memory";
	}
}

function createRequest(
	_adapter: GmailAdapter,
	options: {
		since?: string | null;
		syncFilter?: "primary" | "primary-important";
		secrets?: SecretsStore;
		resolvedAuth?: GoogleResolvedAuth | null;
		persistSource?: (source: SourceSnapshot) => Promise<void>;
		deleteSource?: (sourceId: string) => Promise<void>;
		resetIntegrationState?: () => Promise<void>;
		io?: AppIo;
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
	const integration = getDefaultIntegration(config, "gmail");
	if (integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	integration.enabled = true;
	integration.config.syncFilter = options.syncFilter ?? "primary";
	const connection = getDefaultConnection(config, "gmail");

	return {
		config,
		integration,
		connection,
		io: options.io ?? { write() {}, error() {} },
		paths,
		since: options.since ?? null,
		renderVersion: "renderer-v1",
		secrets:
			options.secrets ??
			new MemorySecretsStore(
				new Map([
					["oauthApps.google-default.clientId", "client-id"],
					["oauthApps.google-default.clientSecret", "client-secret"],
					["connections.google-account-default.refreshToken", "refresh-token"],
				]),
			),
		state: new MemoryStateStore(),
		throwIfCancelled() {},
		resolvedAuth:
			options.resolvedAuth !== undefined
				? options.resolvedAuth
				: {
						kind: "google-oauth",
						clientId: "client-id",
						clientSecret: "client-secret",
						refreshToken: "refresh-token",
						requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
					},
		persistSource: options.persistSource ?? (async () => {}),
		deleteSource: options.deleteSource ?? (async () => {}),
		resetIntegrationState: options.resetIntegrationState ?? (async () => {}),
		setProgress: options.setProgress ?? (() => {}),
	};
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function createMessage(
	messageId: string,
	overrides: Partial<GmailMessage> = {},
): GmailMessage {
	return {
		id: messageId,
		threadId: overrides.threadId ?? `thread-${messageId}`,
		historyId: overrides.historyId ?? "200",
		internalDate:
			overrides.internalDate ?? String(Date.parse("2026-03-16T12:34:56.000Z")),
		labelIds: overrides.labelIds ?? ["INBOX", "CATEGORY_PERSONAL", "UNREAD"],
		snippet: overrides.snippet ?? `snippet-${messageId}`,
		payload: overrides.payload ?? {
			headers: [
				{ name: "Subject", value: `Subject ${messageId}` },
				{ name: "From", value: "Sender <sender@example.com>" },
				{
					name: "To",
					value: "Alpha <alpha@example.com>, Beta <beta@example.com>",
				},
				{ name: "Cc", value: "Gamma <gamma@example.com>" },
				{ name: "Date", value: "Mon, 16 Mar 2026 12:34:56 +0000" },
			],
			parts: [
				{
					mimeType: "text/plain",
					body: { data: encode(`Body ${messageId}`) },
				},
			],
		},
	};
}

function createAdapter(overrides: Partial<GmailAdapter> = {}): GmailAdapter {
	return {
		async validate(): Promise<void> {},
		async getProfile(): Promise<GmailProfile> {
			return {
				historyId: "300",
				emailAddress: "owner@example.com",
			};
		},
		async listInboxMessageIds(): Promise<string[]> {
			return [];
		},
		async listHistory(): Promise<GmailHistoryResult> {
			return { history: [] };
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			return createMessage(messageId);
		},
		...overrides,
	};
}

test("validation fails when gmail secrets are incomplete", async () => {
	const connector = createGmailConnector({ adapter: createAdapter() });
	const request = createRequest(createAdapter(), {
		secrets: new MemorySecretsStore(),
		resolvedAuth: null,
	});

	expect(await connector.validate(request)).toEqual({
		status: "error",
		message: "credentials missing in encrypted store",
	});
});

test("default adapter validates credentials with fetch-based Gmail API calls", async () => {
	const originalFetch = globalThis.fetch;
	const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		fetchCalls.push({ url, init });
		if (url === "https://oauth2.googleapis.com/token") {
			return new Response(
				JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		}

		if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
			expect(init?.headers).toEqual({
				authorization: "Bearer access-token",
				accept: "application/json",
			});
			return new Response(JSON.stringify({ historyId: "300" }), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			});
		}

		if (
			url ===
			"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token"
		) {
			return new Response(
				JSON.stringify({
					scope: "https://www.googleapis.com/auth/gmail.readonly",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		}

		throw new Error(`unexpected url: ${url}`);
	}) as typeof fetch;

	try {
		const connector = createGmailConnector();
		await expect(
			connector.validate(createRequest(createAdapter())),
		).resolves.toEqual({
			status: "ok",
			message: "credentials valid",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(fetchCalls).toHaveLength(4);
	expect(fetchCalls[0]?.url).toBe("https://oauth2.googleapis.com/token");
	expect(fetchCalls[1]?.url).toBe(
		"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token",
	);
	expect(fetchCalls[2]?.url).toBe("https://oauth2.googleapis.com/token");
	expect(fetchCalls[3]?.url).toBe(
		"https://gmail.googleapis.com/gmail/v1/users/me/profile",
	);
});

test("initial inbox sync persists one snapshot per message and stores next history id", async () => {
	const persisted: SourceSnapshot[] = [];
	let requestedFilter: string | undefined;
	let requestedLimit: number | undefined;
	const writes: string[] = [];
	const connector = createGmailConnector({
		adapter: createAdapter({
			async listInboxMessageIds(
				_credentials,
				syncFilter,
				limit,
			): Promise<string[]> {
				requestedFilter = syncFilter;
				requestedLimit = limit;
				return ["m1", "m2"];
			},
		}),
	});

	const result = await connector.sync(
		createRequest(
			createAdapter({
				async listInboxMessageIds(
					_credentials,
					syncFilter,
					limit,
				): Promise<string[]> {
					requestedFilter = syncFilter;
					requestedLimit = limit;
					return ["m1", "m2"];
				},
			}),
			{
				io: {
					write(line) {
						writes.push(line);
					},
					error() {},
				},
				persistSource: async (source) => {
					persisted.push(source);
				},
			},
		),
	);

	expect(result.nextCursor).toBe(
		JSON.stringify({ historyId: "300", syncFilter: "primary" }),
	);
	expect(requestedFilter).toBe("primary");
	expect(requestedLimit).toBe(5000);
	expect(persisted.map((source) => source.sourceId)).toEqual(["m1", "m2"]);
	expect(persisted.map((source) => source.metadata.gmailAccountEmail)).toEqual([
		"owner@example.com",
		"owner@example.com",
	]);
	expect(persisted.map((source) => source.pathHint.gmailAccountEmail)).toEqual([
		"owner@example.com",
		"owner@example.com",
	]);
	expect(writes).toContain(
		"Gmail progress: streaming initial sync limit=5000 concurrency=10",
	);
});

test("gmail sync falls back to the configured connection email when profile email is missing", async () => {
	const persisted: SourceSnapshot[] = [];
	const adapter = createAdapter({
		async getProfile(): Promise<GmailProfile> {
			return { historyId: "300" };
		},
		async listInboxMessageIds(): Promise<string[]> {
			return ["m1"];
		},
	});
	const request = createRequest(adapter, {
		persistSource: async (source) => {
			persisted.push(source);
		},
	});
	if (request.connection.kind !== "google-account") {
		throw new Error("expected google account connection");
	}
	request.connection.accountEmail = "fallback@example.com";

	await createGmailConnector({ adapter }).sync(request);

	expect(persisted).toHaveLength(1);
	expect(persisted[0]?.metadata.gmailAccountEmail).toBe("fallback@example.com");
	expect(persisted[0]?.pathHint.gmailAccountEmail).toBe("fallback@example.com");
});

test("incremental history sync refetches only changed messages", async () => {
	const requested: string[] = [];
	const persisted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{
						messagesAdded: [{ message: { id: "m1" } }],
						labelsRemoved: [{ message: { id: "m2" } }],
					},
				],
			};
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			requested.push(messageId);
			return createMessage(messageId);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({ historyId: "250", syncFilter: "primary" }),
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
		}),
	);

	expect(requested).toEqual(["m1", "m2"]);
	expect(persisted).toEqual(["m1", "m2"]);
	expect(writes).toContain("Gmail progress: messages=2 concurrency=10");
});

test("incremental history sync publishes structured determinate progress", async () => {
	const progressUpdates: Array<IntegrationRuntimeProgress | null> = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{
						messagesAdded: [{ message: { id: "m1" } }],
						labelsRemoved: [{ message: { id: "m2" } }],
					},
				],
			};
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			return createMessage(messageId);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({ historyId: "250", syncFilter: "primary" }),
			setProgress(progress) {
				progressUpdates.push(progress ? { ...progress } : null);
			},
		}),
	);

	expect(progressUpdates).toContainEqual({
		mode: "indeterminate",
		phase: "Checking mailbox history",
		detail: null,
		completed: null,
		total: null,
		unit: "messages",
	});
	expect(progressUpdates).toContainEqual({
		mode: "determinate",
		phase: "Fetching changed messages",
		detail: "processed 2 of 2 | concurrency 10",
		completed: 2,
		total: 2,
		unit: "messages",
	});
});

test("initial inbox sync respects configured initial sync limit", async () => {
	let requestedFilter: string | undefined;
	let requestedLimit: number | undefined;
	const adapter = createAdapter({
		async listInboxMessageIds(
			_credentials,
			syncFilter,
			limit,
		): Promise<string[]> {
			requestedFilter = syncFilter;
			requestedLimit = limit;
			return ["m1"];
		},
	});
	const connector = createGmailConnector({ adapter });
	const request = createRequest(adapter);
	if (request.integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	request.integration.config.initialSyncLimit = 25;

	await connector.sync(request);

	expect(requestedFilter).toBe("primary");
	expect(requestedLimit).toBe(25);
});

test("initial inbox sync treats zero initial sync limit as unlimited", async () => {
	let requestedLimit: number | undefined = -1;
	const writes: string[] = [];
	const adapter = createAdapter({
		async listInboxMessageIds(
			_credentials,
			_syncFilter,
			limit,
		): Promise<string[]> {
			requestedLimit = limit;
			return ["m1"];
		},
	});
	const connector = createGmailConnector({ adapter });
	const request = createRequest(adapter, {
		io: {
			write(line) {
				writes.push(line);
			},
			error() {},
		},
	});
	if (request.integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	request.integration.config.initialSyncLimit = 0;

	await connector.sync(request);

	expect(requestedLimit).toBeUndefined();
	expect(writes).toContain(
		"Gmail progress: streaming initial sync limit=all concurrency=10",
	);
});

test("message fetches honor configured concurrency", async () => {
	let active = 0;
	let peak = 0;
	let releaseCurrentBatch!: () => void;
	let markSecondStart!: () => void;
	let currentBatch = new Promise<void>((resolve) => {
		releaseCurrentBatch = resolve;
	});
	const secondStart = new Promise<void>((resolve) => {
		markSecondStart = resolve;
	});

	const adapter = createAdapter({
		async listInboxMessageIds(): Promise<string[]> {
			return ["m1", "m2", "m3", "m4"];
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			active += 1;
			peak = Math.max(peak, active);
			if (active === 2) {
				markSecondStart();
			}
			await currentBatch;
			active -= 1;
			return createMessage(messageId);
		},
	});
	const connector = createGmailConnector({ adapter });
	const request = createRequest(adapter);
	if (request.integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	request.integration.config.fetchConcurrency = 2;

	const syncPromise = connector.sync(request);
	await secondStart;
	releaseCurrentBatch();
	currentBatch = Promise.resolve();
	await syncPromise;

	expect(peak).toBe(2);
});

test("initial inbox sync persists completed messages without waiting for slower fetches", async () => {
	const persisted: string[] = [];
	let releaseSlowFetch!: () => void;
	let markFastPersisted!: () => void;
	const slowFetch = new Promise<void>((resolve) => {
		releaseSlowFetch = resolve;
	});
	const fastPersisted = new Promise<void>((resolve) => {
		markFastPersisted = resolve;
	});

	const adapter = createAdapter({
		async *iterateInboxMessageIds(): AsyncIterable<string> {
			yield "m1";
			yield "m2";
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			if (messageId === "m2") {
				await slowFetch;
			}
			return createMessage(messageId);
		},
	});
	const connector = createGmailConnector({ adapter });
	const request = createRequest(adapter, {
		persistSource: async (source) => {
			persisted.push(source.sourceId);
			if (source.sourceId === "m1") {
				markFastPersisted();
			}
		},
	});
	if (request.integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	request.integration.config.fetchConcurrency = 2;

	let completed = false;
	const syncPromise = connector.sync(request).then(() => {
		completed = true;
	});

	await fastPersisted;
	expect(persisted).toEqual(["m1"]);
	expect(completed).toBe(false);

	releaseSlowFetch();
	await syncPromise;

	expect(persisted).toEqual(["m1", "m2"]);
	expect(completed).toBe(true);
});

test("default adapter stops paging once the initial sync limit is reached", async () => {
	const originalFetch = globalThis.fetch;
	const fetchCalls: string[] = [];

	globalThis.fetch = (async (input) => {
		const url = String(input);
		fetchCalls.push(url);

		if (url === "https://oauth2.googleapis.com/token") {
			return new Response(
				JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		}

		if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
			return new Response(JSON.stringify({ historyId: "300" }), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			});
		}

		if (
			url ===
			"https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&q=category%3Aprimary&maxResults=500"
		) {
			return new Response(
				JSON.stringify({
					messages: [{ id: "m1" }],
					nextPageToken: "page-2",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		}

		if (
			url ===
			"https://gmail.googleapis.com/gmail/v1/users/me/messages?pageToken=page-2&labelIds=INBOX&q=category%3Aprimary&maxResults=500"
		) {
			throw new Error("unexpected second page fetch");
		}

		if (
			url ===
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full"
		) {
			return new Response(JSON.stringify(createMessage("m1")), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			});
		}

		throw new Error(`unexpected url: ${url}`);
	}) as typeof fetch;

	try {
		const connector = createGmailConnector();
		const request = createRequest(createAdapter());
		if (request.integration.connectorId !== "gmail") {
			throw new Error("expected gmail integration");
		}
		request.integration.config.initialSyncLimit = 1;

		await connector.sync(request);
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(fetchCalls).toContain(
		"https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&q=category%3Aprimary&maxResults=500",
	);
	expect(
		fetchCalls.filter((url) =>
			url.startsWith(
				"https://gmail.googleapis.com/gmail/v1/users/me/messages?",
			),
		),
	).toHaveLength(1);
});

test("invalid history id falls back to a full scoped rescan", async () => {
	let historyCalls = 0;
	let inboxCalls = 0;
	const persisted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			historyCalls += 1;
			return { history: [], invalidCursor: true };
		},
		async listInboxMessageIds(): Promise<string[]> {
			inboxCalls += 1;
			return ["m3"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "stale-history",
				syncFilter: "primary",
			}),
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
		}),
	);

	expect(historyCalls).toBe(1);
	expect(inboxCalls).toBe(1);
	expect(persisted).toEqual(["m3"]);
	expect(writes).toContain(
		"Gmail history cursor expired. Falling back to a full scoped rescan.",
	);
	expect(writes).toContain(
		"Gmail progress: streaming initial sync limit=5000 concurrency=10",
	);
});

test("history fallback publishes structured scanning progress", async () => {
	const progressUpdates: Array<IntegrationRuntimeProgress | null> = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return { history: [], invalidCursor: true };
		},
		async listInboxMessageIds(): Promise<string[]> {
			return ["m3"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "stale-history",
				syncFilter: "primary",
			}),
			setProgress(progress) {
				progressUpdates.push(progress ? { ...progress } : null);
			},
		}),
	);

	expect(progressUpdates).toContainEqual({
		mode: "indeterminate",
		phase: "Checking mailbox history",
		detail: null,
		completed: null,
		total: null,
		unit: "messages",
	});
	expect(progressUpdates).toContainEqual({
		mode: "indeterminate",
		phase: "Scanning inbox",
		detail: "processed 1 | limit 5000 | concurrency 10",
		completed: null,
		total: null,
		unit: "messages",
	});
});

test("legacy gmail cursor resets integration state before a scoped resync", async () => {
	let historyCalls = 0;
	let inboxCalls = 0;
	let resetCalls = 0;
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			historyCalls += 1;
			return { history: [] };
		},
		async listInboxMessageIds(): Promise<string[]> {
			inboxCalls += 1;
			return ["m1"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: "legacy-history-id",
			resetIntegrationState: async () => {
				resetCalls += 1;
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(resetCalls).toBe(1);
	expect(historyCalls).toBe(0);
	expect(inboxCalls).toBe(1);
	expect(writes).toContain(
		"Gmail legacy cursor detected. Resetting integration state before the next scoped sync.",
	);
});

test("gmail sync filter changes reset integration state before a scoped resync", async () => {
	let historyCalls = 0;
	let inboxCalls = 0;
	let resetCalls = 0;
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			historyCalls += 1;
			return { history: [] };
		},
		async listInboxMessageIds(): Promise<string[]> {
			inboxCalls += 1;
			return ["m1"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary-important",
			}),
			syncFilter: "primary",
			resetIntegrationState: async () => {
				resetCalls += 1;
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(resetCalls).toBe(1);
	expect(historyCalls).toBe(0);
	expect(inboxCalls).toBe(1);
	expect(writes).toContain(
		"Gmail sync filter changed. Resetting integration state before the next scoped sync.",
	);
});

test("messages removed from the active filter delete local files instead of persisting archived state", async () => {
	const persisted: SourceSnapshot[] = [];
	const deleted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [{ labelsRemoved: [{ message: { id: "m4" } }] }],
			};
		},
		async getMessage(): Promise<GmailMessage | null> {
			return createMessage("m4", {
				labelIds: ["CATEGORY_UPDATES"],
			});
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({ historyId: "250", syncFilter: "primary" }),
			persistSource: async (source) => {
				persisted.push(source);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(persisted).toEqual([]);
	expect(deleted).toEqual(["m4"]);
	expect(writes).toContain(
		"Gmail message removed from the active primary filter during sync: m4",
	);
});

test("hard-deleted messages remove local files and do not fail sync", async () => {
	const writes: string[] = [];
	const deleted: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [{ messagesDeleted: [{ message: { id: "m5" } }] }],
			};
		},
		async getMessage(): Promise<GmailMessage | null> {
			return null;
		},
	});
	const connector = createGmailConnector({ adapter });

	const result = await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({ historyId: "250", syncFilter: "primary" }),
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(result.nextCursor).toBe(
		JSON.stringify({ historyId: "300", syncFilter: "primary" }),
	);
	expect(deleted).toEqual(["m5"]);
	expect(writes).toContain("Gmail message deleted during sync: m5");
});

test("primary-important sync only persists messages with the IMPORTANT label", async () => {
	const persisted: string[] = [];
	const deleted: string[] = [];
	let requestedFilter: string | undefined;
	const adapter = createAdapter({
		async listInboxMessageIds(_credentials, syncFilter): Promise<string[]> {
			requestedFilter = syncFilter;
			return ["m1", "m2"];
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			return messageId === "m1"
				? createMessage("m1", {
						labelIds: ["INBOX", "CATEGORY_PERSONAL", "IMPORTANT"],
					})
				: createMessage("m2", { labelIds: ["INBOX", "CATEGORY_PERSONAL"] });
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			syncFilter: "primary-important",
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
		}),
	);

	expect(requestedFilter).toBe("primary-important");
	expect(persisted).toEqual(["m1"]);
	expect(deleted).toEqual(["m2"]);
});

test("body extraction prefers text plain and falls back to stripped html", () => {
	expect(
		extractMessageBody(
			createMessage("m6", {
				payload: {
					headers: [],
					parts: [
						{ mimeType: "text/plain", body: { data: encode("Plain body") } },
						{
							mimeType: "text/html",
							body: { data: encode("<p>HTML body</p>") },
						},
					],
				},
			}),
		),
	).toBe("Plain body");

	expect(
		extractMessageBody(
			createMessage("m7", {
				payload: {
					headers: [],
					parts: [
						{
							mimeType: "text/html",
							body: { data: encode("<p>Hello <strong>world</strong></p>") },
						},
					],
				},
			}),
		),
	).toBe("Hello world");
});

test("html stripping handles common markup cleanup", () => {
	expect(stripHtml("<p>Hello<br>world</p><script>ignore()</script>")).toBe(
		"Hello\nworld",
	);
});
