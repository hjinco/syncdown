import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type AppIo,
	type ApplyUpdateResult,
	type AppSnapshot,
	createDefaultConfig,
	EXIT_CODES,
	ensureConfig,
	getDefaultIntegration,
	type RunOptions,
	resolveAppPaths,
	type SecretsStore,
	type SelfUpdater,
	type SyncdownApp,
	type SyncSession,
	type UpdateStatus,
} from "@syncdown/core";

import { runCli } from "./program.js";

function createIoCapture(): { io: AppIo; writes: string[]; errors: string[] } {
	const writes: string[] = [];
	const errors: string[] = [];

	return {
		io: {
			write(line) {
				writes.push(line);
			},
			error(line) {
				errors.push(line);
			},
		},
		writes,
		errors,
	};
}

function createSecretsStub(
	overrides: Partial<SecretsStore> = {},
): SecretsStore {
	return {
		async hasSecret(): Promise<boolean> {
			return false;
		},
		async getSecret(): Promise<string | null> {
			return null;
		},
		async setSecret(): Promise<void> {},
		async deleteSecret(): Promise<void> {},
		describe(): string {
			return "test";
		},
		...overrides,
	};
}

function createSnapshot(): AppSnapshot {
	const config = createDefaultConfig();
	config.outputDir = "/tmp/output";
	getDefaultIntegration(config, "notion").enabled = true;
	getDefaultIntegration(config, "gmail").enabled = false;
	getDefaultIntegration(config, "google-calendar").enabled = false;

	return {
		paths: {
			configDir: "/tmp/syncdown/config",
			dataDir: "/tmp/syncdown/data",
			configPath: "/tmp/syncdown/config/config.json",
			statePath: "/tmp/syncdown/data/state.sqlite",
			secretsPath: "/tmp/syncdown/data/secrets.json",
			masterKeyPath: "/tmp/syncdown/data/master.key",
			lockPath: "/tmp/syncdown/data/run.lock",
		},
		config,
		connectors: [
			{
				id: "notion",
				label: "Notion",
				setupMethods: [
					{ kind: "token" },
					{ kind: "provider-oauth", providerId: "notion", requiredScopes: [] },
				],
			},
			{
				id: "gmail",
				label: "Gmail",
				setupMethods: [
					{
						kind: "provider-oauth",
						providerId: "google",
						requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
					},
				],
			},
			{
				id: "google-calendar",
				label: "Google Calendar",
				setupMethods: [
					{
						kind: "provider-oauth",
						providerId: "google",
						requiredScopes: [
							"https://www.googleapis.com/auth/calendar.readonly",
						],
					},
				],
			},
		],
		connections: [
			{
				id: "notion-token-default",
				kind: "notion-token",
				label: "Default Notion Token Connection",
			},
			{
				id: "notion-oauth-default",
				kind: "notion-oauth-account",
				label: "Default Notion OAuth Connection",
			},
			{
				id: "google-account-default",
				kind: "google-account",
				label: "Default Google Account",
			},
		],
		integrations: [
			{
				id: "notion-default",
				connectorId: "notion",
				connectionId: "notion-token-default",
				label: "Default Notion",
				setupMethods: [
					{ kind: "token" },
					{ kind: "provider-oauth", providerId: "notion", requiredScopes: [] },
				],
				enabled: true,
				interval: "1h",
				lastSyncAt: null,
			},
			{
				id: "gmail-default",
				connectorId: "gmail",
				connectionId: "google-account-default",
				label: "Default Gmail",
				setupMethods: [
					{
						kind: "provider-oauth",
						providerId: "google",
						requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
					},
				],
				enabled: false,
				interval: "1h",
				lastSyncAt: null,
			},
			{
				id: "google-calendar-default",
				connectorId: "google-calendar",
				connectionId: "google-account-default",
				label: "Default Google Calendar",
				setupMethods: [
					{
						kind: "provider-oauth",
						providerId: "google",
						requiredScopes: [
							"https://www.googleapis.com/auth/calendar.readonly",
						],
					},
				],
				enabled: false,
				interval: "1h",
				lastSyncAt: null,
			},
		],
	};
}

