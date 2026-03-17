import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { createSyncdownApp } from "./app.js";
import { writeConfig } from "./config.js";
import { getDefaultIntegration } from "./config-model.js";
import {
	createConnector,
	createIo,
	createIoCapture,
	createSource,
	createTestPaths,
	createTestRuntime,
	MemoryStateStore,
	StaticSecretsStore,
	TestRenderer,
	TestSink,
} from "./test-support.js";
import type { Connector, ConnectorSyncRequest } from "./types.js";
import { EXIT_CODES } from "./types.js";

const NOTION_SETUP_METHODS = [
	{
		kind: "token",
	},
	{
		kind: "provider-oauth",
		providerId: "notion",
		requiredScopes: [],
	},
] as const;

const GMAIL_SETUP_METHODS = [
	{
		kind: "provider-oauth",
		providerId: "google",
		requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
	},
] as const;

test("inspect and connector listing include notion and gmail", async () => {
	const { cleanup } = await createTestPaths();

	try {
		const writes: string[] = [];
		const app = createSyncdownApp({
			connectors: [createConnector("notion"), createConnector("gmail")],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state: new MemoryStateStore(),
			secrets: new StaticSecretsStore(),
		});

		const snapshot = await app.inspect();
		expect(snapshot.connectors.map((connector) => connector.id)).toEqual([
			"notion",
			"gmail",
		]);

		await app.listConnectors({
			write(line) {
				writes.push(line);
			},
			error() {},
		});

		expect(writes[0] ?? "").toMatch(
			/Notion \| connector=notion \| enabled=true \| interval=1h \| credentials=complete/,
		);
		expect(writes[1] ?? "").toMatch(
			/Gmail \| connector=gmail \| enabled=false \| interval=1h \| credentials=complete/,
		);
	} finally {
		await cleanup();
	}
});

