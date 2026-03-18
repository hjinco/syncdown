import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as OpenTuiTesting from "@opentui/core/testing";
import {
	type AppIo,
	type ApplyUpdateResult,
	type AppPaths,
	createDefaultConfig,
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	getDefaultIntegration,
	getGoogleConnectionSecretNames,
	getGoogleOAuthAppSecretNames,
	type RunNowOptions,
	type SecretsStore,
	type SelfUpdater,
	type SyncdownApp,
	type SyncdownConfig,
	type SyncRunTarget,
	type SyncRuntimeSnapshot,
	type SyncSession,
	type UpdateStatus,
} from "@syncdown/core";

import { ConfigTuiApp } from "./app.js";
import type { GoogleAuthSession, TuiAuthService } from "./auth.js";
import {
	buildOutputPresetPaths,
	createDraftState,
	normalizeOutputPath,
} from "./state.js";
import {
	createConfirmDisconnectRoute,
	createConnectorAuthRoute,
	createConnectorDetailsRoute,
	createGmailFilterRoute,
	createIntervalRoute,
	createOutputCustomRoute,
	createSyncDashboardRoute,
	getConnectorAuthDocsUrl,
	getRouteOptions,
} from "./view-state.js";

const NOTION_INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const GMAIL_INTEGRATION_ID = "22222222-2222-4222-8222-222222222222";
const GOOGLE_CALENDAR_INTEGRATION_ID = "33333333-3333-4333-8333-333333333333";
const DOCS_BASE_URL = "https://docs.example.com";

const { createTestRenderer } = OpenTuiTesting as unknown as {
	createTestRenderer: (options: { width: number; height: number }) => Promise<{
		renderer: any;
		renderOnce: () => Promise<void>;
		captureCharFrame: () => string;
		mockInput: {
			pressArrow: (direction: "up" | "down" | "left" | "right") => void;
			pressEnter: () => void;
			typeText: (value: string) => Promise<void>;
		};
	}>;
};

function createConfig(): SyncdownConfig {
	const config = createDefaultConfig();
	config.outputDir = "/tmp/output";
	getDefaultIntegration(config, "notion").enabled = true;
	getDefaultIntegration(config, "gmail").enabled = false;
	return config;
}