function createAppStub(
	options: {
		inspect?: () => Promise<AppSnapshot>;
		run?: (options?: RunOptions) => Promise<number>;
		reset?: () => Promise<number>;
		listConnectors?: () => Promise<number>;
		doctor?: () => Promise<number>;
	} = {},
): {
	app: SyncdownApp;
	runCalls: RunOptions[];
	resetCalls: number;
} {
	const runCalls: RunOptions[] = [];
	let resetCalls = 0;

	return {
		app: {
			async inspect() {
				if (options.inspect) {
					return options.inspect();
				}
				throw new Error("inspect should not be called");
			},
			async openSession() {
				return createSessionStub();
			},
			async run(_io, runOptions) {
				runCalls.push(runOptions ?? {});
				return options.run ? options.run(runOptions) : EXIT_CODES.OK;
			},
			async reset() {
				resetCalls += 1;
				return options.reset ? options.reset() : EXIT_CODES.OK;
			},
			async listConnectors() {
				if (options.listConnectors) {
					return options.listConnectors();
				}
				throw new Error("listConnectors should not be called");
			},
			async doctor() {
				if (options.doctor) {
					return options.doctor();
				}
				throw new Error("doctor should not be called");
			},
		},
		runCalls,
		get resetCalls() {
			return resetCalls;
		},
	};
}

function createSessionStub(): SyncSession {
	return {
		getSnapshot() {
			return {
				status: "idle",
				watch: {
					active: false,
					strategy: null,
					startedAt: null,
				},
				lastRunTarget: null,
				lastRunStartedAt: null,
				lastRunFinishedAt: null,
				lastRunExitCode: null,
				lastRunError: null,
				integrations: [],
				logs: [],
			};
		},
		subscribe() {
			return () => {};
		},
		async runNow() {},
		async startWatch() {},
		async stopWatch() {},
		async cancelActiveRun() {},
		async dispose() {},
	};
}

function createUpdaterStub(
	options: {
		currentVersion?: string;
		supportsSelfUpdate?: boolean;
		checkForUpdate?: () => Promise<UpdateStatus>;
		applyUpdate?: () => Promise<ApplyUpdateResult>;
	} = {},
): SelfUpdater {
	const currentVersion = options.currentVersion ?? "0.1.0";
	const supportsSelfUpdate = options.supportsSelfUpdate ?? true;

	return {
		getCurrentVersion() {
			return currentVersion;
		},
		supportsSelfUpdate() {
			return supportsSelfUpdate;
		},
		checkForUpdate:
			options.checkForUpdate ?? (() => new Promise<UpdateStatus>(() => {})),
		applyUpdate:
			options.applyUpdate ??
			(async () => ({
				applied: false,
				version: currentVersion,
				message: `Already up to date: v${currentVersion}.`,
			})),
	};
}

function runTestCli(
	argv: string[],
	dependencies: Parameters<typeof runCli>[1],
): Promise<number> {
	return runCli(argv, {
		...dependencies,
		updater: dependencies?.updater ?? createUpdaterStub(),
	});
}

async function withTty<T>(
	value: boolean,
	callback: () => Promise<T>,
): Promise<T> {
	const stdinDescriptor = Object.getOwnPropertyDescriptor(
		process.stdin,
		"isTTY",
	);
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(
		process.stdout,
		"isTTY",
	);

	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });

	try {
		return await callback();
	} finally {
		if (stdinDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
		}
		if (stdoutDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
		}
	}
}

