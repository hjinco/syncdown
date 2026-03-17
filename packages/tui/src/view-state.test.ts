import { expect, test } from "bun:test";

import {
	type AppPaths,
	createDefaultConfig,
	getDefaultIntegration,
	type SyncdownConfig,
	type SyncRuntimeSnapshot,
} from "@syncdown/core";
import { createDraftState } from "./state.js";
import {
	createConfigUiState,
	createConnectorAuthRoute,
	createConnectorDetailsRoute,
	createDiagnosticsRoute,
	createGmailFilterRoute,
	createIntervalRoute,
	createOutputCustomRoute,
	createSyncDashboardRoute,
	getBreadcrumb,
	getConnectorAuthDocsUrl,
	getCurrentAuthField,
	getCurrentRoute,
	getInputProps,
	getRouteBody,
	getRouteOptions,
	isInputRoute,
	popRoute,
	pushRoute,
} from "./view-state.js";

const NOTION_INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const DOCS_BASE_URL = "https://docs.example.com";

function createConfig(): SyncdownConfig {
	const config = createDefaultConfig();
	config.outputDir = "/tmp/output";
	getDefaultIntegration(config, "notion").enabled = true;
	getDefaultIntegration(config, "gmail").enabled = true;
	getDefaultIntegration(config, "gmail").interval = "15m";
	return config;
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
		],
		logs: [],
		...overrides,
	};
}

function createPaths(): AppPaths {
	return {
		configDir: "/tmp/config",
		dataDir: "/tmp/data",
		configPath: "/tmp/config/config.json",
		statePath: "/tmp/data/state.sqlite",
		secretsPath: "/tmp/data/secrets.json",
		masterKeyPath: "/tmp/data/master.key",
		lockPath: "/tmp/data/run.lock",
	};
}

test("view state initializes on the home route", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	const ui = createConfigUiState(createPaths(), draft, "0.1.0", true, null);

	expect(getCurrentRoute(ui).id).toBe("home");
	expect(getBreadcrumb(ui)).toBe("Home");
});

test("home options expose the top-level single-focus sections", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const ui = createConfigUiState(createPaths(), draft, "0.1.0", true, null);

	expect(
		getRouteOptions(getCurrentRoute(ui), draft).map((option) => option.name),
	).toEqual(["Sync", "Connectors", "Output", "Schedule", "Advanced", "Update"]);
});

test("routes push and pop like a page stack", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const ui = createConfigUiState(createPaths(), draft, "0.1.0", true, null);

	pushRoute(ui, { id: "connectors", selectedIndex: 0 });
	pushRoute(ui, createConnectorDetailsRoute("gmail"));
	expect(getBreadcrumb(ui)).toBe("Home / Connectors / Gmail");

	popRoute(ui);
	expect(getCurrentRoute(ui).id).toBe("connectors");
});

test("connector auth route exposes field descriptors and input state", () => {
	const route = createConnectorAuthRoute("gmail");
	route.stage = "collect-input";
	route.fieldIndex = 1;
	route.inputValue = "client-secret";

	expect(getCurrentAuthField(route).label).toBe("Google client secret");
	expect(isInputRoute(route)).toBe(true);
	expect(getInputProps(route)).toEqual({
		value: "client-secret",
		placeholder: "your desktop app client secret",
		secret: true,
	});
});

test("output custom route is treated as input mode", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const route = createOutputCustomRoute(draft);

	expect(isInputRoute(route)).toBe(true);
	expect(getInputProps(route)?.placeholder).toBe("/path/to/output");
});

test("connector detail and output pages render focused body text", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const paths = createPaths();
	const googleCalendar = getDefaultIntegration(draft.config, "google-calendar");
	if (googleCalendar.connectorId !== "google-calendar") {
		throw new Error("expected google calendar integration");
	}
	googleCalendar.config.selectedCalendarIds = ["primary"];

	expect(
		getRouteBody(createConnectorDetailsRoute("notion"), paths, draft),
	).toContain("Status: connected");
	expect(
		getRouteBody(createConnectorDetailsRoute("gmail"), paths, draft),
	).toContain("Inbox filter: Primary only");
	expect(
		getRouteBody(createConnectorDetailsRoute("google-calendar"), paths, draft),
	).toContain("Selected calendars: 1");
	expect(
		getRouteBody({ id: "output", selectedIndex: 0 }, paths, draft),
	).toContain("Current output directory");
	expect(
		getRouteBody({ id: "output", selectedIndex: 0 }, paths, draft),
	).toContain("Syncdown treats this directory as managed output.");
});