function createPaths(overrides: Partial<AppPaths> = {}): AppPaths {
	const root = mkdtempSync(path.join(resolveTempDirectory(), "syncdown-app-"));
	return {
		configDir: path.join(root, "config"),
		dataDir: path.join(root, "data"),
		configPath: path.join(root, "config", "config.json"),
		statePath: path.join(root, "data", "state.sqlite"),
		secretsPath: path.join(root, "data", "secrets.json"),
		masterKeyPath: path.join(root, "data", "master.key"),
		lockPath: path.join(root, "data", "run.lock"),
		...overrides,
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

function createIo(): AppIo {
	return {
		write() {},
		error() {},
	};
}

function createSecretsStore(initial = new Map<string, string>()) {
	const values = new Map(initial);
	const setCalls: Array<{ name: string; value: string }> = [];
	const deleteCalls: string[] = [];
	const store: SecretsStore = {
		async hasSecret(name) {
			return values.has(name);
		},
		async getSecret(name) {
			return values.get(name) ?? null;
		},
		async setSecret(name, value) {
			setCalls.push({ name, value });
			values.set(name, value);
		},
		async deleteSecret(name) {
			deleteCalls.push(name);
			values.delete(name);
		},
		describe() {
			return "memory";
		},
	};

	return {
		store,
		values,
		setCalls,
		deleteCalls,
	};
}

function createApp(): SyncdownApp {
	return {
		async inspect() {
			const config = createConfig();
			return {
				paths: {
					configDir: "/tmp/config",
					dataDir: "/tmp/data",
					configPath: "/tmp/config/config.json",
					statePath: "/tmp/data/state.sqlite",
					secretsPath: "/tmp/data/secrets.json",
					masterKeyPath: "/tmp/data/master.key",
					lockPath: "/tmp/data/run.lock",
				},
				config,
				connectors: [
					{
						id: "notion",
						label: "Notion",
						setupMethods: [
							{ kind: "token" },
							{
								kind: "provider-oauth",
								providerId: "notion",
								requiredScopes: [],
							},
						],
					},
					{
						id: "gmail",
						label: "Gmail",
						setupMethods: [
							{
								kind: "provider-oauth",
								providerId: "google",
								requiredScopes: [
									"https://www.googleapis.com/auth/gmail.readonly",
								],
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
						id: "google-account-default",
						kind: "google-account",
						label: "Default Google Account",
					},
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
				],
				integrations: [
					{
						id: NOTION_INTEGRATION_ID,
						connectorId: "notion",
						connectionId: "notion-token-default",
						label: "Notion",
						setupMethods: [
							{ kind: "token" },
							{
								kind: "provider-oauth",
								providerId: "notion",
								requiredScopes: [],
							},
						],
						enabled: true,
						interval: "1h",
						lastSyncAt: null,
					},
					{
						id: GMAIL_INTEGRATION_ID,
						connectorId: "gmail",
						connectionId: "google-account-default",
						label: "Gmail",
						setupMethods: [
							{
								kind: "provider-oauth",
								providerId: "google",
								requiredScopes: [
									"https://www.googleapis.com/auth/gmail.readonly",
								],
							},
						],
						enabled: false,
						interval: "1h",
						lastSyncAt: null,
					},
					{
						id: GOOGLE_CALENDAR_INTEGRATION_ID,
						connectorId: "google-calendar",
						connectionId: "google-account-default",
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
						enabled: false,
						interval: "1h",
						lastSyncAt: null,
					},
				],
			};
		},
		async openSession() {
			return createSessionStub().session;
		},
		async run() {
			throw new Error("unused");
		},
		async listConnectors() {
			throw new Error("unused");
		},
		async doctor(io) {
			io?.write("doctor ok");
			return 0;
		},
	};
}

function createSyncSnapshot(
	overrides: Partial<SyncRuntimeSnapshot> = {},
): SyncRuntimeSnapshot {
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
		integrations: [
			{
				id: NOTION_INTEGRATION_ID,
				connectorId: "notion",
				connectionId: "notion-token-default",
				label: "Notion",
				enabled: true,
				interval: "1h",
				status: "idle",
				running: false,
				queuedImmediateRun: false,
				lastStartedAt: null,
				lastFinishedAt: null,
				lastSuccessAt: null,
				lastError: null,
				lastDocumentsWritten: 0,
				nextRunAt: null,
				progress: null,
			},
			{
				id: GMAIL_INTEGRATION_ID,
				connectorId: "gmail",
				connectionId: "google-account-default",
				label: "Gmail",
				enabled: false,
				interval: "1h",
				status: "idle",
				running: false,
				queuedImmediateRun: false,
				lastStartedAt: null,
				lastFinishedAt: null,
				lastSuccessAt: null,
				lastError: null,
				lastDocumentsWritten: 0,
				nextRunAt: null,
				progress: null,
			},
		],
		logs: [],
		...overrides,
	};
}

function createSessionStub(initial = createSyncSnapshot()) {
	let snapshot = initial;
	const listeners = new Set<
		(event: { type: "snapshot"; snapshot: SyncRuntimeSnapshot }) => void
	>();
	let watchActive = snapshot.watch.active;
	const runCalls: Array<{ target: SyncRunTarget; options?: RunNowOptions }> =
		[];
	let cancelCalls = 0;
	const session: SyncSession = {
		getSnapshot() {
			return structuredClone(snapshot);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async runNow(target, options) {
			runCalls.push({ target, options });
			const connectorId =
				target.kind === "connector"
					? target.connectorId
					: target.kind === "integration"
						? snapshot.integrations.find(
								(integration) => integration.id === target.integrationId,
							)?.connectorId
						: undefined;
			const integrationId =
				target.kind === "integration" ? target.integrationId : undefined;
			snapshot = {
				...snapshot,
				lastRunTarget: target,
				lastRunExitCode: 0,
				lastRunError: null,
				logs: [
					...snapshot.logs,
					{
						timestamp: "2026-03-17T00:00:00.000Z",
						level: "info",
						message: `run ${target.kind === "all" ? "all" : target.kind === "connector" ? target.connectorId : target.integrationId}`,
						connectorId,
						integrationId,
					},
				],
			};
			for (const listener of listeners) {
				listener({ type: "snapshot", snapshot: structuredClone(snapshot) });
			}
		},
		async startWatch() {
			watchActive = true;
			snapshot = {
				...snapshot,
				status: "watching",
				watch: {
					active: true,
					strategy: { kind: "per-integration" },
					startedAt: "2026-03-17T00:00:00.000Z",
				},
			};
			for (const listener of listeners) {
				listener({ type: "snapshot", snapshot: structuredClone(snapshot) });
			}
		},
		async stopWatch() {
			watchActive = false;
			snapshot = {
				...snapshot,
				status: "idle",
				watch: {
					active: false,
					strategy: null,
					startedAt: null,
				},
			};
			for (const listener of listeners) {
				listener({ type: "snapshot", snapshot: structuredClone(snapshot) });
			}
		},
		async cancelActiveRun() {
			cancelCalls += 1;
			watchActive = false;
			snapshot = {
				...snapshot,
				status: "idle",
				watch: {
					active: false,
					strategy: null,
					startedAt: null,
				},
				lastRunExitCode: 1,
				lastRunError: "Sync cancelled by user.",
				integrations: snapshot.integrations.map((integration) => ({
					...integration,
					status: "idle",
					running: false,
					queuedImmediateRun: false,
					nextRunAt: null,
				})),
			};
			for (const listener of listeners) {
				listener({ type: "snapshot", snapshot: structuredClone(snapshot) });
			}
		},
		async dispose() {
			if (watchActive) {
				await session.stopWatch();
			}
		},
	};

	return {
		session,
		runCalls,
		get cancelCalls() {
			return cancelCalls;
		},
		pushSnapshot(next: SyncRuntimeSnapshot) {
			snapshot = next;
			for (const listener of listeners) {
				listener({ type: "snapshot", snapshot: structuredClone(snapshot) });
			}
		},
	};
}

function createDefaultAuthService(): TuiAuthService {
	return {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			return { opened: true };
		},
		async openGoogleOAuthSetup() {
			return { opened: true };
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {},
		async validateGoogleCredentials() {},
		async listGoogleCalendars() {
			return [];
		},
	};
}

function readConfigFile(paths: AppPaths): SyncdownConfig {
	return JSON.parse(readFileSync(paths.configPath, "utf8")) as SyncdownConfig;
}

async function withHomeDirectory<T>(
	homeDir: string,
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = Bun.env.HOME;
	Bun.env.HOME = homeDir;

	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete Bun.env.HOME;
		} else {
			Bun.env.HOME = previousHome;
		}
	}
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

test("OpenTUI app initial render reflects the single-focus home screen", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 100,
		height: 30,
	});

	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	await renderOnce();
	const frame = captureCharFrame();

	expect(frame).toContain("Home");
	expect(frame).toContain("Sync");
	expect(frame).toContain("Advanced");
	expect(frame).not.toContain("Actions");
	expect(frame).not.toContain("Details");

	tui.destroy();
});

test("home exposes an update action and reflects an available release", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
			updater: createUpdaterStub({
				checkForUpdate: async () => ({
					currentVersion: "0.1.0",
					latestVersion: "0.2.0",
					hasUpdate: true,
					canSelfUpdate: true,
					reason: null,
					checkedAt: "2026-03-17T00:00:00.000Z",
				}),
			}),
		},
		createPaths(),
		draft,
		renderer,
		createDefaultAuthService(),
	);

	await renderer.idle();

	const options = getRouteOptions((tui as any).ui.routes[0], draft);
	expect(options.some((option) => option.value === "update")).toBe(true);
	expect(options.find((option) => option.value === "update")?.description).toBe(
		"New version available: v0.2.0",
	);

	tui.destroy();
});

test("home render shows the update banner when a new release is available", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
			updater: createUpdaterStub({
				checkForUpdate: async () => ({
					currentVersion: "0.1.0",
					latestVersion: "0.2.0",
					hasUpdate: true,
					canSelfUpdate: true,
					reason: null,
					checkedAt: "2026-03-17T00:00:00.000Z",
				}),
			}),
		},
		createPaths(),
		draft,
		renderer,
		createDefaultAuthService(),
	);

	await renderer.idle();
	await renderOnce();
	const frame = captureCharFrame();

	expect(frame).toContain("Update available: v0.2.0");
	expect(frame).toContain(
		"Open Update to install or review the latest release.",
	);

	tui.destroy();
});

