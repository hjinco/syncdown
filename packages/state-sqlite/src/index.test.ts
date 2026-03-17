import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SourceRecord, SourceSnapshot } from "@syncdown/core";
import { createStateStore } from "./index.js";

const NOTION_INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const GMAIL_INTEGRATION_ID = "22222222-2222-4222-8222-222222222222";

function createSnapshot(sourceId: string): SourceSnapshot {
	return {
		integrationId: NOTION_INTEGRATION_ID,
		connectorId: "notion",
		sourceId,
		entityType: "page",
		title: `Title ${sourceId}`,
		slug: sourceId,
		pathHint: { kind: "page" },
		metadata: {
			updatedAt: "2026-03-16T00:00:00.000Z",
		},
		bodyMd: `Body ${sourceId}`,
		sourceHash: `hash-${sourceId}`,
		snapshotSchemaVersion: "1",
	};
}

async function createStateEnvironment(): Promise<{
	cleanup: () => Promise<void>;
	root: string;
	statePath: string;
}> {
	const root = await mkdtemp(
		path.join(resolveTempDirectory(), "syncdown-state-sqlite-"),
	);
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.XDG_DATA_HOME = path.join(root, "data");

	return {
		async cleanup() {
			delete process.env.XDG_CONFIG_HOME;
			delete process.env.XDG_DATA_HOME;
			await rm(root, { recursive: true, force: true });
		},
		root,
		statePath: path.join(root, "data", "syncdown", "state.db"),
	};
}

function resolveTempDirectory(): string {
	return (
		Bun.env.TMPDIR ??
		Bun.env.TMP ??
		Bun.env.TEMP ??
		(process.platform === "win32"
			? Bun.env.LOCALAPPDATA
				? path.join(Bun.env.LOCALAPPDATA, "Temp")
				: undefined
			: undefined) ??
		"/tmp"
	);
}

test("bootstraps migrations and persists state across store instances", async () => {
	const { cleanup, statePath } = await createStateEnvironment();

	try {
		const store = createStateStore();
		const snapshot = createSnapshot("page-1");

		await store.setCursor(NOTION_INTEGRATION_ID, "cursor-1");
		await store.setLastSyncAt(
			NOTION_INTEGRATION_ID,
			"2026-03-16T10:00:00.000Z",
		);
		await store.upsertSourceRecord({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: snapshot.sourceId,
			entityType: snapshot.entityType,
			relativePath: `notion/${NOTION_INTEGRATION_ID}/pages/page-1.md`,
			sourceHash: snapshot.sourceHash,
			renderVersion: "renderer-v1",
			snapshotHash: snapshot.sourceHash,
			sourceUpdatedAt: "2026-03-16T10:00:00.000Z",
			lastRenderedAt: "2026-03-16T10:00:01.000Z",
		});
		await store.upsertSourceSnapshot({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: snapshot.sourceId,
			snapshotHash: snapshot.sourceHash,
			snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
			payload: snapshot,
		});

		const description = await store.describe();

		expect(existsSync(statePath)).toBe(true);
		expect(description).toEqual([
			"sqlite-backed state store (drizzle SQL migrations)",
			"tracked_documents=1",
			"tracked_snapshots=1",
			"tracked_integrations=1",
			"applied_migrations=1",
		]);

		const reopened = createStateStore();
		expect(await reopened.getCursor(NOTION_INTEGRATION_ID)).toBe("cursor-1");
		expect(await reopened.getLastSyncAt(NOTION_INTEGRATION_ID)).toBe(
			"2026-03-16T10:00:00.000Z",
		);
		expect(
			await reopened.getSourceRecord(NOTION_INTEGRATION_ID, "page-1"),
		).toEqual({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: "page-1",
			entityType: "page",
			relativePath: `notion/${NOTION_INTEGRATION_ID}/pages/page-1.md`,
			sourceHash: "hash-page-1",
			renderVersion: "renderer-v1",
			snapshotHash: "hash-page-1",
			sourceUpdatedAt: "2026-03-16T10:00:00.000Z",
			lastRenderedAt: "2026-03-16T10:00:01.000Z",
		});
		expect(
			await reopened.getSourceSnapshot(NOTION_INTEGRATION_ID, "page-1"),
		).toEqual({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: "page-1",
			snapshotHash: "hash-page-1",
			snapshotSchemaVersion: "1",
			payload: snapshot,
		});
	} finally {
		await cleanup();
	}
});

