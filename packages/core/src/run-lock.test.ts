import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createSyncdownApp } from "./app.js";
import {
	createConnector,
	createIo,
	createTestPaths,
	createTestRuntime,
	MemoryStateStore,
	StaticSecretsStore,
	TestRenderer,
	TestSink,
} from "./test-support.js";
import { EXIT_CODES } from "./types.js";

test("ignores a fresh lock file when the recorded pid is no longer alive", async () => {
	const { cleanup, paths, notionIntegrationId } = await createTestPaths();

	try {
		const state = new MemoryStateStore();

		await mkdir(paths.dataDir, { recursive: true });
		await writeFile(
			paths.lockPath,
			JSON.stringify({
				pid: 999_999,
				createdAt: new Date().toISOString(),
			}),
			"utf8",
		);

		const exitCode = await createSyncdownApp({
			connectors: [createConnector("notion")],
			renderer: new TestRenderer(),
			sink: new TestSink(),
			state,
			secrets: new StaticSecretsStore(),
		}).run(createIo());

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(await state.getCursor(notionIntegrationId)).toBe("notion-cursor");
	} finally {
		await cleanup();
	}
});

test("watch heartbeat keeps the run lock fresh and blocks competing runs", async () => {
	const { cleanup, paths } = await createTestPaths();

	try {
		const runtime = createTestRuntime();
		const state = new MemoryStateStore();
		let competingExitCode: number | undefined;
		let observedUpdatedAt: string | undefined;

		runtime.setOnSleep(async () => {
			const lockPayload = JSON.parse(
				await readFile(paths.lockPath, "utf8"),
			) as { createdAt: string; updatedAt?: string };
			observedUpdatedAt = lockPayload.updatedAt;
			expect(lockPayload.updatedAt).not.toBeUndefined();
			expect(lockPayload.updatedAt).not.toBe(lockPayload.createdAt);

			const competingApp = createSyncdownApp(
				{
					connectors: [createConnector("notion")],
					renderer: new TestRenderer(),
					sink: new TestSink(),
					state: new MemoryStateStore(),
					secrets: new StaticSecretsStore(),
				},
				runtime.runtime,
			);

			competingExitCode = await competingApp.run(createIo());
			runtime.emit("SIGINT");
		});

		const app = createSyncdownApp(
			{
				connectors: [createConnector("notion")],
				renderer: new TestRenderer(),
				sink: new TestSink(),
				state,
				secrets: new StaticSecretsStore(),
			},
			runtime.runtime,
		);

		const exitCode = await app.run(createIo(), {
			watch: true,
			watchInterval: "24h",
		});

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(competingExitCode).toBe(EXIT_CODES.LOCKED);
		expect(observedUpdatedAt).not.toBeUndefined();
	} finally {
		await cleanup();
	}
});