test("update route hides install action in source mode", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
			updater: createUpdaterStub({
				supportsSelfUpdate: false,
				checkForUpdate: async () => ({
					currentVersion: "0.1.0",
					latestVersion: "0.2.0",
					hasUpdate: true,
					canSelfUpdate: false,
					reason: "Self-update unavailable in source/dev run.",
					checkedAt: "2026-03-17T00:00:00.000Z",
				}),
			}),
		},
		createPaths(),
		draft,
		renderer,
		createDefaultAuthService(),
	);

	await renderer.idle();
	(tui as any).ui.routes[0].selectedIndex = 5;
	await (tui as any).activateCurrentSelection();

	const route = (tui as any).ui.routes.at(-1);
	expect(route.id).toBe("update");
	const options = getRouteOptions(route, draft);
	expect(options.map((option) => option.value)).toEqual(["checkNow"]);

	tui.destroy();
});

test("update route applies an available release and shows a success notice", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	let applyCalls = 0;
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
			updater: createUpdaterStub({
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
			}),
		},
		createPaths(),
		draft,
		renderer,
		createDefaultAuthService(),
	);

	await renderer.idle();
	(tui as any).ui.routes[0].selectedIndex = 5;
	await (tui as any).activateCurrentSelection();
	(tui as any).ui.routes.at(-1).selectedIndex = 1;

	await (tui as any).activateCurrentSelection();

	expect(applyCalls).toBe(1);
	expect((tui as any).ui.notice?.text).toBe(
		"Update installed for v0.2.0. Restart syncdown.",
	);

	tui.destroy();
});

test("selection list shrinks to option count and empty notice does not reserve bottom space", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	await renderOnce();
	const frame = captureCharFrame();

	expect((tui as any).pageNotice.visible).toBe(false);
	expect(frame).toContain("Advanced");

	tui.destroy();
});

test("selection and notice render outside the page box", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.notice = { kind: "success", text: "Saved." };
	(tui as any).refreshView();
	await renderOnce();
	const frame = captureCharFrame();
	const lines = frame.split("\n");
	const bodyIndex = lines.findIndex((line) => line.includes("Output:"));
	const noticeIndex = lines.findIndex((line) => line.includes("Saved."));
	const selectIndex = lines.findIndex((line) => line.includes("▶ Sync"));

	expect(bodyIndex).toBeGreaterThan(-1);
	expect(noticeIndex).toBeGreaterThan(bodyIndex);
	expect(selectIndex).toBeGreaterThan(noticeIndex);

	tui.destroy();
});

test("navigation uses a page stack from home to section and back", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes[0].selectedIndex = 1;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("connectors");

	await (tui as any).handleBack();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("home");

	tui.destroy();
});

test("keyboard navigation moves selection and activates the focused menu", async () => {
	const { renderer, mockInput } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	mockInput.pressArrow("down");
	mockInput.pressArrow("down");
	await renderer.idle();
	expect((tui as any).ui.routes[0].selectedIndex).toBe(2);

	mockInput.pressEnter();
	await renderer.idle();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("output");

	tui.destroy();
});

test("left arrow navigates back to the previous page", async () => {
	const { renderer, mockInput } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes[0].selectedIndex = 1;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("connectors");

	mockInput.pressArrow("left");
	await renderer.idle();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("home");

	tui.destroy();
});

test("custom output path autosaves as soon as the page is confirmed", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		{ id: "output", selectedIndex: 0 },
		createOutputCustomRoute(draft),
	];
	(tui as any).ui.routes.at(-1).value = "./notes";

	await (tui as any).submitInput();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("output");
	expect(draft.config.outputDir).toBe(normalizeOutputPath("./notes"));
	expect(readConfigFile(paths).outputDir).toBe(normalizeOutputPath("./notes"));

	tui.destroy();
});

test("custom output path saves when the folder already exists and is empty", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		createDefaultAuthService(),
	);
	const emptyDir = path.join(paths.dataDir, "empty-output");
	mkdirSync(emptyDir, { recursive: true });

	(tui as any).ui.routes = [
		{ id: "output", selectedIndex: 0 },
		createOutputCustomRoute(draft),
	];
	(tui as any).ui.routes.at(-1).value = emptyDir;

	await (tui as any).submitInput();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("output");
	expect(draft.config.outputDir).toBe(normalizeOutputPath(emptyDir));
	expect(readConfigFile(paths).outputDir).toBe(normalizeOutputPath(emptyDir));

	tui.destroy();
});

test("custom output path rejects an existing non-empty folder", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		createDefaultAuthService(),
	);
	const nonEmptyDir = path.join(paths.dataDir, "non-empty-output");
	mkdirSync(nonEmptyDir, { recursive: true });
	writeFileSync(path.join(nonEmptyDir, ".keep"), "occupied");

	(tui as any).ui.routes = [
		{ id: "output", selectedIndex: 0 },
		createOutputCustomRoute(draft),
	];
	(tui as any).ui.routes.at(-1).value = nonEmptyDir;

	await (tui as any).submitInput();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("outputCustom");
	expect((tui as any).ui.routes.at(-1)?.error).toBe(
		"Output folder must be completely empty before syncdown can use it.",
	);
	expect((tui as any).ui.notice).toEqual({
		kind: "error",
		text: "Output folder must be completely empty before syncdown can use it.",
	});
	expect(draft.config.outputDir).toBe("/tmp/output");

	tui.destroy();
});

test("preset output saves a syncdown subdirectory", async () => {
	const homeDir = mkdtempSync(
		path.join(resolveTempDirectory(), "syncdown-home-"),
	);

	await withHomeDirectory(homeDir, async () => {
		const { renderer } = await createTestRenderer({ width: 100, height: 30 });
		const paths = createPaths();
		const draft = createDraftState(createConfig(), {
			notionTokenStored: false,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		});
		const tui = await ConfigTuiApp.create(
			{
				app: createApp(),
				io: createIo(),
				secrets: createSecretsStore().store,
				session: createSessionStub().session,
			},
			paths,
			draft,
			renderer,
			createDefaultAuthService(),
		);
		const expected = buildOutputPresetPaths().desktop;

		(tui as any).ui.routes = [{ id: "output", selectedIndex: 0 }];
		await (tui as any).activateCurrentSelection();

		expect(draft.config.outputDir).toBe(expected);
		expect(readConfigFile(paths).outputDir).toBe(expected);

		tui.destroy();
	});
});