test("home body surfaces an available update above the connector summary", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const paths = createPaths();

	const body = getRouteBody(
		{
			id: "home",
			selectedIndex: 0,
			currentVersion: "0.1.0",
			updateStatus: {
				currentVersion: "0.1.0",
				latestVersion: "0.2.0",
				hasUpdate: true,
				canSelfUpdate: true,
				reason: null,
				checkedAt: "2026-03-17T00:00:00.000Z",
			},
			updateError: null,
			updateChecking: false,
			supportsSelfUpdate: true,
			supportReason: null,
		},
		paths,
		draft,
	);

	expect(body).toContain("Update available: v0.2.0");
	expect(body).toContain(
		"Open Update to install or review the latest release.",
	);
	expect(body.indexOf("Update available: v0.2.0")).toBeLessThan(
		body.indexOf("Output: /tmp/output"),
	);
});

test("oauth collect-input body shows setup page status and manual url", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const paths = createPaths();

	const notionRoute = createConnectorAuthRoute("notion", "notion-oauth");
	notionRoute.stage = "collect-input";
	notionRoute.browserOpened = false;
	notionRoute.browserError = "open failed";

	const gmailRoute = createConnectorAuthRoute("gmail");
	gmailRoute.stage = "collect-input";
	gmailRoute.browserOpened = true;

	expect(getRouteBody(notionRoute, paths, draft)).toContain(
		"Browser open failed: open failed",
	);
	expect(getRouteBody(notionRoute, paths, draft)).toContain(
		"https://www.notion.so/profile/integrations",
	);
	expect(getRouteBody(gmailRoute, paths, draft)).toContain(
		"Google OAuth client setup page opened in your browser.",
	);
	expect(getRouteBody(gmailRoute, paths, draft)).toContain(
		"https://console.cloud.google.com/auth/clients",
	);
});

test("oauth intro body explains the flow and links to connector docs", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const paths = createPaths();

	const notionRoute = createConnectorAuthRoute("notion", "notion-oauth");
	const gmailRoute = createConnectorAuthRoute("gmail");
	const calendarRoute = createConnectorAuthRoute("google-calendar");

	expect(getRouteBody(notionRoute, paths, draft, 80, DOCS_BASE_URL)).toContain(
		"OAuth lets you approve access in your browser instead of pasting your account password.",
	);
	expect(getRouteBody(notionRoute, paths, draft, 80, DOCS_BASE_URL)).toContain(
		getConnectorAuthDocsUrl(notionRoute, DOCS_BASE_URL)!,
	);
	expect(getRouteBody(gmailRoute, paths, draft, 80, DOCS_BASE_URL)).toContain(
		getConnectorAuthDocsUrl(gmailRoute, DOCS_BASE_URL)!,
	);
	expect(
		getRouteBody(calendarRoute, paths, draft, 80, DOCS_BASE_URL),
	).toContain(getConnectorAuthDocsUrl(calendarRoute, DOCS_BASE_URL)!);
});

test("oauth intro options expose open docs before continuing", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});

	expect(
		getRouteOptions(
			createConnectorAuthRoute("notion", "notion-oauth"),
			draft,
			DOCS_BASE_URL,
		).map((option) => option.name),
	).toEqual(["Open docs", "Continue", "Cancel"]);
	expect(
		getRouteOptions(
			createConnectorAuthRoute("gmail"),
			draft,
			DOCS_BASE_URL,
		).map((option) => option.name),
	).toEqual(["Open docs", "Continue", "Cancel"]);
	expect(
		getRouteOptions(
			createConnectorAuthRoute("google-calendar"),
			draft,
			DOCS_BASE_URL,
		).map((option) => option.name),
	).toEqual(["Open docs", "Continue", "Cancel"]);
});

test("connected connector hides the connect action in details", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	expect(
		getRouteOptions(createConnectorDetailsRoute("notion"), draft).map(
			(option) => option.name,
		),
	).toEqual(["Connect with Token", "Connect with OAuth", "Disconnect Notion"]);
});

