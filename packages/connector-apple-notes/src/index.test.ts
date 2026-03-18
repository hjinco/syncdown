import { expect, test } from "bun:test";

import type {
	ConnectorSyncRequest,
	SourceRecord,
	StoredSourceSnapshot,
} from "@syncdown/core";
import { MemoryStateStore } from "../../core/src/test-support.js";
import {
	APPLE_NOTES_ACCESS_ERROR,
	createAppleNotesConnector,
} from "./index.js";

function createRequest(
	options: {
		existingSourceIds?: string[];
	},
	overrides: Partial<ConnectorSyncRequest> = {},
): ConnectorSyncRequest {
	const state = new MemoryStateStore();
	for (const sourceId of options.existingSourceIds ?? []) {
		void state.upsertSourceRecord({
			integrationId: "apple-notes-integration",
			connectorId: "apple-notes",
			sourceId,
			entityType: "note",
			relativePath: `apple-notes/account/folder/${sourceId}.md`,
			sourceHash: `hash-${sourceId}`,
			renderVersion: "test",
			snapshotHash: `snapshot-${sourceId}`,
			lastRenderedAt: "2026-03-17T00:00:00.000Z",
		} satisfies SourceRecord);
		void state.upsertSourceSnapshot({
			integrationId: "apple-notes-integration",
			connectorId: "apple-notes",
			sourceId,
			snapshotHash: `snapshot-${sourceId}`,
			snapshotSchemaVersion: "1",
			payload: {
				integrationId: "apple-notes-integration",
				connectorId: "apple-notes",
				sourceId,
				entityType: "note",
				title: sourceId,
				slug: sourceId,
				pathHint: {
					kind: "note",
					appleNotesAccount: "Personal",
					appleNotesFolder: "Projects",
					appleNotesFolderPath: ["Projects"],
				},
				metadata: {},
				bodyMd: "",
				sourceHash: `hash-${sourceId}`,
				snapshotSchemaVersion: "1",
			},
		} satisfies StoredSourceSnapshot);
	}

	return {
		config: {
			oauthApps: [],
			connections: [
				{
					id: "apple-notes-local-default",
					kind: "apple-notes-local",
					label: "Default Apple Notes Connection",
				},
			],
			integrations: [
				{
					id: "apple-notes-integration",
					connectorId: "apple-notes",
					connectionId: "apple-notes-local-default",
					label: "Apple Notes",
					enabled: true,
					interval: "1h",
					config: {},
				},
			],
		},
		integration: {
			id: "apple-notes-integration",
			connectorId: "apple-notes",
			connectionId: "apple-notes-local-default",
			label: "Apple Notes",
			enabled: true,
			interval: "1h",
			config: {},
		},
		connection: {
			id: "apple-notes-local-default",
			kind: "apple-notes-local",
			label: "Default Apple Notes Connection",
		},
		io: { write() {}, error() {} },
		paths: {
			configDir: "/tmp/config",
			dataDir: "/tmp/data",
			configPath: "/tmp/config/config.json",
			statePath: "/tmp/data/state.db",
			secretsPath: "/tmp/data/secrets.enc",
			masterKeyPath: "/tmp/data/master.key",
			lockPath: "/tmp/data/sync.lock",
		},
		since: null,
		renderVersion: "test",
		secrets: {
			async hasSecret() {
				return false;
			},
			async getSecret() {
				return null;
			},
			async setSecret() {},
			async deleteSecret() {},
			describe() {
				return "memory";
			},
		},
		state,
		resolvedAuth: null,
		throwIfCancelled() {},
		async persistSource() {},
		async deleteSource() {},
		async resetIntegrationState() {},
		setProgress() {},
		...overrides,
	};
}

test("validate returns an error on non-macOS", async () => {
	const connector = createAppleNotesConnector({
		platform: "linux",
		adapter: {
			async validateAccess() {},
			async listNotes() {
				return { notes: [], warnings: [] };
			},
		},
	});

	const result = await connector.validate(createRequest({}));
	expect(result.status).toBe("error");
	expect(result.message).toContain("macOS");
});