test("preset output rejects a non-empty syncdown subdirectory", async () => {
	const homeDir = mkdtempSync(
		path.join(resolveTempDirectory(), "syncdown-home-"),
	);

	await withHomeDirectory(homeDir, async () => {
		const { renderer } = await createTestRenderer({ width: 100, height: 30 });
		const paths = createPaths();
		const draft = createDraftState(createConfig(), {
			notionTokenStored: false,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		});
		const tui = await ConfigTuiApp.create(
			{
				app: createApp(),
				io: createIo(),
				secrets: createSecretsStore().store,
				session: createSessionStub().session,
			},
			paths,
			draft,
			renderer,
			createDefaultAuthService(),
		);
		const presetPath = buildOutputPresetPaths().desktop;
		mkdirSync(presetPath, { recursive: true });
		writeFileSync(path.join(presetPath, "existing.md"), "occupied");

		(tui as any).ui.routes = [{ id: "output", selectedIndex: 0 }];
		await (tui as any).activateCurrentSelection();

		expect((tui as any).ui.notice).toEqual({
			kind: "error",
			text: "Output folder must be completely empty before syncdown can use it.",
		});
		expect(draft.config.outputDir).toBe("/tmp/output");

		tui.destroy();
	});
});

test("keyboard typing updates the focused input route", async () => {
	const { renderer, mockInput } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const draft = createDraftState(
		{
			...createConfig(),
			outputDir: undefined,
		},
		{
			notionTokenStored: false,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		},
	);
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		draft,
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		{ id: "output", selectedIndex: 0 },
		createOutputCustomRoute(draft),
	];
	(tui as any).refreshView();

	await mockInput.typeText("./notes");
	await renderer.idle();
	expect((tui as any).ui.routes.at(-1)?.value).toBe("./notes");

	tui.destroy();
});

test("interval selection autosaves and returns to the schedule page", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		{ id: "schedule", selectedIndex: 0 },
		createIntervalRoute("gmail"),
	];
	(tui as any).ui.routes.at(-1).selectedIndex = 4;

	await (tui as any).activateCurrentSelection();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("schedule");
	expect(getDefaultIntegration(draft.config, "gmail").interval).toBe("24h");
	expect(getDefaultIntegration(readConfigFile(paths), "gmail").interval).toBe(
		"24h",
	);

	tui.destroy();
});

test("gmail inbox filter selection autosaves and returns to the connector page", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("gmail"),
		createGmailFilterRoute(),
	];
	(tui as any).ui.routes.at(-1).selectedIndex = 1;

	await (tui as any).activateCurrentSelection();

	const updatedDraftIntegration = getDefaultIntegration(draft.config, "gmail");
	const persistedIntegration = getDefaultIntegration(
		readConfigFile(paths),
		"gmail",
	);
	if (
		updatedDraftIntegration.connectorId !== "gmail" ||
		persistedIntegration.connectorId !== "gmail"
	) {
		throw new Error("expected gmail integration");
	}

	expect((tui as any).ui.routes.at(-1)?.id).toBe("connectorDetails");
	expect(updatedDraftIntegration.config.syncFilter).toBe("primary-important");
	expect(persistedIntegration.config.syncFilter).toBe("primary-important");
	expect((tui as any).ui.notice?.text).toBe(
		"Gmail inbox filter saved. Run Gmail again to apply the new scope.",
	);

	tui.destroy();
});

test("google calendar selection route loads calendars and saves selected ids", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore(
		new Map([
			[
				getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientId,
				"client-id",
			],
			[
				getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientSecret,
				"client-secret",
			],
			[
				getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID)
					.refreshToken,
				"refresh-token",
			],
		]),
	);
	const draft = createDraftState(createConfig(), {
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		{
			...createDefaultAuthService(),
			async listGoogleCalendars() {
				return [
					{ id: "primary", summary: "Primary", primary: true },
					{ id: "work@example.com", summary: "Work" },
				];
			},
		},
	);

	(tui as any).ui.routes = [createConnectorDetailsRoute("google-calendar")];
	(tui as any).ui.routes.at(-1).selectedIndex = 2;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).id).toBe("googleCalendarSelection");
	expect((tui as any).ui.routes.at(-1).calendars).toHaveLength(2);

	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).selectedCalendarIds).toEqual([
		"primary",
	]);

	(tui as any).ui.routes.at(-1).selectedIndex = 2;
	await (tui as any).activateCurrentSelection();

	const googleCalendar = getDefaultIntegration(
		(tui as any).draft.config,
		"google-calendar",
	);
	if (googleCalendar.connectorId !== "google-calendar") {
		throw new Error("expected google calendar integration");
	}
	expect(googleCalendar.config.selectedCalendarIds).toEqual(["primary"]);
	expect((tui as any).ui.routes.at(-1).id).toBe("connectorDetails");
	expect((tui as any).ui.notice?.text).toBe("Google Calendar selection saved.");

	tui.destroy();
});

test("enabling Google Calendar starts Google login immediately when scopes need an upgrade", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore(
		new Map([
			[
				getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientId,
				"client-id",
			],
			[
				getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientSecret,
				"client-secret",
			],
			[
				getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID)
					.refreshToken,
				"old-refresh-token",
			],
		]),
	);
	const config = createConfig();
	getDefaultIntegration(config, "gmail").enabled = true;
	const draft = createDraftState(config, {
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	let googleSetupOpenCalls = 0;
	const startGoogleSessionCalls: Array<{
		clientId: string;
		clientSecret: string;
		scopes: string[];
	}> = [];
	const validateCalls: Array<{
		refreshToken: string;
		requiredScopes: readonly string[];
	}> = [];
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		{
			...createDefaultAuthService(),
			async startGoogleSession(
				clientId,
				clientSecret,
				scopes,
			): Promise<GoogleAuthSession> {
				startGoogleSessionCalls.push({ clientId, clientSecret, scopes });
				return {
					authorizationUrl: "https://accounts.example/auth",
					browserOpened: true,
					async complete() {
						return { refreshToken: "new-refresh-token" };
					},
					async cancel() {},
				};
			},
			async openGoogleOAuthSetup() {
				googleSetupOpenCalls += 1;
				return { opened: true };
			},
			async validateGoogleCredentials(_paths, credentials, requiredScopes) {
				validateCalls.push({
					refreshToken: credentials.refreshToken,
					requiredScopes,
				});
				if (credentials.refreshToken === "old-refresh-token") {
					throw new Error(
						"Google account is missing required scopes: https://www.googleapis.com/auth/calendar.readonly",
					);
				}
			},
			async listGoogleCalendars(credentials) {
				expect(credentials.refreshToken).toBe("new-refresh-token");
				return [{ id: "primary", summary: "Primary", primary: true }];
			},
		},
	);

	(tui as any).ui.routes = [createConnectorDetailsRoute("google-calendar")];

	await (tui as any).activateCurrentSelection();

	expect(googleSetupOpenCalls).toBe(0);
	expect(startGoogleSessionCalls).toEqual([
		{
			clientId: "client-id",
			clientSecret: "client-secret",
			scopes: [
				"https://www.googleapis.com/auth/calendar.readonly",
				"https://www.googleapis.com/auth/gmail.readonly",
			],
		},
	]);
	expect(validateCalls).toEqual([
		{
			refreshToken: "old-refresh-token",
			requiredScopes: [
				"https://www.googleapis.com/auth/calendar.readonly",
				"https://www.googleapis.com/auth/gmail.readonly",
			],
		},
		{
			refreshToken: "new-refresh-token",
			requiredScopes: [
				"https://www.googleapis.com/auth/calendar.readonly",
				"https://www.googleapis.com/auth/gmail.readonly",
			],
		},
	]);
	expect((tui as any).ui.routes.at(-1).id).toBe("googleCalendarSelection");
	expect((tui as any).ui.routes.at(-1).calendars).toEqual([
		{ id: "primary", summary: "Primary", primary: true },
	]);
	expect(
		await secrets.store.getSecret(
			getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID).refreshToken,
			paths,
		),
	).toBe("new-refresh-token");

	tui.destroy();
});