test("renames legacy json state files before creating a new sqlite database", async () => {
	const { cleanup, statePath } = await createStateEnvironment();

	try {
		await mkdir(path.dirname(statePath), { recursive: true });
		await writeFile(statePath, JSON.stringify({ legacy: true }), "utf8");

		const store = createStateStore();
		const description = await store.describe();

		expect(existsSync(`${statePath}.legacy.json`)).toBe(true);
		expect(await readFile(`${statePath}.legacy.json`, "utf8")).toBe(
			'{"legacy":true}',
		);
		expect(description).toEqual([
			"sqlite-backed state store (drizzle SQL migrations)",
			"tracked_documents=0",
			"tracked_snapshots=0",
			"tracked_integrations=0",
			"applied_migrations=1",
		]);
	} finally {
		await cleanup();
	}
});

test("deletes persisted source records and snapshots", async () => {
	const { cleanup } = await createStateEnvironment();

	try {
		const store = createStateStore();
		const snapshot = createSnapshot("page-2");

		await store.upsertSourceRecord({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: snapshot.sourceId,
			entityType: snapshot.entityType,
			relativePath: `notion/${NOTION_INTEGRATION_ID}/pages/page-2.md`,
			sourceHash: snapshot.sourceHash,
			renderVersion: "renderer-v1",
			snapshotHash: snapshot.sourceHash,
			sourceUpdatedAt: "2026-03-16T10:00:00.000Z",
			lastRenderedAt: "2026-03-16T10:00:01.000Z",
		});
		await store.upsertSourceSnapshot({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: snapshot.sourceId,
			snapshotHash: snapshot.sourceHash,
			snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
			payload: snapshot,
		});

		await store.deleteSourceSnapshot(NOTION_INTEGRATION_ID, "page-2");
		await store.deleteSourceRecord(NOTION_INTEGRATION_ID, "page-2");

		expect(
			await store.getSourceRecord(NOTION_INTEGRATION_ID, "page-2"),
		).toBeNull();
		expect(
			await store.getSourceSnapshot(NOTION_INTEGRATION_ID, "page-2"),
		).toBeNull();
	} finally {
		await cleanup();
	}
});

test("lists persisted source records for a single integration", async () => {
	const { cleanup } = await createStateEnvironment();

	try {
		const store = createStateStore() as ReturnType<typeof createStateStore> & {
			listSourceRecords(integrationId: string): Promise<SourceRecord[]>;
		};

		await store.upsertSourceRecord({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: "page-a",
			entityType: "page",
			relativePath: `notion/${NOTION_INTEGRATION_ID}/pages/page-a.md`,
			sourceHash: "hash-page-a",
			renderVersion: "renderer-v1",
			snapshotHash: "hash-page-a",
			sourceUpdatedAt: "2026-03-16T10:00:00.000Z",
			lastRenderedAt: "2026-03-16T10:00:01.000Z",
		});
		await store.upsertSourceRecord({
			integrationId: GMAIL_INTEGRATION_ID,
			connectorId: "gmail",
			sourceId: "message-b",
			entityType: "message",
			relativePath: `gmail/${GMAIL_INTEGRATION_ID}/messages/2026/03/message-b.md`,
			sourceHash: "hash-message-b",
			renderVersion: "renderer-v1",
			snapshotHash: "hash-message-b",
			sourceUpdatedAt: "2026-03-16T11:00:00.000Z",
			lastRenderedAt: "2026-03-16T11:00:01.000Z",
		});

		expect(await store.listSourceRecords(NOTION_INTEGRATION_ID)).toEqual([
			{
				integrationId: NOTION_INTEGRATION_ID,
				connectorId: "notion",
				sourceId: "page-a",
				entityType: "page",
				relativePath: `notion/${NOTION_INTEGRATION_ID}/pages/page-a.md`,
				sourceHash: "hash-page-a",
				renderVersion: "renderer-v1",
				snapshotHash: "hash-page-a",
				sourceUpdatedAt: "2026-03-16T10:00:00.000Z",
				lastRenderedAt: "2026-03-16T10:00:01.000Z",
			},
		]);
	} finally {
		await cleanup();
	}
});