test("validate returns permission guidance when local access is unavailable", async () => {
	const connector = createAppleNotesConnector({
		platform: "darwin",
		adapter: {
			async validateAccess() {
				throw new Error(APPLE_NOTES_ACCESS_ERROR);
			},
			async listNotes() {
				return { notes: [], warnings: [] };
			},
		},
	});

	const result = await connector.validate(createRequest({}));
	expect(result.status).toBe("error");
	expect(result.message).toBe(APPLE_NOTES_ACCESS_ERROR);
});

test("sync persists notes and removes missing records", async () => {
	const connector = createAppleNotesConnector({
		platform: "darwin",
		adapter: {
			async validateAccess() {},
			async listNotes() {
				return {
					notes: [
						{
							id: "raw-note-1",
							title: "Roadmap",
							body: "Body",
							account: "iCloud",
							folderPath: ["Projects", "Planning"],
							createdAt: "2026-03-16T00:00:00.000Z",
							updatedAt: "2026-03-17T00:00:00.000Z",
						},
					],
					warnings: [],
				};
			},
		},
	});
	const persisted: Array<{
		sourceId: string;
		account?: string;
		folder?: string;
		folderPath?: string[];
		hasPinnedMetadata?: boolean;
		hasLockedMetadata?: boolean;
	}> = [];
	const deleted: string[] = [];
	const request = createRequest(
		{
			existingSourceIds: ["obsolete-note"],
		},
		{
			async persistSource(source) {
				persisted.push({
					sourceId: source.sourceId,
					account: source.pathHint.appleNotesAccount,
					folder: source.metadata.appleNotesFolder as string | undefined,
					folderPath: source.pathHint.appleNotesFolderPath,
					hasPinnedMetadata: "appleNotesPinned" in source.metadata,
					hasLockedMetadata: "appleNotesLocked" in source.metadata,
				});
			},
			async deleteSource(sourceId) {
				deleted.push(sourceId);
			},
		},
	);

	const result = await connector.sync(request);
	expect(result.nextCursor).toBeNull();
	expect(persisted).toHaveLength(1);
	expect(persisted[0]?.account).toBe("iCloud");
	expect(persisted[0]?.folder).toBe("Planning");
	expect(persisted[0]?.folderPath).toEqual(["Projects", "Planning"]);
	expect(persisted[0]?.hasPinnedMetadata).toBe(false);
	expect(persisted[0]?.hasLockedMetadata).toBe(false);
	expect(deleted).toEqual(["obsolete-note"]);
});

test("sync skips locked notes and surfaces warnings without failing", async () => {
	const writes: string[] = [];
	const connector = createAppleNotesConnector({
		platform: "darwin",
		adapter: {
			async validateAccess() {},
			async listNotes() {
				return {
					notes: [
						{
							id: "locked-note",
							title: "Locked",
							body: "",
							account: "iCloud",
							folderPath: ["Secure"],
							locked: true,
						},
					],
					warnings: [{ noteId: "failed-note", message: "permission denied" }],
				};
			},
		},
	});
	const persisted: string[] = [];

	await connector.sync(
		createRequest(
			{},
			{
				io: {
					write(line) {
						writes.push(line);
					},
					error(line) {
						writes.push(`ERR:${line}`);
					},
				},
				async persistSource(source) {
					persisted.push(source.sourceId);
				},
			},
		),
	);

	expect(persisted).toEqual([]);
	expect(writes.join("\n")).toContain("failed-note");
	expect(writes.join("\n")).toContain("locked-note");
});

test("sync uses fallback account and folder buckets when missing", async () => {
	const connector = createAppleNotesConnector({
		platform: "darwin",
		adapter: {
			async validateAccess() {},
			async listNotes() {
				return {
					notes: [
						{
							id: "raw-note-2",
							title: "",
							body: "<p>Hello</p>",
							account: "",
							folderPath: [],
						},
					],
					warnings: [],
				};
			},
		},
	});
	let persistedAccount: string | undefined;
	let persistedFolder: string | undefined;
	let persistedFolderPath: string[] | undefined;

	await connector.sync(
		createRequest(
			{},
			{
				async persistSource(source) {
					persistedAccount = source.pathHint.appleNotesAccount;
					persistedFolder = source.metadata.appleNotesFolder as
						| string
						| undefined;
					persistedFolderPath = source.pathHint.appleNotesFolderPath;
				},
			},
		),
	);

	expect(persistedAccount).toBe("unknown-account");
	expect(persistedFolder).toBe("root");
	expect(persistedFolderPath).toEqual(["root"]);
});