test("enabling Gmail reconnects immediately when Google setup is incomplete", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore(
		new Map([
			[
				getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientId,
				"client-id",
			],
			[
				getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientSecret,
				"client-secret",
			],
		]),
	);
	const draft = createDraftState(createConfig(), {
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: false,
	});
	const startGoogleSessionCalls: Array<{
		clientId: string;
		clientSecret: string;
		scopes: string[];
	}> = [];
	let validateCalls = 0;
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		{
			...createDefaultAuthService(),
			async startGoogleSession(
				clientId,
				clientSecret,
				scopes,
			): Promise<GoogleAuthSession> {
				startGoogleSessionCalls.push({ clientId, clientSecret, scopes });
				return {
					authorizationUrl: "https://accounts.example/auth",
					browserOpened: true,
					async complete() {
						return { refreshToken: "new-refresh-token" };
					},
					async cancel() {},
				};
			},
			async validateGoogleCredentials() {
				validateCalls += 1;
			},
		},
	);

	(tui as any).ui.routes = [createConnectorDetailsRoute("gmail")];

	await (tui as any).activateCurrentSelection();

	expect(validateCalls).toBe(1);
	expect(startGoogleSessionCalls).toEqual([
		{
			clientId: "client-id",
			clientSecret: "client-secret",
			scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
		},
	]);
	expect(
		getDefaultIntegration((tui as any).draft.config, "gmail").enabled,
	).toBe(true);
	expect(
		await secrets.store.getSecret(
			getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID).refreshToken,
			paths,
		),
	).toBe("new-refresh-token");
	expect((tui as any).ui.notice?.text).toBe("Gmail enabled.");

	tui.destroy();
});

test("disconnect confirmation persists immediately", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore(
		new Map([["connections.notion-token-default.token", "secret-token"]]),
	);
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("notion"),
		createConfirmDisconnectRoute("notion", "connector"),
	];
	(tui as any).ui.routes.at(-1).selectedIndex = 1;

	await (tui as any).activateCurrentSelection();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("connectorDetails");
	expect(getDefaultIntegration(draft.config, "notion").enabled).toBe(false);
	expect(secrets.deleteCalls).toEqual([
		"connections.notion-token-default.token",
	]);
	expect(
		await secrets.store.getSecret(
			"connections.notion-token-default.token",
			paths,
		),
	).toBeNull();

	tui.destroy();
});

test("notion auth flow validates and saves immediately", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			throw new Error("unused");
		},
		async validateNotionToken(_paths, token) {
			expect(token).toBe("secret-token");
		},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("notion"),
		createConnectorAuthRoute("notion"),
	];

	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).stage).toBe("collect-input");

	(tui as any).ui.routes.at(-1).inputValue = "secret-token";
	await (tui as any).submitInput();

	expect(getDefaultIntegration(draft.config, "notion").enabled).toBe(true);
	expect((tui as any).ui.routes.at(-1).stage).toBe("success");
	expect(
		await secrets.store.getSecret(
			"connections.notion-token-default.token",
			paths,
		),
	).toBe("secret-token");
	expect(getDefaultIntegration(readConfigFile(paths), "notion").enabled).toBe(
		true,
	);

	tui.destroy();
});

test("selecting notion oauth enters the intro screen before setup", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		notionOauthClientIdStored: false,
		notionOauthClientSecretStored: false,
		notionOauthRefreshTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	let notionSetupOpenCalls = 0;
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			notionSetupOpenCalls += 1;
			return {
				opened: false,
				error: "open failed",
			};
		},
		async openGoogleOAuthSetup() {
			throw new Error("unused");
		},
		async validateNotionToken() {
			throw new Error("unused");
		},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [createConnectorDetailsRoute("notion")];
	(tui as any).ui.routes[0].selectedIndex = 1;

	await (tui as any).activateCurrentSelection();

	const route = (tui as any).ui.routes.at(-1);
	expect(notionSetupOpenCalls).toBe(0);
	expect(route.id).toBe("connectorAuth");
	expect(route.authMethod).toBe("notion-oauth");
	expect(String(route.stage)).toBe("intro");
	expect(route.browserOpened).toBeUndefined();
	expect(route.browserError).toBeUndefined();

	tui.destroy();
});

test("notion oauth flow validates and saves immediately", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		notionOauthClientIdStored: false,
		notionOauthClientSecretStored: false,
		notionOauthRefreshTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession(clientId, clientSecret) {
			expect(clientId).toBe("notion-client-id");
			expect(clientSecret).toBe("notion-client-secret");
			return {
				authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
				browserOpened: true,
				async complete() {
					return {
						accessToken: "notion-access-token",
						refreshToken: "notion-refresh-token",
						workspaceId: "workspace-1",
						workspaceName: "Team Space",
					};
				},
				async cancel() {},
			};
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			return { opened: true };
		},
		async openGoogleOAuthSetup() {
			throw new Error("unused");
		},
		async validateNotionToken() {
			throw new Error("unused");
		},
		async validateNotionOAuthAccessToken(_paths, accessToken) {
			expect(accessToken).toBe("notion-access-token");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("notion"),
		createConnectorAuthRoute("notion", "notion-oauth"),
	];

	(tui as any).ui.routes.at(-1).selectedIndex = 1;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).stage).toBe("collect-input");

	(tui as any).ui.routes.at(-1).inputValue = "notion-client-id";
	await (tui as any).submitInput();
	expect((tui as any).ui.routes.at(-1).fieldIndex).toBe(1);

	(tui as any).ui.routes.at(-1).inputValue = "notion-client-secret";
	await (tui as any).submitInput();

	expect(getDefaultIntegration(draft.config, "notion").connectionId).toBe(
		"notion-oauth-default",
	);
	expect((tui as any).ui.routes.at(-1).stage).toBe("success");
	expect(
		await secrets.store.getSecret(
			"oauthApps.notion-oauth-app-default.clientId",
			paths,
		),
	).toBe("notion-client-id");
	expect(
		await secrets.store.getSecret(
			"oauthApps.notion-oauth-app-default.clientSecret",
			paths,
		),
	).toBe("notion-client-secret");
	expect(
		await secrets.store.getSecret(
			"connections.notion-oauth-default.refreshToken",
			paths,
		),
	).toBe("notion-refresh-token");

	tui.destroy();
});