test("disconnected connector with stored credentials still shows both notion auth methods and disconnect", () => {
	const config = createConfig();
	getDefaultIntegration(config, "notion").enabled = false;
	const draft = createDraftState(config, {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	expect(
		getRouteOptions(createConnectorDetailsRoute("notion"), draft).map(
			(option) => option.name,
		),
	).toEqual(["Connect with Token", "Connect with OAuth", "Disconnect Notion"]);
});

test("fully disconnected connector hides the disconnect action but still exposes both notion auth methods", () => {
	const config = createConfig();
	getDefaultIntegration(config, "notion").enabled = false;
	const draft = createDraftState(config, {
		notionTokenStored: false,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	expect(
		getRouteOptions(createConnectorDetailsRoute("notion"), draft).map(
			(option) => option.name,
		),
	).toEqual(["Connect with Token", "Connect with OAuth"]);
});

test("interval and diagnostics routes provide dedicated page content", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const paths = createPaths();

	expect(getRouteBody(createIntervalRoute("gmail"), paths, draft)).toContain(
		"In-process watch:",
	);
	expect(getRouteBody(createGmailFilterRoute(), paths, draft)).toContain(
		"Current filter: Primary only",
	);
	expect(
		getRouteBody(createDiagnosticsRoute(paths, draft), paths, draft),
	).toContain("config: /tmp/config/config.json");
});

test("gmail connector details expose inbox filter settings", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	expect(
		getRouteOptions(createConnectorDetailsRoute("gmail"), draft).map(
			(option) => option.name,
		),
	).toContain("Inbox filter");
	expect(
		getRouteOptions(createGmailFilterRoute(), draft).map(
			(option) => option.name,
		),
	).toEqual(["Primary only", "Primary + Important required"]);
});

test("connectors and schedule expose google calendar", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	expect(
		getRouteOptions({ id: "connectors", selectedIndex: 0 }, draft).map(
			(option) => option.name,
		),
	).toContain("Google Calendar");
	expect(
		getRouteOptions({ id: "schedule", selectedIndex: 0 }, draft).map(
			(option) => option.name,
		),
	).toContain("Google Calendar interval: 1h");
});

test("sync dashboard route renders status summary and actions", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const route = createSyncDashboardRoute(
		createSyncSnapshot({
			watch: {
				active: true,
				strategy: { kind: "per-integration" },
				startedAt: "2026-03-17T00:00:00.000Z",
			},
		}),
	);

	expect(getRouteBody(route, createPaths(), draft)).toContain(
		"watch per-integration",
	);
	expect(getRouteBody(route, createPaths(), draft)).toContain(
		"Recent activity",
	);
	expect(getRouteBody(route, createPaths(), draft)).toContain(
		"Stop sync before leaving this page.",
	);
	expect(getRouteOptions(route, draft).map((option) => option.name)).toEqual([
		"Stop sync",
	]);
});

test("sync dashboard shows only stop when a run is active", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const route = createSyncDashboardRoute(
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

	expect(getRouteBody(route, createPaths(), draft)).toContain(
		"Stop sync before leaving this page.",
	);
	expect(getRouteOptions(route, draft).map((option) => option.name)).toEqual([
		"Stop sync",
	]);
});

test("sync dashboard hides sync actions for connectors that are not connected", () => {
	const config = createConfig();
	getDefaultIntegration(config, "gmail").enabled = false;
	const draft = createDraftState(config, {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});
	const route = createSyncDashboardRoute(createSyncSnapshot());

	expect(getRouteOptions(route, draft).map((option) => option.name)).toEqual([
		"Run all",
		"Start watch",
		"Run Notion",
		"Run all (full resync)",
		"Run Notion (full resync)",
		"Clear log",
		"Show raw log",
	]);
});

test("sync dashboard hides all run actions when nothing is connected", () => {
	const config = createConfig();
	getDefaultIntegration(config, "notion").enabled = false;
	getDefaultIntegration(config, "gmail").enabled = false;
	const draft = createDraftState(config, {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const route = createSyncDashboardRoute(createSyncSnapshot());

	expect(getRouteOptions(route, draft).map((option) => option.name)).toEqual([
		"Clear log",
		"Show raw log",
	]);
});

test("diagnostics entry only appears under Advanced", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	expect(
		getRouteOptions(
			{
				id: "home",
				selectedIndex: 0,
				currentVersion: "0.1.0",
				updateStatus: null,
				updateError: null,
				updateChecking: false,
				supportsSelfUpdate: true,
				supportReason: null,
			},
			draft,
		).map((option) => option.name),
	).not.toContain("Diagnostics");
	expect(
		getRouteOptions({ id: "advanced", selectedIndex: 0 }, draft).map(
			(option) => option.name,
		),
	).toEqual(["Diagnostics"]);
});