test("run executes only enabled integrations and stores state per integration id", async () => {
	const { cleanup, paths, config, gmailIntegrationId, notionIntegrationId } =
		await createTestPaths();

	try {
		getDefaultIntegration(config, "gmail").enabled = true;
		await writeConfig(paths, config);

		const state = new MemoryStateStore();
		const ran: string[] = [];
		const app = createSyncdownApp({
			connectors: [
				createConnector("notion", async (request) => {
					ran.push("notion");
					await request.persistSource(createSource("page-enabled"));
					return {
						nextCursor: "notion-cursor",
					};
				}),
				createConnector("gmail", async (request) => {
					ran.push("gmail");
					await request.persistSource({
						...createSource("message-enabled"),
						integrationId: gmailIntegrationId,
						connectorId: "gmail",
					});
					return {
						nextCursor: "gmail-cursor",
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		});

		const exitCode = await app.run(createIo());

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(ran.sort()).toEqual(["gmail", "notion"]);
		expect(await state.getCursor(notionIntegrationId)).toBe("notion-cursor");
		expect(await state.getCursor(gmailIntegrationId)).toBe("gmail-cursor");
		expect(await state.getLastSyncAt(notionIntegrationId)).not.toBeNull();
		expect(await state.getLastSyncAt(gmailIntegrationId)).not.toBeNull();
	} finally {
		await cleanup();
	}
});

test("persists a document before connector completion and defers cursor updates", async () => {
	const { cleanup, config, notionIntegrationId } = await createTestPaths();

	try {
		const state = new MemoryStateStore();
		let fileSeenDuringSync = false;

		const connector: Connector = {
			id: "notion",
			label: "Notion",
			setupMethods: NOTION_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "token valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				await request.persistSource(createSource("page1"));
				await access(
					path.join(config.outputDir!, "notion", "pages", "page1.md"),
				);
				fileSeenDuringSync = true;
				expect(await state.getCursor(notionIntegrationId)).toBeNull();
				expect(await state.getLastSyncAt(notionIntegrationId)).toBeNull();
				expect(
					(await state.getSourceRecord(notionIntegrationId, "page1"))
						?.relativePath,
				).toBe("notion/pages/page1.md");

				return {
					nextCursor: "cursor-1",
				};
			},
		};

		const app = createSyncdownApp({
			connectors: [connector],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		});

		const exitCode = await app.run(createIo());

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(fileSeenDuringSync).toBe(true);
		expect(await state.getCursor(notionIntegrationId)).toBe("cursor-1");
		expect(await state.getLastSyncAt(notionIntegrationId)).not.toBeNull();
	} finally {
		await cleanup();
	}
});

test("keeps partially persisted documents recoverable across failed and successful runs", async () => {
	const { cleanup, config, notionIntegrationId } = await createTestPaths();

	try {
		const state = new MemoryStateStore();
		const runAttempts: string[] = [];

		const failingConnector: Connector = {
			id: "notion",
			label: "Notion",
			setupMethods: NOTION_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "token valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				runAttempts.push("fail");
				await request.persistSource(createSource("page1"));
				throw new Error("mid-run failure");
			},
		};

		const successfulConnector: Connector = {
			id: "notion",
			label: "Notion",
			setupMethods: NOTION_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "token valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				runAttempts.push("success");
				expect(
					(await state.getSourceRecord(notionIntegrationId, "page1"))
						?.sourceHash,
				).toBe("hash-page1");
				await request.persistSource(createSource("page2"));
				return {
					nextCursor: "cursor-2",
				};
			},
		};

		const commonServices = {
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		};

		const firstExit = await createSyncdownApp({
			connectors: [failingConnector],
			...commonServices,
		}).run(createIo());

		expect(firstExit).toBe(EXIT_CODES.SYNC_ERROR);
		expect(await state.getCursor(notionIntegrationId)).toBeNull();
		expect(await state.getLastSyncAt(notionIntegrationId)).toBeNull();
		expect(
			(await state.getSourceRecord(notionIntegrationId, "page1"))?.sourceHash,
		).toBe("hash-page1");
		expect(
			await readFile(
				path.join(config.outputDir!, "notion", "pages", "page1.md"),
				"utf8",
			),
		).toBe("page1\nbody-page1\n");

		const secondExit = await createSyncdownApp({
			connectors: [successfulConnector],
			...commonServices,
		}).run(createIo());

		expect(secondExit).toBe(EXIT_CODES.OK);
		expect(runAttempts).toEqual(["fail", "fail", "fail", "success"]);
		expect(await state.getCursor(notionIntegrationId)).toBe("cursor-2");
		expect(await state.getLastSyncAt(notionIntegrationId)).not.toBeNull();
		expect(
			await readFile(
				path.join(config.outputDir!, "notion", "pages", "page2.md"),
				"utf8",
			),
		).toBe("page2\nbody-page2\n");
	} finally {
		await cleanup();
	}
});

test("stores snapshots and render version when a source is persisted", async () => {
	const { cleanup, config, notionIntegrationId } = await createTestPaths();

	try {
		const state = new MemoryStateStore();

		const connector: Connector = {
			id: "notion",
			label: "Notion",
			setupMethods: NOTION_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "token valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				expect(request.renderVersion).toBe("test-renderer-notion-v1");
				await request.persistSource(createSource("page9"));
				return {
					nextCursor: "cursor-9",
				};
			},
		};

		const exitCode = await createSyncdownApp({
			connectors: [connector],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(createIo());

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(
			(await state.getSourceRecord(notionIntegrationId, "page9"))
				?.renderVersion,
		).toBe("test-renderer-notion-v1");
		expect(
			(await state.getSourceSnapshot(notionIntegrationId, "page9"))?.payload
				.bodyMd,
		).toBe("body-page9");
		expect(
			await readFile(
				path.join(config.outputDir!, "notion", "pages", "page9.md"),
				"utf8",
			),
		).toBe("page9\nbody-page9\n");
	} finally {
		await cleanup();
	}
});

test("deletes persisted files and state when a source is removed", async () => {
	const { cleanup, config, notionIntegrationId } = await createTestPaths();

	try {
		const state = new MemoryStateStore();

		const firstRun = await createSyncdownApp({
			connectors: [
				createConnector("notion", async (request) => {
					await request.persistSource(createSource("page-delete"));
					return {
						nextCursor: "cursor-1",
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(createIo());

		expect(firstRun).toBe(EXIT_CODES.OK);
		expect(
			await readFile(
				path.join(config.outputDir!, "notion", "pages", "page-delete.md"),
				"utf8",
			),
		).toBe("page-delete\nbody-page-delete\n");

		const { io, writes } = createIoCapture();
		const secondRun = await createSyncdownApp({
			connectors: [
				createConnector("notion", async (request) => {
					await request.deleteSource("page-delete");
					return {
						nextCursor: "cursor-2",
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(io);

		expect(secondRun).toBe(EXIT_CODES.OK);
		expect(
			await state.getSourceRecord(notionIntegrationId, "page-delete"),
		).toBeNull();
		expect(
			await state.getSourceSnapshot(notionIntegrationId, "page-delete"),
		).toBeNull();
		await expect(
			access(path.join(config.outputDir!, "notion", "pages", "page-delete.md")),
		).rejects.toThrow();
		expect(writes).toContain("Document deleted: notion/pages/page-delete.md");
	} finally {
		await cleanup();
	}
});

test("resetState clears one integration before a targeted rerun", async () => {
	const { cleanup, config, notionIntegrationId } = await createTestPaths();

	try {
		const state = new MemoryStateStore();

		const firstExit = await createSyncdownApp({
			connectors: [
				createConnector("notion", async (request) => {
					await request.persistSource(createSource("page-reset"));
					return {
						nextCursor: "cursor-before-reset",
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(createIo());

		expect(firstExit).toBe(EXIT_CODES.OK);
		expect(await state.getCursor(notionIntegrationId)).toBe(
			"cursor-before-reset",
		);
		expect(await state.getLastSyncAt(notionIntegrationId)).not.toBeNull();

		const resetConnector: Connector = {
			id: "notion",
			label: "Notion",
			setupMethods: NOTION_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "token valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				expect(await state.getCursor(notionIntegrationId)).toBeNull();
				expect(await state.getLastSyncAt(notionIntegrationId)).toBeNull();
				expect(
					await state.getSourceRecord(notionIntegrationId, "page-reset"),
				).toBeNull();
				await expect(
					access(
						path.join(config.outputDir!, "notion", "pages", "page-reset.md"),
					),
				).rejects.toThrow();

				await request.persistSource(createSource("page-reset"));
				return {
					nextCursor: "cursor-after-reset",
				};
			},
		};

		const { io, writes } = createIoCapture();
		const secondExit = await createSyncdownApp({
			connectors: [resetConnector],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(io, {
			target: { kind: "integration", integrationId: notionIntegrationId },
			resetState: true,
		});

		expect(secondExit).toBe(EXIT_CODES.OK);
		expect(await state.getCursor(notionIntegrationId)).toBe(
			"cursor-after-reset",
		);
		expect(writes).toContain("Integration reset: Notion documents_removed=1");
		expect(
			await readFile(
				path.join(config.outputDir!, "notion", "pages", "page-reset.md"),
				"utf8",
			),
		).toBe("page-reset\nbody-page-reset\n");
	} finally {
		await cleanup();
	}
});

test("gmail connector can reset legacy cursor state during sync and rewrite files", async () => {
	const { cleanup, config, paths, gmailIntegrationId } =
		await createTestPaths();

	try {
		const gmail = getDefaultIntegration(config, "gmail");
		gmail.enabled = true;
		await writeConfig(paths, config);

		const state = new MemoryStateStore();
		const legacyAwareConnector: Connector = {
			id: "gmail",
			label: "Gmail",
			setupMethods: GMAIL_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "credentials valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				if (!request.since) {
					await request.persistSource({
						...createSource("gmail-reset"),
						integrationId: gmailIntegrationId,
						connectorId: "gmail",
					});
					return {
						nextCursor: "legacy-cursor",
					};
				}

				expect(request.since).toBe("legacy-cursor");
				await request.resetIntegrationState();
				expect(await state.getCursor(gmailIntegrationId)).toBeNull();
				expect(
					await state.getSourceRecord(gmailIntegrationId, "gmail-reset"),
				).toBeNull();
				await expect(
					access(
						path.join(config.outputDir!, "gmail", "pages", "gmail-reset.md"),
					),
				).rejects.toThrow();

				await request.persistSource({
					...createSource("gmail-reset"),
					integrationId: gmailIntegrationId,
					connectorId: "gmail",
				});
				return {
					nextCursor: JSON.stringify({
						historyId: "cursor-after-reset",
						syncFilter: "primary",
					}),
				};
			},
		};

		const firstExit = await createSyncdownApp({
			connectors: [legacyAwareConnector],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(createIo());

		expect(firstExit).toBe(EXIT_CODES.OK);
		expect(await state.getCursor(gmailIntegrationId)).toBe("legacy-cursor");

		const { io, writes } = createIoCapture();
		const secondExit = await createSyncdownApp({
			connectors: [legacyAwareConnector],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(io, {
			target: { kind: "integration", integrationId: gmailIntegrationId },
		});

		expect(secondExit).toBe(EXIT_CODES.OK);
		expect(await state.getCursor(gmailIntegrationId)).toBe(
			JSON.stringify({
				historyId: "cursor-after-reset",
				syncFilter: "primary",
			}),
		);
		expect(writes).toContain("Integration reset: Gmail documents_removed=1");
	} finally {
		await cleanup();
	}
});

test("gmail connector can reset mismatched scoped cursor state during sync", async () => {
	const { cleanup, config, paths, gmailIntegrationId } =
		await createTestPaths();

	try {
		const gmail = getDefaultIntegration(config, "gmail");
		gmail.enabled = true;
		await writeConfig(paths, config);

		const state = new MemoryStateStore();
		const outputPath = path.join(
			config.outputDir!,
			"gmail",
			"pages",
			"gmail-filter.md",
		);
		const mismatchAwareConnector: Connector = {
			id: "gmail",
			label: "Gmail",
			setupMethods: GMAIL_SETUP_METHODS,
			async validate(): Promise<{ status: "ok"; message: string }> {
				return { status: "ok", message: "credentials valid" };
			},
			async sync(request: ConnectorSyncRequest) {
				expect(request.since).toBe(
					JSON.stringify({
						historyId: "cursor-before-reset",
						syncFilter: "primary-important",
					}),
				);
				await request.resetIntegrationState();
				expect(await state.getCursor(gmailIntegrationId)).toBeNull();
				expect(
					await state.getSourceRecord(gmailIntegrationId, "gmail-filter"),
				).toBeNull();
				await expect(access(outputPath)).rejects.toThrow();

				await request.persistSource({
					...createSource("gmail-filter"),
					integrationId: gmailIntegrationId,
					connectorId: "gmail",
				});
				return {
					nextCursor: JSON.stringify({
						historyId: "cursor-after-reset",
						syncFilter: "primary",
					}),
				};
			},
		};

		await createSyncdownApp({
			connectors: [
				createConnector("gmail", async (request) => {
					await request.persistSource({
						...createSource("gmail-filter"),
						integrationId: gmailIntegrationId,
						connectorId: "gmail",
					});
					return {
						nextCursor: JSON.stringify({
							historyId: "cursor-before-reset",
							syncFilter: "primary-important",
						}),
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(createIo());

		expect(await state.getCursor(gmailIntegrationId)).toBe(
			JSON.stringify({
				historyId: "cursor-before-reset",
				syncFilter: "primary-important",
			}),
		);

		const { io, writes } = createIoCapture();
		const secondExit = await createSyncdownApp({
			connectors: [mismatchAwareConnector],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(io, {
			target: { kind: "integration", integrationId: gmailIntegrationId },
		});

		expect(secondExit).toBe(EXIT_CODES.OK);
		expect(await state.getCursor(gmailIntegrationId)).toBe(
			JSON.stringify({
				historyId: "cursor-after-reset",
				syncFilter: "primary",
			}),
		);
		expect(writes).toContain("Integration reset: Gmail documents_removed=1");
	} finally {
		await cleanup();
	}
});

test("watch reruns sync cycles and exits cleanly after shutdown", async () => {
	const { cleanup } = await createTestPaths();

	try {
		const runtime = createTestRuntime();
		const state = new MemoryStateStore();
		const synced: string[] = [];

		const app = createSyncdownApp(
			{
				connectors: [
					createConnector("notion", async () => {
						synced.push(`cycle-${synced.length + 1}`);
						if (synced.length === 2) {
							runtime.emit("SIGINT");
						}

						return {
							nextCursor: `cursor-${synced.length}`,
						};
					}),
				],
				renderer: new TestRenderer(),
				sink: new TestSink(),
				state,
				secrets: new StaticSecretsStore(),
			},
			runtime.runtime,
		);

		const { io, writes } = createIoCapture();
		const exitCode = await app.run(io, { watch: true, watchInterval: "5m" });

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(synced).toEqual(["cycle-1", "cycle-2"]);
		expect(runtime.sleepCalls).toEqual([5 * 60 * 1_000]);
		expect(writes[0] ?? "").toMatch(/Watch mode enabled. interval=5m/);
		expect(
			writes.some((line) =>
				line.includes("Shutdown requested. Exiting watch mode."),
			),
		).toBe(true);
	} finally {
		await cleanup();
	}
});

test("watch continues after sync errors and retries on the next interval", async () => {
	const { cleanup, notionIntegrationId } = await createTestPaths();

	try {
		const runtime = createTestRuntime();
		const state = new MemoryStateStore();
		const attempts: string[] = [];

		const app = createSyncdownApp(
			{
				connectors: [
					createConnector("notion", async () => {
						if (attempts.length < 3) {
							attempts.push("fail");
							throw new Error("temporary failure");
						}

						attempts.push("success");
						runtime.emit("SIGTERM");
						return {
							nextCursor: "cursor-success",
						};
					}),
				],
				renderer: new TestRenderer(),
				sink: new TestSink(),
				state,
				secrets: new StaticSecretsStore(),
			},
			runtime.runtime,
		);

		const { io, errors } = createIoCapture();
		const exitCode = await app.run(io, { watch: true, watchInterval: "5m" });

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(attempts).toEqual(["fail", "fail", "fail", "success"]);
		expect(await state.getCursor(notionIntegrationId)).toBe("cursor-success");
		expect(runtime.sleepCalls).toEqual([1_000, 2_000, 5 * 60 * 1_000]);
		expect(errors.some((line) => line.includes("temporary failure"))).toBe(
			true,
		);
	} finally {
		await cleanup();
	}
});

test("openSession runNow updates runtime snapshot and logs", async () => {
	const { cleanup, gmailIntegrationId, notionIntegrationId } =
		await createTestPaths();

	try {
		const app = createSyncdownApp({
			connectors: [createConnector("notion"), createConnector("gmail")],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state: new MemoryStateStore(),
			secrets: new StaticSecretsStore(),
		});

		const session = await app.openSession();
		await session.runNow({ kind: "all" });

		const snapshot = session.getSnapshot();
		expect(snapshot.lastRunTarget).toEqual({ kind: "all" });
		expect(snapshot.lastRunExitCode).toBe(EXIT_CODES.OK);
		expect(
			snapshot.logs.some((entry) =>
				entry.message.includes("Run started. integrations=1"),
			),
		).toBe(true);
		expect(
			snapshot.integrations.find(
				(integration) => integration.id === notionIntegrationId,
			)?.lastSuccessAt,
		).not.toBeNull();
		expect(
			snapshot.integrations.find(
				(integration) => integration.id === gmailIntegrationId,
			)?.lastSuccessAt,
		).toBeNull();

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("openSession queues repeated runs for the same connector", async () => {
	const { cleanup, notionIntegrationId } = await createTestPaths();

	try {
		let runs = 0;
		let activeRuns = 0;
		let maxActiveRuns = 0;
		let releaseFirstRun = () => {};
		let markFirstRunStarted = () => {};
		const firstRunStarted = new Promise<void>((resolve) => {
			markFirstRunStarted = resolve;
		});
		const firstRunGate = new Promise<void>((resolve) => {
			releaseFirstRun = resolve;
		});

		const app = createSyncdownApp({
			connectors: [
				createConnector("notion", async () => {
					runs += 1;
					activeRuns += 1;
					maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
					if (runs === 1) {
						markFirstRunStarted();
						await firstRunGate;
					}

					activeRuns -= 1;
					return {
						nextCursor: `cursor-${runs}`,
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state: new MemoryStateStore(),
			secrets: new StaticSecretsStore(),
		});

		const session = await app.openSession();
		const firstRun = session.runNow({
			kind: "integration",
			integrationId: notionIntegrationId,
		});
		await firstRunStarted;

		const secondRun = session.runNow({
			kind: "integration",
			integrationId: notionIntegrationId,
		});

		releaseFirstRun();
		await Promise.all([firstRun, secondRun]);

		expect(runs).toBe(2);
		expect(maxActiveRuns).toBe(1);

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("run executes different integrations in parallel while keeping each integration serialized", async () => {
	const { cleanup, paths, config } = await createTestPaths();

	try {
		getDefaultIntegration(config, "gmail").enabled = true;
		await writeConfig(paths, config);

		let activeRuns = 0;
		let maxActiveRuns = 0;
		let releaseNotion = () => {};
		let releaseGmail = () => {};
		let markNotionStarted = () => {};
		let markGmailStarted = () => {};
		const notionStarted = new Promise<void>((resolve) => {
			markNotionStarted = resolve;
		});
		const gmailStarted = new Promise<void>((resolve) => {
			markGmailStarted = resolve;
		});
		const notionGate = new Promise<void>((resolve) => {
			releaseNotion = resolve;
		});
		const gmailGate = new Promise<void>((resolve) => {
			releaseGmail = resolve;
		});

		const app = createSyncdownApp({
			connectors: [
				createConnector("notion", async () => {
					activeRuns += 1;
					maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
					markNotionStarted();
					await notionGate;
					activeRuns -= 1;
					return {
						nextCursor: "notion-cursor",
					};
				}),
				createConnector("gmail", async () => {
					activeRuns += 1;
					maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
					markGmailStarted();
					await gmailGate;
					activeRuns -= 1;
					return {
						nextCursor: "gmail-cursor",
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state: new MemoryStateStore(),
			secrets: new StaticSecretsStore(),
		});

		const runPromise = app.run(createIo());
		await Promise.all([notionStarted, gmailStarted]);
		expect(maxActiveRuns).toBe(2);

		releaseNotion();
		releaseGmail();

		expect(await runPromise).toBe(EXIT_CODES.OK);
	} finally {
		await cleanup();
	}
});

test("per-integration watch starts enabled integrations independently and stops cleanly", async () => {
	const { cleanup, paths, config, gmailIntegrationId, notionIntegrationId } =
		await createTestPaths();

	try {
		getDefaultIntegration(config, "gmail").enabled = true;
		getDefaultIntegration(config, "notion").interval = "5m";
		getDefaultIntegration(config, "gmail").interval = "15m";
		await writeConfig(paths, config);

		let releaseNotion = () => {};
		let releaseGmail = () => {};
		let markNotionStarted = () => {};
		let markGmailStarted = () => {};
		const notionStarted = new Promise<void>((resolve) => {
			markNotionStarted = resolve;
		});
		const gmailStarted = new Promise<void>((resolve) => {
			markGmailStarted = resolve;
		});
		const notionGate = new Promise<void>((resolve) => {
			releaseNotion = resolve;
		});
		const gmailGate = new Promise<void>((resolve) => {
			releaseGmail = resolve;
		});

		const app = createSyncdownApp({
			connectors: [
				createConnector("notion", async () => {
					markNotionStarted();
					await notionGate;
					return {
						nextCursor: "notion-cursor",
					};
				}),
				createConnector("gmail", async () => {
					markGmailStarted();
					await gmailGate;
					return {
						nextCursor: "gmail-cursor",
					};
				}),
			],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state: new MemoryStateStore(),
			secrets: new StaticSecretsStore(),
		});

		const session = await app.openSession();
		await session.startWatch({ kind: "per-integration" });
		await Promise.all([notionStarted, gmailStarted]);

		const runningSnapshot = session.getSnapshot();
		expect(runningSnapshot.watch.active).toBe(true);
		expect(
			runningSnapshot.integrations.find(
				(integration) => integration.id === notionIntegrationId,
			)?.running,
		).toBe(true);
		expect(
			runningSnapshot.integrations.find(
				(integration) => integration.id === gmailIntegrationId,
			)?.running,
		).toBe(true);

		const stopPromise = session.stopWatch();
		releaseNotion();
		releaseGmail();
		await stopPromise;

		const stoppedSnapshot = session.getSnapshot();
		expect(stoppedSnapshot.watch.active).toBe(false);
		expect(stoppedSnapshot.status).toBe("idle");

		await session.dispose();
	} finally {
		await cleanup();
	}
});