test("gmail auth flow validates and saves immediately", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const secrets = createSecretsStore();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(
			clientId,
			clientSecret,
		): Promise<GoogleAuthSession> {
			expect(clientId).toBe("client-id");
			expect(clientSecret).toBe("client-secret");
			return {
				authorizationUrl: "https://accounts.example/auth",
				browserOpened: true,
				async complete() {
					return { refreshToken: "refresh-token" };
				},
				async cancel() {},
			};
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			return { opened: true };
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials(_paths, credentials) {
			expect(credentials).toEqual({
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "refresh-token",
			});
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("gmail"),
		createConnectorAuthRoute("gmail"),
	];

	(tui as any).ui.routes.at(-1).selectedIndex = 1;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).stage).toBe("collect-input");

	(tui as any).ui.routes.at(-1).inputValue = "client-id";
	await (tui as any).submitInput();
	expect((tui as any).ui.routes.at(-1).fieldIndex).toBe(1);

	(tui as any).ui.routes.at(-1).inputValue = "client-secret";
	await (tui as any).submitInput();

	expect(getDefaultIntegration(draft.config, "gmail").enabled).toBe(true);
	expect((tui as any).ui.routes.at(-1).stage).toBe("success");
	expect(
		await secrets.store.getSecret(
			"connections.google-account-default.refreshToken",
			paths,
		),
	).toBe("refresh-token");
	expect(getDefaultIntegration(readConfigFile(paths), "gmail").enabled).toBe(
		true,
	);

	tui.destroy();
});

test("selecting gmail connect enters the oauth intro screen", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	let googleSetupOpenCalls = 0;
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			googleSetupOpenCalls += 1;
			return { opened: true };
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [createConnectorDetailsRoute("gmail")];

	await (tui as any).activateCurrentSelection();

	const route = (tui as any).ui.routes.at(-1);
	expect(googleSetupOpenCalls).toBe(0);
	expect(route.id).toBe("connectorAuth");
	expect(route.authMethod).toBe("google-oauth");
	expect(String(route.stage)).toBe("intro");
	expect(route.browserOpened).toBeUndefined();
	expect(route.browserError).toBeUndefined();

	tui.destroy();
});

test("gmail auth input submits on enter", async () => {
	const { renderer, mockInput } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const paths = createPaths();
	const secrets = createSecretsStore();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(
			clientId,
			clientSecret,
		): Promise<GoogleAuthSession> {
			expect(clientId).toBe("client-id");
			expect(clientSecret).toBe("client-secret");
			return {
				authorizationUrl: "https://accounts.example/auth",
				browserOpened: true,
				async complete() {
					return { refreshToken: "refresh-token" };
				},
				async cancel() {},
			};
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			return { opened: true };
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials(_paths, credentials) {
			expect(credentials).toEqual({
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "refresh-token",
			});
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: secrets.store,
			session: createSessionStub().session,
		},
		paths,
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("gmail"),
		createConnectorAuthRoute("gmail"),
	];

	(tui as any).ui.routes.at(-1).selectedIndex = 1;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).stage).toBe("collect-input");

	await mockInput.typeText("client-id");
	await renderer.idle();
	mockInput.pressEnter();
	await renderer.idle();
	expect((tui as any).ui.routes.at(-1).fieldIndex).toBe(1);

	await mockInput.typeText("client-secret");
	await renderer.idle();
	mockInput.pressEnter();
	await renderer.idle();

	expect(getDefaultIntegration(draft.config, "gmail").enabled).toBe(true);
	expect((tui as any).ui.routes.at(-1).stage).toBe("success");
	expect(
		await secrets.store.getSecret(
			"connections.google-account-default.refreshToken",
			paths,
		),
	).toBe("refresh-token");

	tui.destroy();
});

test("retrying oauth keeps the user on collect-input without reopening setup pages", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	let googleSetupOpenCalls = 0;
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			googleSetupOpenCalls += 1;
			return { opened: true };
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: false,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		authService,
	);

	const route = createConnectorAuthRoute("gmail");
	route.stage = "error";
	route.error = "failed";
	route.values.googleClientId = "client-id";
	route.browserOpened = false;
	route.browserError = "open failed";
	(tui as any).ui.routes = [createConnectorDetailsRoute("gmail"), route];

	await (tui as any).retryAuthFlow(route);

	expect(String(route.stage)).toBe("collect-input");
	expect(route.inputValue).toBe("client-id");
	expect(route.browserOpened).toBeUndefined();
	expect(route.browserError).toBeNull();
	expect(googleSetupOpenCalls).toBe(0);

	tui.destroy();
});

test("oauth intro can open connector docs without leaving the intro screen", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const openedUrls: string[] = [];
	const authService: TuiAuthService = {
		async openUrl(url) {
			openedUrls.push(url);
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			throw new Error("unused");
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			docsBaseUrl: DOCS_BASE_URL,
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: false,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		authService,
	);

	const route = createConnectorAuthRoute("gmail");
	(tui as any).ui.routes = [createConnectorDetailsRoute("gmail"), route];

	await (tui as any).activateCurrentSelection();

	expect(openedUrls).toEqual([getConnectorAuthDocsUrl(route, DOCS_BASE_URL)!]);
	expect(route.stage).toBe("intro");
	expect((tui as any).ui.notice).toEqual({
		kind: "success",
		text: "Connector docs opened in your browser.",
	});

	tui.destroy();
});

test("persistence failures keep the user on the same page with an inline error", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		{
			...paths,
			configPath: paths.configDir,
		},
		draft,
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		{ id: "output", selectedIndex: 0 },
		createOutputCustomRoute(draft),
	];
	(tui as any).ui.routes.at(-1).value = "./broken";

	await (tui as any).submitInput();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("outputCustom");
	expect((tui as any).ui.notice.kind).toBe("error");

	tui.destroy();
});

