import { expect, test } from "bun:test";

import { createSyncdownApp } from "./app.js";
import { ensureConfig, writeConfig } from "./config.js";
import { getDefaultIntegration } from "./config-model.js";
import {
	createConnector,
	createIo,
	createSource,
	createTestPaths,
	createTestRuntime,
	MemoryStateStore,
	StaticSecretsStore,
	TestRenderer,
	TestSink,
} from "./test-support.js";
import type {
	IntegrationRuntimeProgress,
	SyncRuntimeSnapshot,
} from "./types.js";
import { EXIT_CODES } from "./types.js";

const RUNNING_PROGRESS: IntegrationRuntimeProgress = {
	mode: "determinate",
	phase: "Syncing pages",
	detail: "saved 0 | skipped 0 | failed 0",
	completed: 0,
	total: 1,
	unit: "pages",
};

test("session snapshots clone structured progress and clear it after a successful run", async () => {
	const { cleanup, notionIntegrationId } = await createTestPaths();

	try {
		const runtime = createTestRuntime();
		let releaseSync = () => {};
		let resolveProgressSeen = () => {};
		const progressSeen = new Promise<void>((resolve) => {
			resolveProgressSeen = resolve;
		});
		const snapshots: SyncRuntimeSnapshot[] = [];
		const app = createSyncdownApp(
			{
				connectors: [
					createConnector("notion", async (request) => {
						request.setProgress(RUNNING_PROGRESS);
						resolveProgressSeen();
						await new Promise<void>((resolve) => {
							releaseSync = resolve;
						});
						await request.persistSource(createSource("page-1"));
						return {
							nextCursor: "notion-cursor",
						};
					}),
				],
				renderer: new TestRenderer(),
				sink: new TestSink(),
				state: new MemoryStateStore(),
				secrets: new StaticSecretsStore(),
			},
			runtime.runtime,
		);

		const session = await app.openSession(createIo());
		const unsubscribe = session.subscribe((event) => {
			snapshots.push(event.snapshot);
		});

		const runPromise = session.runNow({
			kind: "integration",
			integrationId: notionIntegrationId,
		});
		await progressSeen;

		expect(session.getSnapshot().integrations[0]?.progress).toEqual(
			RUNNING_PROGRESS,
		);
		const exposedSnapshot = session.getSnapshot();
		if (!exposedSnapshot.integrations[0]) {
			throw new Error("expected notion integration snapshot");
		}
		exposedSnapshot.integrations[0].progress = null;
		expect(session.getSnapshot().integrations[0]?.progress).toEqual(
			RUNNING_PROGRESS,
		);

		releaseSync();
		await runPromise;

		expect(
			snapshots.some(
				(snapshot) =>
					snapshot.integrations[0]?.progress?.phase === "Syncing pages",
			),
		).toBe(true);
		expect(session.getSnapshot().integrations[0]?.progress).toBeNull();

		unsubscribe();
		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("cancelling an active run clears structured progress", async () => {
	const { cleanup, notionIntegrationId } = await createTestPaths();

	try {
		const runtime = createTestRuntime();
		let releaseSync = () => {};
		let resolveProgressSeen = () => {};
		const progressSeen = new Promise<void>((resolve) => {
			resolveProgressSeen = resolve;
		});
		const app = createSyncdownApp(
			{
				connectors: [
					createConnector("notion", async (request) => {
						request.setProgress({
							mode: "indeterminate",
							phase: "Discovering workspace",
							detail: "Listing shared pages and data sources",
							completed: null,
							total: null,
							unit: "pages",
						});
						resolveProgressSeen();
						await new Promise<void>((resolve) => {
							releaseSync = resolve;
						});
						request.throwIfCancelled();
						return {
							nextCursor: "notion-cursor",
						};
					}),
				],
				renderer: new TestRenderer(),
				sink: new TestSink(),
				state: new MemoryStateStore(),
				secrets: new StaticSecretsStore(),
			},
			runtime.runtime,
		);

		const session = await app.openSession(createIo());
		const runPromise = session.runNow({
			kind: "integration",
			integrationId: notionIntegrationId,
		});
		await progressSeen;

		await session.cancelActiveRun();
		releaseSync();
		await runPromise;

		const snapshot = session.getSnapshot();
		expect(snapshot.lastRunExitCode).toBe(EXIT_CODES.GENERAL_ERROR);
		expect(snapshot.integrations[0]?.progress).toBeNull();

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("session tracks integrations added or replaced after it opens", async () => {
	const { cleanup, paths } = await createTestPaths();

	try {
		const runtime = createTestRuntime();
		const app = createSyncdownApp(
			{
				connectors: [
					createConnector("google-calendar", async (request) => {
						await request.persistSource(createSource("calendar-event-1"));
						return {
							nextCursor: "calendar-cursor",
						};
					}),
				],
				renderer: new TestRenderer(),
				sink: new TestSink(),
				state: new MemoryStateStore(),
				secrets: new StaticSecretsStore(),
			},
			runtime.runtime,
		);

		const session = await app.openSession(createIo());
		const initialConfig = await ensureConfig(paths);
		const originalGoogleCalendarId = getDefaultIntegration(
			initialConfig,
			"google-calendar",
		).id;
		const updatedConfig = structuredClone(initialConfig);
		const googleCalendar = getDefaultIntegration(
			updatedConfig,
			"google-calendar",
		);
		if (googleCalendar.connectorId !== "google-calendar") {
			throw new Error("expected google calendar integration");
		}
		googleCalendar.id = "google-calendar-relinked";
		googleCalendar.enabled = true;
		googleCalendar.config.selectedCalendarIds = ["primary"];
		await writeConfig(paths, updatedConfig);

		await session.runNow({
			kind: "integration",
			integrationId: googleCalendar.id,
		});

		const integrationIds = session
			.getSnapshot()
			.integrations.map((integration) => integration.id);
		expect(integrationIds).toContain(googleCalendar.id);
		expect(integrationIds).not.toContain(originalGoogleCalendarId);

		await session.dispose();
	} finally {
		await cleanup();
	}
});