test("resets one integration without touching another", async () => {
	const { cleanup } = await createStateEnvironment();

	try {
		const store = createStateStore();
		const notionSnapshot = createSnapshot("page-reset");
		const gmailSnapshot: SourceSnapshot = {
			...createSnapshot("message-keep"),
			integrationId: GMAIL_INTEGRATION_ID,
			connectorId: "gmail",
			entityType: "message",
		};

		await store.setCursor(NOTION_INTEGRATION_ID, "cursor-reset");
		await store.setLastSyncAt(
			NOTION_INTEGRATION_ID,
			"2026-03-16T10:00:00.000Z",
		);
		await store.upsertSourceRecord({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: notionSnapshot.sourceId,
			entityType: notionSnapshot.entityType,
			relativePath: `notion/${NOTION_INTEGRATION_ID}/pages/page-reset.md`,
			sourceHash: notionSnapshot.sourceHash,
			renderVersion: "renderer-v1",
			snapshotHash: notionSnapshot.sourceHash,
			sourceUpdatedAt: "2026-03-16T10:00:00.000Z",
			lastRenderedAt: "2026-03-16T10:00:01.000Z",
		});
		await store.upsertSourceSnapshot({
			integrationId: NOTION_INTEGRATION_ID,
			connectorId: "notion",
			sourceId: notionSnapshot.sourceId,
			snapshotHash: notionSnapshot.sourceHash,
			snapshotSchemaVersion: notionSnapshot.snapshotSchemaVersion,
			payload: notionSnapshot,
		});

		await store.setCursor(GMAIL_INTEGRATION_ID, "cursor-keep");
		await store.setLastSyncAt(GMAIL_INTEGRATION_ID, "2026-03-16T11:00:00.000Z");
		await store.upsertSourceRecord({
			integrationId: GMAIL_INTEGRATION_ID,
			connectorId: "gmail",
			sourceId: gmailSnapshot.sourceId,
			entityType: gmailSnapshot.entityType,
			relativePath: `gmail/${GMAIL_INTEGRATION_ID}/messages/2026/03/message-keep.md`,
			sourceHash: gmailSnapshot.sourceHash,
			renderVersion: "renderer-v1",
			snapshotHash: gmailSnapshot.sourceHash,
			sourceUpdatedAt: "2026-03-16T11:00:00.000Z",
			lastRenderedAt: "2026-03-16T11:00:01.000Z",
		});
		await store.upsertSourceSnapshot({
			integrationId: GMAIL_INTEGRATION_ID,
			connectorId: "gmail",
			sourceId: gmailSnapshot.sourceId,
			snapshotHash: gmailSnapshot.sourceHash,
			snapshotSchemaVersion: gmailSnapshot.snapshotSchemaVersion,
			payload: gmailSnapshot,
		});

		const deletedRecords = await store.resetIntegration(NOTION_INTEGRATION_ID);

		expect(deletedRecords).toHaveLength(1);
		expect(deletedRecords[0]?.relativePath).toBe(
			`notion/${NOTION_INTEGRATION_ID}/pages/page-reset.md`,
		);
		expect(await store.getCursor(NOTION_INTEGRATION_ID)).toBeNull();
		expect(await store.getLastSyncAt(NOTION_INTEGRATION_ID)).toBeNull();
		expect(
			await store.getSourceRecord(NOTION_INTEGRATION_ID, "page-reset"),
		).toBeNull();
		expect(
			await store.getSourceSnapshot(NOTION_INTEGRATION_ID, "page-reset"),
		).toBeNull();

		expect(await store.getCursor(GMAIL_INTEGRATION_ID)).toBe("cursor-keep");
		expect(await store.getLastSyncAt(GMAIL_INTEGRATION_ID)).toBe(
			"2026-03-16T11:00:00.000Z",
		);
		expect(
			await store.getSourceRecord(GMAIL_INTEGRATION_ID, "message-keep"),
		).not.toBeNull();
		expect(
			await store.getSourceSnapshot(GMAIL_INTEGRATION_ID, "message-keep"),
		).not.toBeNull();
	} finally {
		await cleanup();
	}
});