test("auth validation failures keep the user on the auth page with an inline error", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const authService: TuiAuthService = {
		async openUrl() {
			return { opened: true };
		},
		async startGoogleSession(): Promise<GoogleAuthSession> {
			throw new Error("unused");
		},
		async startNotionOAuthSession() {
			throw new Error("unused");
		},
		async openNotionSetup() {
			return { opened: true };
		},
		async openNotionOAuthSetup() {
			throw new Error("unused");
		},
		async openGoogleOAuthSetup() {
			throw new Error("unused");
		},
		async validateNotionToken() {
			throw new Error("Token rejected");
		},
		async validateNotionOAuthAccessToken() {
			throw new Error("unused");
		},
		async validateGoogleCredentials() {
			throw new Error("unused");
		},
	};
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		draft,
		renderer,
		authService,
	);

	(tui as any).ui.routes = [
		createConnectorDetailsRoute("notion"),
		createConnectorAuthRoute("notion"),
	];
	await (tui as any).activateCurrentSelection();

	(tui as any).ui.routes.at(-1).inputValue = "bad-token";
	await (tui as any).submitInput();

	expect((tui as any).ui.routes.at(-1)?.id).toBe("connectorAuth");
	expect((tui as any).ui.routes.at(-1).stage).toBe("collect-input");
	expect((tui as any).ui.routes.at(-1).error).toBe("Token rejected");
	expect((tui as any).ui.notice.kind).toBe("error");

	tui.destroy();
});

test("diagnostics is reached through Advanced and loads doctor output", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: createSessionStub().session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes[0].selectedIndex = 4;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("advanced");

	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1)?.id).toBe("diagnostics");
	expect((tui as any).ui.routes.at(-1).body).toContain("doctor ok");

	tui.destroy();
});

test("sync dashboard can start watch and run actions", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const session = createSessionStub();
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		createSyncDashboardRoute(session.session.getSnapshot()),
	];
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).snapshot.watch.active).toBe(false);
	expect(session.runCalls).toEqual([
		{ target: { kind: "all" }, options: undefined },
	]);

	(tui as any).ui.routes.at(-1).selectedIndex = 2;
	await (tui as any).activateCurrentSelection();
	expect(session.runCalls.at(-1)).toEqual({
		target: {
			kind: "integration",
			integrationId: getDefaultIntegration((tui as any).draft.config, "notion")
				.id,
		},
		options: undefined,
	});

	(tui as any).ui.routes.at(-1).selectedIndex = 3;
	await (tui as any).activateCurrentSelection();
	expect(session.runCalls.at(-1)).toEqual({
		target: { kind: "all" },
		options: { resetState: true },
	});

	(tui as any).ui.routes.at(-1).selectedIndex = 4;
	await (tui as any).activateCurrentSelection();
	expect(session.runCalls.at(-1)).toEqual({
		target: {
			kind: "integration",
			integrationId: getDefaultIntegration((tui as any).draft.config, "notion")
				.id,
		},
		options: { resetState: true },
	});

	(tui as any).ui.routes.at(-1).selectedIndex = 1;
	await (tui as any).activateCurrentSelection();
	expect((tui as any).ui.routes.at(-1).snapshot.watch.active).toBe(true);

	tui.destroy();
});

test("sync dashboard can cancel an active run while the start action is still busy", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const session = createSessionStub();
	let resolveRunNow = () => {};

	session.session.runNow = async (target, options) => {
		session.runCalls.push({ target, options });
		await new Promise<void>((resolve) => {
			resolveRunNow = () => resolve();
		});
	};

	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		createSyncDashboardRoute(session.session.getSnapshot()),
	];

	const runPromise = (tui as any).activateCurrentSelection();
	await Promise.resolve();
	expect((tui as any).ui.routes.at(-1).busy).toBe(true);

	session.pushSnapshot(
		createSyncSnapshot({
			status: "running",
			integrations: [
				{
					id: NOTION_INTEGRATION_ID,
					connectorId: "notion",
					connectionId: "notion-token-default",
					label: "Notion",
					enabled: true,
					interval: "1h",
					status: "running",
					running: true,
					queuedImmediateRun: false,
					lastStartedAt: "2026-03-17T00:00:00.000Z",
					lastFinishedAt: null,
					lastSuccessAt: null,
					lastError: null,
					lastDocumentsWritten: 0,
					nextRunAt: null,
					progress: null,
				},
			],
		}),
	);

	expect(
		getRouteOptions((tui as any).ui.routes.at(-1), (tui as any).draft).map(
			(option) => option.name,
		),
	).toEqual(["Stop sync"]);

	await (tui as any).activateCurrentSelection();
	expect(session.cancelCalls).toBe(1);
	expect((tui as any).ui.routes.at(-1).busy).toBe(true);
	expect((tui as any).ui.notice).toEqual({
		kind: "success",
		text: "Cancelling sync...",
	});
	await (tui as any).handleBack();
	expect((tui as any).ui.routes.at(-1).id).toBe("syncDashboard");
	expect((tui as any).ui.notice).toEqual({
		kind: "error",
		text: "Stop the current sync before leaving the sync dashboard.",
	});

	resolveRunNow();
	await runPromise;
	expect((tui as any).ui.routes.at(-1).busy).toBe(false);
	expect((tui as any).ui.notice).toEqual({
		kind: "success",
		text: "Sync cancelled.",
	});

	tui.destroy();
});

test("sync dashboard renders compact cards and progress at 100x30", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 100,
		height: 30,
	});
	const session = createSessionStub(
		createSyncSnapshot({
			status: "running",
			lastRunExitCode: 0,
			lastRunFinishedAt: "2026-03-17T00:10:00.000Z",
			integrations: [
				{
					id: NOTION_INTEGRATION_ID,
					connectorId: "notion",
					connectionId: "notion-token-default",
					label: "Notion",
					enabled: true,
					interval: "1h",
					status: "running",
					running: true,
					queuedImmediateRun: false,
					lastStartedAt: "2026-03-17T00:00:00.000Z",
					lastFinishedAt: null,
					lastSuccessAt: "2026-03-16T23:45:00.000Z",
					lastError: null,
					lastDocumentsWritten: 4,
					nextRunAt: null,
					progress: {
						mode: "determinate",
						phase: "Syncing pages",
						detail: "saved 4 | skipped 0 | failed 0",
						completed: 4,
						total: 7,
						unit: "pages",
					},
				},
			],
			logs: [
				{
					timestamp: "2026-03-17T00:08:00.000Z",
					level: "info",
					message: "Integration start: Notion",
					connectorId: "notion",
					integrationId: NOTION_INTEGRATION_ID,
					integrationLabel: "Notion",
				},
			],
		}),
	);
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		createSyncDashboardRoute(session.session.getSnapshot()),
	];
	(tui as any).refreshView();
	await renderOnce();
	const frame = captureCharFrame();

	expect(frame).toContain("RUNNING | watch off | last ok");
	expect(frame).toContain("Notion [RUNNING] Syncing pages");
	expect(frame).toContain("57% 4/7 pages");
	expect(frame).toContain("Recent activity");
	expect(frame).toContain("Stop sync");
	expect(frame).not.toContain("Stop the current sync");

	tui.destroy();
});