async function withTempCliPaths<T>(
	callback: (paths: ReturnType<typeof resolveAppPaths>) => Promise<T>,
): Promise<T> {
	const previousConfigHome = process.env.XDG_CONFIG_HOME;
	const previousDataHome = process.env.XDG_DATA_HOME;
	const root = mkdtempSync(path.join("/tmp", "syncdown-cli-test-"));
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.XDG_DATA_HOME = path.join(root, "data");

	try {
		return await callback(resolveAppPaths());
	} finally {
		if (previousConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousConfigHome;
		}
		if (previousDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = previousDataHome;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test("bare syncdown launches the TUI when a TTY is available", async () => {
	const { io, errors } = createIoCapture();
	const { app } = createAppStub();
	let launchCalls = 0;

	const exitCode = await withTty(true, () =>
		runTestCli(["syncdown", "syncdown"], {
			app,
			io,
			secrets: createSecretsStub(),
			launchConfig: async () => {
				launchCalls += 1;
				return EXIT_CODES.OK;
			},
		}),
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(launchCalls).toBe(1);
	expect(errors).toEqual([]);
});

test("bare syncdown prints help in non-interactive environments", async () => {
	const { io, errors } = createIoCapture();
	const { app } = createAppStub();

	const exitCode = await withTty(false, () =>
		runTestCli(["syncdown", "syncdown"], {
			app,
			io,
			secrets: createSecretsStub(),
			launchConfig: async () => {
				throw new Error("launchConfig should not be called");
			},
		}),
	);

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(errors).toContain("Usage:");
	expect(errors).toContain("  syncdown");
	expect(errors).toContain("  syncdown status");
});

test("status prints the overview output", async () => {
	const { io, writes, errors } = createIoCapture();
	const { app } = createAppStub({
		inspect: async () => createSnapshot(),
	});

	const exitCode = await withTty(false, () =>
		runTestCli(["syncdown", "syncdown", "status"], {
			app,
			io,
			secrets: createSecretsStub(),
		}),
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(errors).toEqual([]);
	expect(writes).toContain("syncdown");
	expect(writes).toContain("Next:");
	expect(
		writes.some((line) => line.includes("google-calendar: disabled")),
	).toBe(true);
	expect(writes.some((line) => line.includes("syncdown config set"))).toBe(
		true,
	);
});

test("status prints google calendar selection count", async () => {
	const { io, writes } = createIoCapture();
	const baseSnapshot = createSnapshot();
	const config = structuredClone(baseSnapshot.config);
	const googleCalendar = getDefaultIntegration(config, "google-calendar");
	if (googleCalendar.connectorId !== "google-calendar") {
		throw new Error("expected google calendar integration");
	}
	googleCalendar.enabled = true;
	googleCalendar.config.selectedCalendarIds = ["primary", "work@example.com"];
	const { app } = createAppStub({
		inspect: async () => ({
			...baseSnapshot,
			config,
		}),
	});

	await withTty(false, () =>
		runTestCli(["syncdown", "syncdown", "status"], {
			app,
			io,
			secrets: createSecretsStub({
				async hasSecret() {
					return true;
				},
			}),
		}),
	);

	expect(writes.some((line) => line.includes("selected calendars=2"))).toBe(
		true,
	);
});

test("status hides apple notes when the connector is unavailable", async () => {
	const { io, writes } = createIoCapture();
	const { app } = createAppStub({
		inspect: async () => createSnapshot(),
	});

	await withTty(false, () =>
		runTestCli(["syncdown", "syncdown", "status"], {
			app,
			io,
			secrets: createSecretsStub(),
		}),
	);

	expect(writes.some((line) => line.startsWith("apple-notes:"))).toBe(false);
	expect(writes.some((line) => line.includes("appleNotes.enabled"))).toBe(
		false,
	);
});

test("status prints gmail performance settings", async () => {
	const { io, writes } = createIoCapture();
	const baseSnapshot = createSnapshot();
	const config = structuredClone(baseSnapshot.config);
	const gmail = getDefaultIntegration(config, "gmail");
	if (gmail.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	gmail.config.fetchConcurrency = 4;
	gmail.config.syncFilter = "primary-important";
	const { app } = createAppStub({
		inspect: async () => ({
			...baseSnapshot,
			config,
		}),
	});

	await withTty(false, () =>
		runTestCli(["syncdown", "syncdown", "status"], {
			app,
			io,
			secrets: createSecretsStub(),
		}),
	);

	expect(writes.some((line) => line.includes("concurrency=4"))).toBe(true);
	expect(writes.some((line) => line.includes("filter=primary-important"))).toBe(
		true,
	);
});

test("config set stores gmail.syncFilter in the config file", async () => {
	const { io, writes, errors } = createIoCapture();
	const { app } = createAppStub();

	await withTempCliPaths(async (paths) => {
		const exitCode = await runTestCli(
			[
				"syncdown",
				"syncdown",
				"config",
				"set",
				"gmail.syncFilter",
				"primary-important",
			],
			{
				app,
				io,
				secrets: createSecretsStub(),
			},
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(errors).toEqual([]);
		expect(writes).toContain("Set gmail.syncFilter=primary-important");
		const config = await ensureConfig(paths);
		const gmail = getDefaultIntegration(config, "gmail");
		if (gmail.connectorId !== "gmail") {
			throw new Error("expected gmail integration");
		}
		expect(gmail.config.syncFilter).toBe("primary-important");
	});
});

test("config set rejects a non-empty outputDir", async () => {
	const { io, errors } = createIoCapture();
	const { app } = createAppStub();

	await withTempCliPaths(async (paths) => {
		const nonEmptyDir = path.join(paths.dataDir, "non-empty-output");
		mkdirSync(nonEmptyDir, { recursive: true });
		writeFileSync(path.join(nonEmptyDir, ".keep"), "occupied");

		const exitCode = await runTestCli(
			["syncdown", "syncdown", "config", "set", "outputDir", nonEmptyDir],
			{
				app,
				io,
				secrets: createSecretsStub(),
			},
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toContain(
			"Output folder must be completely empty before syncdown can use it.",
		);
		expect((await ensureConfig(paths)).outputDir).toBeUndefined();
	});
});

test("config set rejects invalid gmail.syncFilter values", async () => {
	const { io, errors } = createIoCapture();
	const { app } = createAppStub();

	await withTempCliPaths(async () => {
		const exitCode = await runTestCli(
			[
				"syncdown",
				"syncdown",
				"config",
				"set",
				"gmail.syncFilter",
				"important",
			],
			{
				app,
				io,
				secrets: createSecretsStub(),
			},
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toContain(
			"gmail.syncFilter must be one of: primary, primary-important.",
		);
	});
});

test("config set stores googleCalendar.selectedCalendarIds in the config file", async () => {
	const { io, writes, errors } = createIoCapture();
	const { app } = createAppStub();

	await withTempCliPaths(async (paths) => {
		const exitCode = await runTestCli(
			[
				"syncdown",
				"syncdown",
				"config",
				"set",
				"googleCalendar.selectedCalendarIds",
				"primary, work@example.com , primary",
			],
			{
				app,
				io,
				secrets: createSecretsStub(),
			},
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(errors).toEqual([]);
		expect(writes).toContain(
			"Set googleCalendar.selectedCalendarIds=primary,work@example.com",
		);
		const config = await ensureConfig(paths);
		const googleCalendar = getDefaultIntegration(config, "google-calendar");
		if (googleCalendar.connectorId !== "google-calendar") {
			throw new Error("expected google calendar integration");
		}
		expect(googleCalendar.config.selectedCalendarIds).toEqual([
			"primary",
			"work@example.com",
		]);
	});
});

test("status prints the active notion auth method", async () => {
	const { io, writes } = createIoCapture();
	const baseSnapshot = createSnapshot();
	const config = structuredClone(baseSnapshot.config);
	getDefaultIntegration(config, "notion").connectionId = "notion-oauth-default";
	const { app } = createAppStub({
		inspect: async () => ({
			...baseSnapshot,
			config,
			integrations: baseSnapshot.integrations.map((integration) =>
				integration.connectorId === "notion"
					? {
							...integration,
							connectionId: "notion-oauth-default",
						}
					: integration,
			),
		}),
	});

	await withTty(false, () =>
		runTestCli(["syncdown", "syncdown", "status"], {
			app,
			io,
			secrets: createSecretsStub({
				async hasSecret(name) {
					return (
						name.startsWith("oauthApps.notion-oauth-app-default") ||
						name === "connections.notion-oauth-default.refreshToken"
					);
				},
			}),
		}),
	);

	expect(
		writes.some((line) => line.includes("notion: enabled | method=oauth")),
	).toBe(true);
});

test("config without a subcommand prints config help", async () => {
	const { io, errors } = createIoCapture();
	const { app } = createAppStub();
	let launchCalls = 0;

	const exitCode = await runTestCli(["syncdown", "syncdown", "config"], {
		app,
		io,
		secrets: createSecretsStub(),
		launchConfig: async () => {
			launchCalls += 1;
			return EXIT_CODES.OK;
		},
	});

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(launchCalls).toBe(0);
	expect(errors).toContain("Usage:");
	expect(errors).toContain("  syncdown config set <key> <value>");
	expect(errors).toContain("Use `syncdown` to launch the interactive TUI.");
});

test("run forwards one-shot execution without watch options", async () => {
	const { io, errors } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(["syncdown", "syncdown", "run"], {
		app,
		io,
		secrets: createSecretsStub(),
	});

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(runCalls).toEqual([{ target: undefined, resetState: false }]);
	expect(errors).toEqual([]);
});

test("run forwards a targeted reset for one integration", async () => {
	const { io } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		[
			"syncdown",
			"syncdown",
			"run",
			"--integration",
			"notion-default",
			"--reset",
		],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(runCalls).toEqual([
		{
			target: { kind: "integration", integrationId: "notion-default" },
			resetState: true,
		},
	]);
});

test("run forwards a connector target", async () => {
	const { io } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--connector", "gmail"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(runCalls).toEqual([
		{
			target: { kind: "connector", connectorId: "gmail" },
			resetState: false,
		},
	]);
});

test("run --watch uses the default 1h interval", async () => {
	const { io } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--watch"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(runCalls).toEqual([{ watch: true, watchInterval: "1h" }]);
});

test("run --watch --interval forwards the explicit interval", async () => {
	const { io } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--watch", "--interval", "5m"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(runCalls).toEqual([{ watch: true, watchInterval: "5m" }]);
});

test("run rejects --interval without --watch", async () => {
	const { io, errors } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--interval", "5m"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(runCalls).toEqual([]);
	expect(errors[0] ?? "").toMatch(
		/--interval can only be used together with --watch/,
	);
});

test("run rejects an invalid watch interval", async () => {
	const { io, errors } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--watch", "--interval", "30m"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(runCalls).toEqual([]);
	expect(errors[0] ?? "").toMatch(/--interval must be one of/);
});

test("reset dispatches to app.reset when --yes is provided", async () => {
	const { io, errors } = createIoCapture();
	const stub = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "reset", "--yes"],
		{
			app: stub.app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(stub.resetCalls).toBe(1);
	expect(errors).toEqual([]);
});

test("reset requires --yes and rejects extra arguments", async () => {
	const { io, errors } = createIoCapture();
	const stub = createAppStub();

	const missingConfirmationExitCode = await runTestCli(
		["syncdown", "syncdown", "reset"],
		{
			app: stub.app,
			io,
			secrets: createSecretsStub(),
		},
	);

	const extraArgumentExitCode = await runTestCli(
		["syncdown", "syncdown", "reset", "--yes", "--force"],
		{
			app: stub.app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(missingConfirmationExitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(extraArgumentExitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(stub.resetCalls).toBe(0);
	expect(errors).toContain("Usage: syncdown reset --yes");
});

test("run rejects --reset with --watch", async () => {
	const { io, errors } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--watch", "--reset"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(runCalls).toEqual([]);
	expect(errors[0] ?? "").toMatch(/--reset can only be used for one-shot runs/);
});

test("run rejects targeted watch mode", async () => {
	const { io, errors } = createIoCapture();
	const { app, runCalls } = createAppStub();

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "run", "--watch", "--connector", "notion"],
		{
			app,
			io,
			secrets: createSecretsStub(),
		},
	);

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(runCalls).toEqual([]);
	expect(errors[0] ?? "").toMatch(/only supported for one-shot runs/);
});

test("update --check prints latest version information", async () => {
	const { io, writes, errors } = createIoCapture();
	const { app } = createAppStub();
	const updater = createUpdaterStub({
		checkForUpdate: async () => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			hasUpdate: true,
			canSelfUpdate: true,
			reason: null,
			checkedAt: "2026-03-17T00:00:00.000Z",
		}),
	});

	const exitCode = await runTestCli(
		["syncdown", "syncdown", "update", "--check"],
		{
			app,
			io,
			secrets: createSecretsStub(),
			updater,
		},
	);

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(errors).toEqual([]);
	expect(writes).toContain("current: v0.1.0");
	expect(writes).toContain("latest: v0.2.0");
	expect(writes).toContain("self-update: available");
});

test("update rejects source-mode self-update", async () => {
	const { io, writes, errors } = createIoCapture();
	const { app } = createAppStub();
	const updater = createUpdaterStub({
		supportsSelfUpdate: false,
		checkForUpdate: async () => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			hasUpdate: true,
			canSelfUpdate: false,
			reason: "Self-update unavailable in source/dev run.",
			checkedAt: "2026-03-17T00:00:00.000Z",
		}),
	});

	const exitCode = await runTestCli(["syncdown", "syncdown", "update"], {
		app,
		io,
		secrets: createSecretsStub(),
		updater,
	});

	expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
	expect(writes).toContain("self-update: unavailable");
	expect(errors).toContain("Self-update unavailable in source/dev run.");
});

test("update applies the latest release when available", async () => {
	const { io, writes, errors } = createIoCapture();
	const { app } = createAppStub();
	let applyCalls = 0;
	const updater = createUpdaterStub({
		checkForUpdate: async () => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			hasUpdate: true,
			canSelfUpdate: true,
			reason: null,
			checkedAt: "2026-03-17T00:00:00.000Z",
		}),
		applyUpdate: async () => {
			applyCalls += 1;
			return {
				applied: true,
				version: "0.2.0",
				message: "Update installed for v0.2.0. Restart syncdown.",
			};
		},
	});

	const exitCode = await runTestCli(["syncdown", "syncdown", "update"], {
		app,
		io,
		secrets: createSecretsStub(),
		updater,
	});

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(applyCalls).toBe(1);
	expect(errors).toEqual([]);
	expect(writes).toContain("Update installed for v0.2.0. Restart syncdown.");
});

test("status starts a best-effort update announcement without changing the exit code", async () => {
	const { io, errors } = createIoCapture();
	const { app } = createAppStub({
		inspect: async () => createSnapshot(),
	});
	const updater = createUpdaterStub({
		checkForUpdate: async () => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			hasUpdate: true,
			canSelfUpdate: true,
			reason: null,
			checkedAt: "2026-03-17T00:00:00.000Z",
		}),
	});

	const exitCode = await withTty(false, () =>
		runTestCli(["syncdown", "syncdown", "status"], {
			app,
			io,
			secrets: createSecretsStub(),
			updater,
		}),
	);
	await Promise.resolve();

	expect(exitCode).toBe(EXIT_CODES.OK);
	expect(
		errors.some((line) =>
			line.includes(
				"Update available: v0.1.0 -> v0.2.0. Run `syncdown update`.",
			),
		),
	).toBe(true);
});