test("sync dashboard renders raw log and compact actions at 80x24", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 80,
		height: 24,
	});
	const session = createSessionStub(
		createSyncSnapshot({
			status: "running",
			integrations: [
				{
					id: GMAIL_INTEGRATION_ID,
					connectorId: "gmail",
					connectionId: "google-account-default",
					label: "Gmail",
					enabled: true,
					interval: "15m",
					status: "running",
					running: true,
					queuedImmediateRun: false,
					lastStartedAt: "2026-03-17T00:00:00.000Z",
					lastFinishedAt: null,
					lastSuccessAt: "2026-03-16T23:30:00.000Z",
					lastError: null,
					lastDocumentsWritten: 12,
					nextRunAt: null,
					progress: {
						mode: "indeterminate",
						phase: "Scanning inbox",
						detail: "processed 12 | concurrency 10",
						completed: null,
						total: null,
						unit: "messages",
					},
				},
			],
			logs: [
				{
					timestamp: "2026-03-17T00:08:00.000Z",
					level: "info",
					message: "Gmail progress: streaming inbox scan concurrency=10",
					connectorId: "gmail",
					integrationId: GMAIL_INTEGRATION_ID,
					integrationLabel: "Gmail",
				},
			],
		}),
	);
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: true,
			googleClientSecretStored: true,
			googleRefreshTokenStored: true,
		}),
		renderer,
		createDefaultAuthService(),
	);

	const route = createSyncDashboardRoute(session.session.getSnapshot());
	route.showDetailedLogs = true;
	(tui as any).ui.routes = [route];
	(tui as any).refreshView();
	await renderOnce();
	const frame = captureCharFrame();

	expect(frame).toContain("Gmail [RUNNING] Scanning inbox");
	expect(frame).toContain("Raw log");
	expect(frame).toContain("processed 12 | concurrency 10");
	expect(frame).toContain("Stop sync");
	expect(frame).not.toContain("Stop the current sync");

	tui.destroy();
});

test("sync dashboard summarizes gmail inbox scan activity in compact mode", async () => {
	const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
		width: 80,
		height: 24,
	});
	const session = createSessionStub(
		createSyncSnapshot({
			status: "running",
			integrations: [
				{
					id: GMAIL_INTEGRATION_ID,
					connectorId: "gmail",
					connectionId: "google-account-default",
					label: "Gmail",
					enabled: true,
					interval: "15m",
					status: "running",
					running: true,
					queuedImmediateRun: false,
					lastStartedAt: "2026-03-17T00:00:00.000Z",
					lastFinishedAt: null,
					lastSuccessAt: "2026-03-16T23:30:00.000Z",
					lastError: null,
					lastDocumentsWritten: 12,
					nextRunAt: null,
					progress: null,
				},
			],
			logs: [
				{
					timestamp: "2026-03-17T00:08:00.000Z",
					level: "info",
					message: "Gmail progress: streaming inbox scan concurrency=10",
					connectorId: "gmail",
					integrationId: GMAIL_INTEGRATION_ID,
					integrationLabel: "Gmail",
				},
			],
		}),
	);
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: true,
			googleClientSecretStored: true,
			googleRefreshTokenStored: true,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		createSyncDashboardRoute(session.session.getSnapshot()),
	];
	(tui as any).refreshView();
	await renderOnce();
	const frame = captureCharFrame();

	expect(frame).toContain("Gmail [RUNNING] Scanning inbox for the first sync");
	expect(frame).toContain("Recent activity");
	expect(frame).toContain("Scanning inbox for the first sync");

	tui.destroy();
});

test("watch-active sync dashboard blocks back navigation", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const session = createSessionStub(
		createSyncSnapshot({
			status: "watching",
			watch: {
				active: true,
				strategy: { kind: "per-integration" },
				startedAt: "2026-03-17T00:00:00.000Z",
			},
		}),
	);
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		{ id: "home", selectedIndex: 0 },
		createSyncDashboardRoute(session.session.getSnapshot()),
	];
	await (tui as any).handleBack();
	expect((tui as any).ui.routes.at(-1).id).toBe("syncDashboard");
	expect((tui as any).ui.notice.kind).toBe("error");

	tui.destroy();
});

test("running sync dashboard blocks back navigation and requires cancel before leaving", async () => {
	const { renderer } = await createTestRenderer({ width: 100, height: 30 });
	const session = createSessionStub(
		createSyncSnapshot({
			status: "running",
			integrations: [
				{
					id: NOTION_INTEGRATION_ID,
					connectorId: "notion",
					connectionId: "notion-token-default",
					label: "Notion",
					enabled: true,
					interval: "1h",
					status: "running",
					running: true,
					queuedImmediateRun: false,
					lastStartedAt: "2026-03-17T00:00:00.000Z",
					lastFinishedAt: null,
					lastSuccessAt: null,
					lastError: null,
					lastDocumentsWritten: 0,
					nextRunAt: null,
					progress: null,
				},
			],
		}),
	);
	const tui = await ConfigTuiApp.create(
		{
			app: createApp(),
			io: createIo(),
			secrets: createSecretsStore().store,
			session: session.session,
		},
		createPaths(),
		createDraftState(createConfig(), {
			notionTokenStored: true,
			googleClientIdStored: false,
			googleClientSecretStored: false,
			googleRefreshTokenStored: false,
		}),
		renderer,
		createDefaultAuthService(),
	);

	(tui as any).ui.routes = [
		{ id: "home", selectedIndex: 0 },
		createSyncDashboardRoute(session.session.getSnapshot()),
	];
	expect(
		getRouteOptions((tui as any).ui.routes.at(-1), (tui as any).draft).map(
			(option) => option.name,
		),
	).toEqual(["Stop sync"]);

	await (tui as any).handleBack();
	expect((tui as any).ui.routes.at(-1).id).toBe("syncDashboard");
	expect((tui as any).ui.notice.kind).toBe("error");

	await (tui as any).activateCurrentSelection();
	expect(session.cancelCalls).toBe(1);

	await (tui as any).handleBack();
	expect((tui as any).ui.routes.at(-1).id).toBe("home");

	tui.destroy();
});
