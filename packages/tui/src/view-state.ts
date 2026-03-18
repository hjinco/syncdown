import type {
	AppPaths,
	SyncRuntimeSnapshot,
	UpdateStatus,
} from "@syncdown/core";

import {
	type AuthFieldKey,
	buildOutputPresetPaths,
	buildOverview,
	buildSchedulerHelp,
	buildSyncDashboardBody,
	type ConnectorAuthStage,
	type ConnectorTarget,
	type DraftState,
	detectOutputPreset,
	getConnectorStatus,
	getDraftGmailSyncFilter,
	getDraftInterval,
	getDraftNotionAuthMethod,
	getDraftSelectedGoogleCalendarIds,
	hasAnyStoredCredentials,
	INTERVAL_OPTIONS,
	isDraftConnectorEnabled,
	OUTPUT_PRESET_LABELS,
	type ProviderTarget,
} from "./state.js";

export interface UiSelectOption {
	name: string;
	description: string;
	value?: unknown;
}

export interface UiNotice {
	kind: "error" | "success";
	text: string;
}

interface BaseRoute {
	selectedIndex: number;
}

export interface HomeRoute extends BaseRoute {
	id: "home";
	currentVersion: string;
	updateStatus: UpdateStatus | null;
	updateError: string | null;
	updateChecking: boolean;
	supportsSelfUpdate: boolean;
	supportReason: string | null;
}

export interface ConnectorsRoute extends BaseRoute {
	id: "connectors";
}

export interface SyncDashboardRoute extends BaseRoute {
	id: "syncDashboard";
	snapshot: SyncRuntimeSnapshot;
	clearedAfter: string | null;
	busy: boolean;
	cancelPending: boolean;
	showDetailedLogs: boolean;
}

export interface ConnectorDetailsRoute extends BaseRoute {
	id: "connectorDetails";
	connector: ConnectorTarget;
}

export interface ConnectorAuthRoute extends BaseRoute {
	id: "connectorAuth";
	connector: ConnectorTarget;
	authMethod: "notion-token" | "notion-oauth" | "google-oauth";
	stage: ConnectorAuthStage;
	fieldIndex: number;
	values: Partial<Record<AuthFieldKey, string>>;
	inputValue: string;
	error: string | null;
	authUrl?: string;
	browserOpened?: boolean;
	browserError?: string | null;
}

export interface ConfirmDisconnectRoute extends BaseRoute {
	id: "confirmDisconnect";
	connector: ConnectorTarget;
	mode: "connector" | "provider";
	provider?: ProviderTarget;
}

export interface OutputRoute extends BaseRoute {
	id: "output";
}

export interface OutputCustomRoute extends BaseRoute {
	id: "outputCustom";
	value: string;
	error: string | null;
}

export interface ScheduleRoute extends BaseRoute {
	id: "schedule";
}

export interface IntervalRoute extends BaseRoute {
	id: "interval";
	connector: ConnectorTarget;
}

export interface GmailFilterRoute extends BaseRoute {
	id: "gmailFilter";
}

export interface GoogleCalendarSelectionRoute extends BaseRoute {
	id: "googleCalendarSelection";
	loading: boolean;
	error: string | null;
	selectedCalendarIds: string[];
	calendars: Array<{
		id: string;
		summary: string;
		description?: string;
		primary?: boolean;
	}>;
}

export interface AdvancedRoute extends BaseRoute {
	id: "advanced";
}

export interface UpdateRoute extends BaseRoute {
	id: "update";
	currentVersion: string;
	status: UpdateStatus | null;
	error: string | null;
	checking: boolean;
	installBusy: boolean;
	supportsSelfUpdate: boolean;
	supportReason: string | null;
}

export interface DiagnosticsRoute extends BaseRoute {
	id: "diagnostics";
	loading: boolean;
	title: string;
	body: string;
}

export type ConfigRoute =
	| HomeRoute
	| SyncDashboardRoute
	| ConnectorsRoute
	| ConnectorDetailsRoute
	| ConnectorAuthRoute
	| ConfirmDisconnectRoute
	| OutputRoute
	| OutputCustomRoute
	| ScheduleRoute
	| IntervalRoute
	| GmailFilterRoute
	| GoogleCalendarSelectionRoute
	| AdvancedRoute
	| UpdateRoute
	| DiagnosticsRoute;

export interface ConfigUiState {
	routes: ConfigRoute[];
	notice: UiNotice | null;
	docsBaseUrl: string | null;
}

export interface AuthFieldDescriptor {
	key: AuthFieldKey;
	label: string;
	placeholder: string;
	secret: boolean;
	prompt: string;
}

const NOTION_SETUP_URL = "https://www.notion.so/profile/integrations";
const GOOGLE_OAUTH_SETUP_URL = "https://console.cloud.google.com/auth/clients";
type DocsLocale = "en" | "ko" | "ja" | "zh-CN";

function getDocsLocaleFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): DocsLocale {
	const rawLocale = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
	const normalized = rawLocale.toLowerCase();

	if (normalized.startsWith("ko")) {
		return "ko";
	}

	if (normalized.startsWith("ja")) {
		return "ja";
	}

	if (
		normalized.startsWith("zh-cn") ||
		normalized.startsWith("zh_hans") ||
		normalized.startsWith("zh-hans")
	) {
		return "zh-CN";
	}

	return "en";
}

function getDocsPath(slug: string, locale = getDocsLocaleFromEnv()): string {
	const basePath = `/docs/${slug}`;
	return locale === "en" ? basePath : `/${locale}${basePath}`;
}

function normalizeDocsBaseUrl(
	baseUrl: string | null | undefined,
): string | null {
	if (!baseUrl) {
		return null;
	}

	try {
		return new URL(baseUrl).toString();
	} catch {
		return null;
	}
}

export function getConnectorAuthDocsUrl(
	route: Pick<ConnectorAuthRoute, "connector" | "authMethod">,
	docsBaseUrl: string | null,
): string | null {
	if (route.authMethod === "notion-token") {
		return null;
	}

	const normalizedBaseUrl = normalizeDocsBaseUrl(docsBaseUrl);
	if (!normalizedBaseUrl) {
		return null;
	}

	const docsPath =
		route.connector === "notion"
			? getDocsPath("connectors/notion")
			: route.connector === "gmail"
				? getDocsPath("connectors/gmail")
				: getDocsPath("connectors/google-calendar");

	return new URL(docsPath, normalizedBaseUrl).toString();
}

function getOAuthIntroLines(
	route: ConnectorAuthRoute,
	docsBaseUrl: string | null,
): string[] {
	const docsUrl = getConnectorAuthDocsUrl(route, docsBaseUrl);
	const lines = [
		"OAuth lets you approve access in your browser instead of pasting your account password.",
	];

	if (route.authMethod === "notion-oauth") {
		lines.push(
			"syncdown will ask for your Notion client ID and client secret, then store those values and the refresh token returned after approval in the encrypted local secrets store.",
		);
	} else {
		lines.push(
			"syncdown will ask for your Google client ID and client secret, then store those values and the refresh token returned after approval in the encrypted local secrets store.",
		);
	}

	if (docsUrl) {
		lines.push("");
		lines.push("Read the connector docs before you continue:");
		lines.push(docsUrl);
	}

	return lines;
}

export function createConfigUiState(
	_paths: AppPaths,
	_draft: DraftState,
	currentVersion: string,
	supportsSelfUpdate: boolean,
	supportReason: string | null,
	docsBaseUrl: string | null = null,
): ConfigUiState {
	return {
		routes: [
			{
				id: "home",
				selectedIndex: 0,
				currentVersion,
				updateStatus: null,
				updateError: null,
				updateChecking: false,
				supportsSelfUpdate,
				supportReason,
			},
		],
		notice: null,
		docsBaseUrl: normalizeDocsBaseUrl(docsBaseUrl),
	};
}

export function createSyncDashboardRoute(
	snapshot: SyncRuntimeSnapshot,
): SyncDashboardRoute {
	return {
		id: "syncDashboard",
		selectedIndex: 0,
		snapshot,
		clearedAfter: null,
		busy: false,
		cancelPending: false,
		showDetailedLogs: false,
	};
}

function isSyncDashboardLocked(route: SyncDashboardRoute): boolean {
	return (
		route.snapshot.watch.active ||
		route.snapshot.integrations.some(
			(integration) => integration.running || integration.queuedImmediateRun,
		)
	);
}

export function createConnectorDetailsRoute(
	connector: ConnectorTarget,
): ConnectorDetailsRoute {
	return {
		id: "connectorDetails",
		connector,
		selectedIndex: 0,
	};
}

export function createConnectorAuthRoute(
	connector: ConnectorTarget,
	authMethod?: ConnectorAuthRoute["authMethod"],
): ConnectorAuthRoute {
	return {
		id: "connectorAuth",
		connector,
		authMethod:
			authMethod ?? (connector === "notion" ? "notion-token" : "google-oauth"),
		stage: "intro",
		selectedIndex: 0,
		fieldIndex: 0,
		values: {},
		inputValue: "",
		error: null,
	};
}

export function createConfirmDisconnectRoute(
	connector: ConnectorTarget,
	mode: "connector" | "provider",
	provider?: ProviderTarget,
): ConfirmDisconnectRoute {
	return {
		id: "confirmDisconnect",
		connector,
		mode,
		provider,
		selectedIndex: 0,
	};
}

export function createOutputCustomRoute(draft: DraftState): OutputCustomRoute {
	return {
		id: "outputCustom",
		selectedIndex: 0,
		value: draft.config.outputDir ?? "",
		error: null,
	};
}

export function createIntervalRoute(connector: ConnectorTarget): IntervalRoute {
	return {
		id: "interval",
		connector,
		selectedIndex: 0,
	};
}

export function createGmailFilterRoute(): GmailFilterRoute {
	return {
		id: "gmailFilter",
		selectedIndex: 0,
	};
}

export function createGoogleCalendarSelectionRoute(
	selectedCalendarIds: string[],
): GoogleCalendarSelectionRoute {
	return {
		id: "googleCalendarSelection",
		selectedIndex: 0,
		loading: true,
		error: null,
		selectedCalendarIds: [...selectedCalendarIds],
		calendars: [],
	};
}

export function createUpdateRoute(home: HomeRoute): UpdateRoute {
	return {
		id: "update",
		selectedIndex: 0,
		currentVersion: home.currentVersion,
		status: home.updateStatus,
		error: home.updateError,
		checking: home.updateChecking,
		installBusy: false,
		supportsSelfUpdate: home.supportsSelfUpdate,
		supportReason: home.supportReason,
	};
}

export function createDiagnosticsRoute(
	paths: AppPaths,
	draft: DraftState,
): DiagnosticsRoute {
	return {
		id: "diagnostics",
		selectedIndex: 0,
		loading: false,
		title: "Diagnostics",
		body: buildOverview(paths, draft),
	};
}

export function getCurrentRoute(ui: ConfigUiState): ConfigRoute {
	const route = ui.routes.at(-1);
	if (!route) {
		throw new Error("Missing current route");
	}

	return route;
}

export function pushRoute(ui: ConfigUiState, route: ConfigRoute): void {
	ui.routes.push(route);
	ui.notice = null;
}

export function popRoute(ui: ConfigUiState): void {
	if (ui.routes.length > 1) {
		ui.routes.pop();
	}
	ui.notice = null;
}

export function setNotice(ui: ConfigUiState, notice: UiNotice | null): void {
	ui.notice = notice;
}

export function getAuthFieldDescriptors(
	connector: ConnectorTarget,
): AuthFieldDescriptor[] {
	return connector === "notion"
		? [
				{
					key: "notionToken",
					label: "Notion token",
					placeholder: "secret_...",
					secret: true,
					prompt: "Paste the Notion integration token.",
				},
			]
		: [
				{
					key: "googleClientId",
					label: "Google client ID",
					placeholder: "your desktop app client id",
					secret: false,
					prompt: "Paste the Google Desktop app client ID.",
				},
				{
					key: "googleClientSecret",
					label: "Google client secret",
					placeholder: "your desktop app client secret",
					secret: true,
					prompt: "Paste the Google Desktop app client secret.",
				},
			];
}

function getAuthFieldDescriptorsForMethod(
	route: ConnectorAuthRoute,
): AuthFieldDescriptor[] {
	if (route.authMethod === "notion-token") {
		return [
			{
				key: "notionToken",
				label: "Notion token",
				placeholder: "secret_...",
				secret: true,
				prompt: "Paste the Notion integration token.",
			},
		];
	}

	if (route.authMethod === "notion-oauth") {
		return [
			{
				key: "notionOauthClientId",
				label: "Notion client ID",
				placeholder: "your public integration client id",
				secret: false,
				prompt: "Paste the Notion public integration client ID.",
			},
			{
				key: "notionOauthClientSecret",
				label: "Notion client secret",
				placeholder: "your public integration client secret",
				secret: true,
				prompt: "Paste the Notion public integration client secret.",
			},
		];
	}

	return [
		{
			key: "googleClientId",
			label: "Google client ID",
			placeholder: "your desktop app client id",
			secret: false,
			prompt: "Paste the Google Desktop app client ID.",
		},
		{
			key: "googleClientSecret",
			label: "Google client secret",
			placeholder: "your desktop app client secret",
			secret: true,
			prompt: "Paste the Google Desktop app client secret.",
		},
	];
}

export function getCurrentAuthField(
	route: ConnectorAuthRoute,
): AuthFieldDescriptor {
	const field = getAuthFieldDescriptorsForMethod(route)[route.fieldIndex];
	if (!field) {
		throw new Error("Missing auth field descriptor");
	}

	return field;
}

export function isInputRoute(
	route: ConfigRoute,
): route is ConnectorAuthRoute | OutputCustomRoute {
	return (
		route.id === "outputCustom" ||
		(route.id === "connectorAuth" && route.stage === "collect-input")
	);
}

export function getInputProps(
	route: ConfigRoute,
): { value: string; placeholder: string; secret: boolean } | null {
	if (route.id === "outputCustom") {
		return {
			value: route.value,
			placeholder: "/path/to/output",
			secret: false,
		};
	}

	if (route.id !== "connectorAuth" || route.stage !== "collect-input") {
		return null;
	}

	const field = getCurrentAuthField(route);
	return {
		value: route.inputValue,
		placeholder: field.placeholder,
		secret: field.secret,
	};
}

export function clampRouteSelection(
	route: ConfigRoute,
	draft: DraftState,
	docsBaseUrl: string | null = null,
): void {
	const options = getRouteOptions(route, draft, docsBaseUrl);
	route.selectedIndex = Math.min(
		route.selectedIndex,
		Math.max(options.length - 1, 0),
	);
}

export function getRouteTitle(route: ConfigRoute): string {
	switch (route.id) {
		case "home":
			return "Home";
		case "syncDashboard":
			return "Sync";
		case "connectors":
			return "Connectors";
		case "connectorDetails":
			return route.connector === "notion"
				? "Notion"
				: route.connector === "gmail"
					? "Gmail"
					: "Google Calendar";
		case "connectorAuth":
			return route.authMethod === "notion-token"
				? "Notion Token"
				: route.authMethod === "notion-oauth"
					? "Notion OAuth"
					: "Google Login";
		case "confirmDisconnect":
			if (route.mode === "provider") {
				return "Disconnect Google Account";
			}
			return route.connector === "notion"
				? "Disconnect Notion"
				: "Disable Gmail";
		case "output":
			return "Output";
		case "outputCustom":
			return "Custom Output Path";
		case "schedule":
			return "Schedule";
		case "interval":
			return route.connector === "notion"
				? "Notion Interval"
				: route.connector === "gmail"
					? "Gmail Interval"
					: "Google Calendar Interval";
		case "gmailFilter":
			return "Gmail Inbox Filter";
		case "googleCalendarSelection":
			return "Select Calendars";
		case "advanced":
			return "Advanced";
		case "update":
			return "Update";
		case "diagnostics":
			return route.title;
	}
}

export function getBreadcrumb(ui: ConfigUiState): string {
	return ui.routes.map((route) => getRouteTitle(route)).join(" / ");
}

function getConnectorSummaryLine(
	draft: DraftState,
	connector: ConnectorTarget,
): string {
	const status = getConnectorStatus(draft, connector);
	const base = `${status.label} | ${isDraftConnectorEnabled(draft, connector) ? "enabled" : "disabled"} | every ${getDraftInterval(draft, connector)}`;
	if (connector === "google-calendar") {
		return `${base} | ${getDraftSelectedGoogleCalendarIds(draft).length} selected`;
	}

	return base;
}

function shouldShowDisconnectAction(
	draft: DraftState,
	connector: ConnectorTarget,
): boolean {
	return (
		isDraftConnectorEnabled(draft, connector) ||
		hasAnyStoredCredentials(draft, connector)
	);
}

function getConnectedSyncTargets(draft: DraftState): ConnectorTarget[] {
	return (["notion", "gmail", "google-calendar"] as const).filter(
		(connector) => getConnectorStatus(draft, connector).label === "connected",
	);
}

function formatVersion(version: string): string {
	return version.startsWith("v") ? version : `v${version}`;
}

function getHomeUpdateDescription(route: HomeRoute): string {
	if (route.updateChecking) {
		return "Checking for updates...";
	}

	if (route.updateError) {
		return "Update check failed";
	}

	if (route.updateStatus?.hasUpdate && route.updateStatus.latestVersion) {
		return `New version available: ${formatVersion(route.updateStatus.latestVersion)}`;
	}

	if (!(route.updateStatus?.canSelfUpdate ?? route.supportsSelfUpdate)) {
		return (
			route.updateStatus?.reason ??
			route.supportReason ??
			"Self-update unavailable in source/dev run"
		);
	}

	return `Current: ${formatVersion(route.updateStatus?.currentVersion ?? route.currentVersion)}`;
}

function getHomeUpdateBannerLines(route: HomeRoute): string[] {
	if (!route.updateStatus?.hasUpdate || !route.updateStatus.latestVersion) {
		return [];
	}

	return [
		`Update available: ${formatVersion(route.updateStatus.latestVersion)}`,
		"Open Update to install or review the latest release.",
		"",
	];
}

export function getRouteBody(
	route: ConfigRoute,
	paths: AppPaths,
	draft: DraftState,
	width = 80,
	docsBaseUrl: string | null = null,
): string {
	switch (route.id) {
		case "home":
			return [
				...getHomeUpdateBannerLines(route),
				`Output: ${draft.config.outputDir ?? "<unset>"}`,
				`Notion: ${getConnectorSummaryLine(draft, "notion")}`,
				`Gmail: ${getConnectorSummaryLine(draft, "gmail")}`,
				`Google Calendar: ${getConnectorSummaryLine(draft, "google-calendar")}`,
			].join("\n");
		case "syncDashboard":
			return [
				...(route.busy
					? ["Action in progress...", ""]
					: isSyncDashboardLocked(route)
						? ["Sync is active. Stop sync before leaving this page.", ""]
						: []),
				buildSyncDashboardBody(
					route.snapshot,
					route.clearedAfter,
					route.showDetailedLogs,
					width,
				),
			].join("\n");
		case "connectors":
			return "Select a connector to open its dedicated configuration page.";
		case "connectorDetails": {
			const status = getConnectorStatus(draft, route.connector);
			const credentialLabel =
				route.connector === "gmail"
					? hasAnyStoredCredentials(draft, route.connector)
						? "stored Google account"
						: "missing Google account"
					: hasAnyStoredCredentials(draft, route.connector)
						? `stored ${getDraftNotionAuthMethod(draft) === "oauth" ? "OAuth credentials" : "token"}`
						: "missing";
			return [
				`Status: ${status.label}`,
				status.description,
				"",
				`Enabled: ${isDraftConnectorEnabled(draft, route.connector) ? "yes" : "no"}`,
				`Credentials: ${credentialLabel}`,
				`Sync interval: ${getDraftInterval(draft, route.connector)}`,
				...(route.connector === "gmail"
					? [
							`Inbox filter: ${getDraftGmailSyncFilter(draft) === "primary" ? "Primary only" : "Primary + Important required"}`,
						]
					: route.connector === "google-calendar"
						? [
								`Selected calendars: ${getDraftSelectedGoogleCalendarIds(draft).length}`,
							]
						: []),
			].join("\n");
		}
		case "connectorAuth":
			return getConnectorAuthBody(route, docsBaseUrl);
		case "confirmDisconnect":
			if (route.mode === "provider") {
				return route.provider === "notion"
					? "This will remove the stored Notion OAuth account and disable Notion immediately if it is using OAuth."
					: "This will remove the stored Google account and disable all Google-backed connectors immediately.";
			}
			return route.connector === "notion"
				? "This will disable the connector and remove its stored credentials immediately."
				: "This will disable Gmail but keep the stored Google account.";
		case "output":
			return [
				`Current output directory: ${draft.config.outputDir ?? "<unset>"}`,
				"",
				"Choose a preset or enter a custom path. Changes are written as soon as you confirm them.",
				"",
				"Syncdown treats this directory as managed output.",
				"It is best not to rename, move, or reorganize synced Markdown files or connector folders by hand.",
				"Later syncs or full resyncs may recreate, overwrite, or remove them.",
			].join("\n");
		case "outputCustom":
			return (
				route.error ??
				"Enter an absolute or relative output path. It will be normalized before saving."
			);
		case "schedule":
			return "Choose a connector to change its sync interval.";
		case "interval":
			return buildSchedulerHelp(
				getDraftInterval(draft, route.connector),
				paths,
			);
		case "gmailFilter":
			return [
				"Choose which Gmail inbox messages qualify for sync.",
				"",
				`Current filter: ${getDraftGmailSyncFilter(draft) === "primary" ? "Primary only" : "Primary + Important required"}`,
			].join("\n");
		case "googleCalendarSelection":
			return [
				route.loading
					? "Loading calendars from your Google account..."
					: "Toggle calendars to include in Google Calendar sync, then save.",
				...(route.error ? ["", route.error] : []),
				"",
				`Selected: ${route.selectedCalendarIds.length}`,
			].join("\n");
		case "advanced":
			return [
				"Advanced tools stay out of the main flow.",
				"",
				`Config file: ${paths.configPath}`,
				`Secrets store: ${paths.secretsPath}`,
				`State DB: ${paths.statePath}`,
			].join("\n");
		case "update":
			return [
				route.checking
					? "Checking for updates..."
					: "Install the latest release binary from GitHub Releases.",
				"",
				`Current version: ${formatVersion(route.status?.currentVersion ?? route.currentVersion)}`,
				`Latest version: ${route.status?.latestVersion ? formatVersion(route.status.latestVersion) : route.error ? "check failed" : "unknown"}`,
				`Self-update: ${(route.status?.canSelfUpdate ?? route.supportsSelfUpdate) ? "available" : "unavailable"}`,
				...((route.status?.reason ?? route.supportReason)
					? [`Reason: ${route.status?.reason ?? route.supportReason}`]
					: []),
				...(route.error ? ["", `Last error: ${route.error}`] : []),
			].join("\n");
		case "diagnostics":
			return route.loading ? "Refreshing diagnostics..." : route.body;
	}
}

function getConnectorAuthBody(
	route: ConnectorAuthRoute,
	docsBaseUrl: string | null,
): string {
	if (route.stage === "intro") {
		if (route.authMethod === "notion-token") {
			return "We will open the Notion integrations page, then ask for the token.";
		}

		return getOAuthIntroLines(route, docsBaseUrl).join("\n");
	}

	if (route.stage === "collect-input") {
		const field = getCurrentAuthField(route);
		const lines = [field.prompt];
		if (route.authMethod === "notion-token") {
			lines.push("");
			lines.push(
				route.browserOpened === false && route.browserError
					? `Browser open failed: ${route.browserError}`
					: `If the browser did not open, visit ${NOTION_SETUP_URL} manually.`,
			);
		} else {
			const setupUrl =
				route.authMethod === "notion-oauth"
					? NOTION_SETUP_URL
					: GOOGLE_OAUTH_SETUP_URL;
			const setupPageLabel =
				route.authMethod === "notion-oauth"
					? "Notion integrations page"
					: "Google OAuth client setup page";
			lines.push("");
			if (route.browserOpened === false && route.browserError) {
				lines.push(`Browser open failed: ${route.browserError}`);
			} else if (route.browserOpened === true) {
				lines.push(
					`${setupPageLabel} opened in your browser. Create or review the OAuth app there, then paste the value here.`,
				);
			} else {
				lines.push(
					`Open the ${setupPageLabel} if you need to create or review the OAuth app before pasting the value here.`,
				);
			}
			lines.push("");
			lines.push("If needed, open this URL manually:");
			lines.push(setupUrl);
		}
		if (route.error) {
			lines.unshift(route.error, "");
		}
		return lines.join("\n");
	}

	if (route.stage === "opening-browser") {
		return route.authMethod === "notion-token"
			? "Opening the Notion integrations page in your browser."
			: route.authMethod === "notion-oauth"
				? "Opening the Notion consent screen in your browser."
				: "Opening the Google consent screen in your browser.";
	}

	if (route.stage === "waiting-callback") {
		return [
			route.browserOpened === false && route.browserError
				? `Browser open failed: ${route.browserError}`
				: "Browser open attempted. Finish the Google consent flow in your browser.",
			"",
			"If needed, open this URL manually:",
			route.authUrl ?? "<missing authorization url>",
		].join("\n");
	}

	if (route.stage === "validating") {
		return route.authMethod === "notion-token"
			? "Checking the Notion token before saving it."
			: route.authMethod === "notion-oauth"
				? "Checking the Notion OAuth connection before saving it."
				: "Checking the Google account scopes before saving them.";
	}

	if (route.stage === "success") {
		return route.authMethod === "notion-token"
			? "Notion token credentials have been saved."
			: route.authMethod === "notion-oauth"
				? "Notion OAuth credentials have been saved."
				: "Google account credentials have been saved.";
	}

	return route.error ?? "Unknown authentication failure.";
}

export function getRouteOptions(
	route: ConfigRoute,
	draft: DraftState,
	docsBaseUrl: string | null = null,
): UiSelectOption[] {
	switch (route.id) {
		case "home":
			return [
				{
					name: "Sync",
					description: "Run now, start watch, and inspect recent sync activity",
					value: "sync",
				},
				{
					name: "Connectors",
					description: `${getConnectorStatus(draft, "notion").label} / ${getConnectorStatus(draft, "gmail").label}`,
					value: "connectors",
				},
				{
					name: "Output",
					description:
						draft.config.outputDir ?? "No output directory configured",
					value: "output",
				},
				{
					name: "Schedule",
					description: `Notion ${getDraftInterval(draft, "notion")} | Gmail ${getDraftInterval(draft, "gmail")}`,
					value: "schedule",
				},
				{
					name: "Advanced",
					description: "Diagnostics and system paths",
					value: "advanced",
				},
				{
					name: "Update",
					description: getHomeUpdateDescription(route),
					value: "update",
				},
			];
		case "syncDashboard": {
			if (isSyncDashboardLocked(route)) {
				return [
					{
						name: "Stop sync",
						description: route.snapshot.watch.active
							? "Stop watch mode and the current sync"
							: "Stop the current sync",
						value: "cancelActiveRun",
					},
				];
			}

			const connectedTargets = getConnectedSyncTargets(draft);
			const hasConnectedTargets = connectedTargets.length > 0;

			return [
				...(hasConnectedTargets
					? [
							{
								name: "Run all",
								description: "Run all enabled connectors once",
								value: "runAll",
							},
							{
								name: "Start watch",
								description:
									"Keep syncing with each connector's configured interval",
								value: "startWatch",
							},
						]
					: []),
				...(connectedTargets.includes("notion")
					? [
							{
								name: "Run Notion",
								description: "Run only Notion now",
								value: "runNotion",
							},
						]
					: []),
				...(connectedTargets.includes("gmail")
					? [
							{
								name: "Run Gmail",
								description: "Run only Gmail now",
								value: "runGmail",
							},
						]
					: []),
				...(connectedTargets.includes("google-calendar")
					? [
							{
								name: "Run Google Calendar",
								description: "Run only Google Calendar now",
								value: "runGoogleCalendar",
							},
						]
					: []),
				...(hasConnectedTargets
					? [
							{
								name: "Run all (full resync)",
								description:
									"Reset all enabled integrations before running them once",
								value: "runAllReset",
							},
						]
					: []),
				...(connectedTargets.includes("notion")
					? [
							{
								name: "Run Notion (full resync)",
								description: "Reset Notion state and rerun it from scratch",
								value: "runNotionReset",
							},
						]
					: []),
				...(connectedTargets.includes("gmail")
					? [
							{
								name: "Run Gmail (full resync)",
								description: "Reset Gmail state and rerun it from scratch",
								value: "runGmailReset",
							},
						]
					: []),
				...(connectedTargets.includes("google-calendar")
					? [
							{
								name: "Run Google Calendar (full resync)",
								description:
									"Reset Google Calendar state and rerun it from scratch",
								value: "runGoogleCalendarReset",
							},
						]
					: []),
				{
					name: "Clear log",
					description: "Hide existing log lines in this dashboard view",
					value: "clearLog",
				},
				{
					name: route.showDetailedLogs ? "Hide raw log" : "Show raw log",
					description: route.showDetailedLogs
						? "Switch back to recent activity"
						: "Switch the bottom section to the raw event stream",
					value: "toggleDetailedLogs",
				},
			];
		}
		case "connectors":
			return [
				{
					name: "Notion",
					description: getConnectorSummaryLine(draft, "notion"),
					value: "notion",
				},
				{
					name: "Gmail",
					description: getConnectorSummaryLine(draft, "gmail"),
					value: "gmail",
				},
				{
					name: "Google Calendar",
					description: getConnectorSummaryLine(draft, "google-calendar"),
					value: "google-calendar",
				},
			];
		case "connectorDetails":
			if (
				route.connector === "gmail" ||
				route.connector === "google-calendar"
			) {
				const hasGoogleAccount = hasAnyStoredCredentials(draft, "gmail");
				const connectorEnabled = isDraftConnectorEnabled(
					draft,
					route.connector,
				);
				return [
					...(!hasGoogleAccount
						? [
								{
									name: "Connect Google account",
									description: "Start the browser-based OAuth flow",
									value: "connect",
								} satisfies UiSelectOption,
							]
						: connectorEnabled
							? [
									{
										name: "Reconnect Google account",
										description:
											"Run OAuth again to refresh the shared Google account",
										value: "connect",
									} satisfies UiSelectOption,
								]
							: [
									{
										name:
											route.connector === "gmail"
												? "Enable Gmail"
												: "Enable Google Calendar",
										description:
											"Use the stored Google account without reauthenticating",
										value: "enable",
									} satisfies UiSelectOption,
									{
										name: "Reconnect Google account",
										description:
											"Run OAuth again to refresh the shared Google account",
										value: "connect",
									} satisfies UiSelectOption,
								]),
					...(route.connector === "gmail"
						? [
								{
									name: "Inbox filter",
									description:
										getDraftGmailSyncFilter(draft) === "primary"
											? "Current: Primary only"
											: "Current: Primary + Important required",
									value: "gmailFilter",
								} satisfies UiSelectOption,
							]
						: [
								{
									name: "Select calendars",
									description: `Current: ${getDraftSelectedGoogleCalendarIds(draft).length} selected`,
									value: "googleCalendarSelection",
								} satisfies UiSelectOption,
							]),
					...(connectorEnabled
						? [
								{
									name:
										route.connector === "gmail"
											? "Disable Gmail"
											: "Disable Google Calendar",
									description:
										route.connector === "gmail"
											? "Stop syncing Gmail but keep the stored Google account"
											: "Stop syncing Google Calendar but keep the stored Google account",
									value: "disable",
								} satisfies UiSelectOption,
							]
						: []),
					...(hasGoogleAccount
						? [
								{
									name: "Disconnect Google account",
									description:
										"Remove the stored Google account and disable Google-backed connectors",
									value: "disconnectProvider",
								} satisfies UiSelectOption,
							]
						: []),
				];
			}

			return [
				{
					name: "Connect with Token",
					description:
						getDraftNotionAuthMethod(draft) === "token"
							? "Use the manual token flow"
							: "Switch back to the token flow",
					value: "connectToken",
				},
				{
					name: "Connect with OAuth",
					description:
						getDraftNotionAuthMethod(draft) === "oauth"
							? "Reconnect the Notion OAuth account"
							: "Switch to the OAuth flow",
					value: "connectOAuth",
				},
				...(shouldShowDisconnectAction(draft, route.connector)
					? [
							{
								name: "Disconnect Notion",
								description: hasAnyStoredCredentials(draft, route.connector)
									? "Disable the connector and remove stored credentials"
									: "Disable the connector",
								value: "disconnect",
							} satisfies UiSelectOption,
						]
					: []),
			];
		case "connectorAuth":
			return getAuthOptions(route, docsBaseUrl);
		case "confirmDisconnect":
			return [
				{
					name: route.mode === "provider" ? "Keep account" : "Keep connection",
					description:
						route.mode === "provider"
							? route.provider === "notion"
								? "Return without changing the Notion OAuth account"
								: "Return without changing the Google account"
							: "Return without changing the connector",
					value: "cancel",
				},
				{
					name:
						route.mode === "provider"
							? "Disconnect account"
							: route.connector === "notion"
								? "Disconnect now"
								: "Disable Gmail",
					description:
						route.mode === "provider"
							? route.provider === "notion"
								? "Remove the stored Notion OAuth account immediately"
								: "Remove the shared Google account immediately"
							: route.connector === "notion"
								? "Persist disable and credential removal immediately"
								: "Persist the connector disable immediately",
					value: "disconnect",
				},
			];
		case "output": {
			const presetPaths = buildOutputPresetPaths();
			const detected = detectOutputPreset(draft.config.outputDir);
			return [
				{
					name: `${OUTPUT_PRESET_LABELS.desktop}${detected === "desktop" ? " (current)" : ""}`,
					description: presetPaths.desktop,
					value: "desktop",
				},
				{
					name: `${OUTPUT_PRESET_LABELS.documents}${detected === "documents" ? " (current)" : ""}`,
					description: presetPaths.documents,
					value: "documents",
				},
				{
					name: `${OUTPUT_PRESET_LABELS.downloads}${detected === "downloads" ? " (current)" : ""}`,
					description: presetPaths.downloads,
					value: "downloads",
				},
				{
					name: `${OUTPUT_PRESET_LABELS.home}${detected === "home" ? " (current)" : ""}`,
					description: presetPaths.home,
					value: "home",
				},
				{
					name: detected === "custom" ? "Custom path (current)" : "Custom path",
					description: draft.config.outputDir ?? "Enter a directory manually",
					value: "custom",
				},
			];
		}
		case "outputCustom":
			return [];
		case "schedule":
			return [
				{
					name: `Notion interval: ${getDraftInterval(draft, "notion")}`,
					description: "Open the interval picker",
					value: "notion",
				},
				{
					name: `Gmail interval: ${getDraftInterval(draft, "gmail")}`,
					description: "Open the interval picker",
					value: "gmail",
				},
				{
					name: `Google Calendar interval: ${getDraftInterval(draft, "google-calendar")}`,
					description: "Open the interval picker",
					value: "google-calendar",
				},
			];
		case "interval":
			return INTERVAL_OPTIONS.map((interval) => ({
				name: interval,
				description:
					interval === getDraftInterval(draft, route.connector)
						? "Current value"
						: "Use this interval",
				value: interval,
			}));
		case "gmailFilter":
			return [
				{
					name: "Primary only",
					description:
						getDraftGmailSyncFilter(draft) === "primary"
							? "Current value"
							: "Sync only inbox messages that Gmail classifies as Primary",
					value: "primary",
				},
				{
					name: "Primary + Important required",
					description:
						getDraftGmailSyncFilter(draft) === "primary-important"
							? "Current value"
							: "Require both Primary and Important labels on inbox messages",
					value: "primary-important",
				},
			];
		case "googleCalendarSelection":
			return route.loading
				? [
						{
							name: "Refresh",
							description: "Retry loading calendars",
							value: "refresh",
						},
					]
				: [
						...route.calendars.map((calendar) => ({
							name: `${route.selectedCalendarIds.includes(calendar.id) ? "[x]" : "[ ]"} ${calendar.summary}${calendar.primary ? " (primary)" : ""}`,
							description: calendar.description ?? calendar.id,
							value: {
								kind: "toggleCalendar",
								calendarId: calendar.id,
							},
						})),
						{
							name: "Save selection",
							description: "Persist the selected calendars",
							value: "save",
						},
						{
							name: "Refresh",
							description: "Reload calendars from Google",
							value: "refresh",
						},
					];
		case "advanced":
			return [
				{
					name: "Diagnostics",
					description: "Run doctor and inspect the detailed output",
					value: "diagnostics",
				},
			];
		case "update":
			return [
				{
					name: "Check now",
					description: route.checking
						? "Checking currently in progress"
						: "Refresh latest release status",
					value: "checkNow",
				},
				...(!route.installBusy &&
				route.status?.hasUpdate &&
				route.status.canSelfUpdate
					? [
							{
								name: "Install update",
								description: `Download and install ${route.status.latestVersion ? formatVersion(route.status.latestVersion) : "the latest release"}`,
								value: "installUpdate",
							} satisfies UiSelectOption,
						]
					: []),
			];
		case "diagnostics":
			return [
				{
					name: "Refresh diagnostics",
					description: "Run doctor again",
					value: "refresh",
				},
			];
	}
}

function getAuthOptions(
	route: ConnectorAuthRoute,
	docsBaseUrl: string | null,
): UiSelectOption[] {
	switch (route.stage) {
		case "intro":
			if (route.authMethod !== "notion-token") {
				const docsUrl = getConnectorAuthDocsUrl(route, docsBaseUrl);
				return [
					...(docsUrl
						? [
								{
									name: "Open docs",
									description: "Open the connector guide in your browser",
									value: "openDocs",
								} satisfies UiSelectOption,
							]
						: []),
					{
						name: "Continue",
						description: "Start the guided connection flow",
						value: "continue",
					},
					{
						name: "Cancel",
						description: "Return to the connector page",
						value: "cancel",
					},
				];
			}

			return [
				{
					name: "Continue",
					description: "Start the guided connection flow",
					value: "continue",
				},
				{
					name: "Cancel",
					description: "Return to the connector page",
					value: "cancel",
				},
			];
		case "opening-browser":
		case "waiting-callback":
		case "validating":
			return [
				{
					name: "Cancel",
					description: "Stop the current connection flow",
					value: "cancel",
				},
			];
		case "success":
			return [
				{
					name: "Done",
					description: "Return to the connector page",
					value: "done",
				},
			];
		case "error":
			return [
				{
					name: "Retry",
					description: "Restart the guided flow",
					value: "retry",
				},
				{
					name: "Cancel",
					description: "Return to the connector page",
					value: "cancel",
				},
			];
		case "collect-input":
			return [];
	}
}

export function getKeyHint(route: ConfigRoute): string {
	if (route.id === "syncDashboard" && isSyncDashboardLocked(route)) {
		return "keys: j/k arrows move | enter stop | esc/left blocked until stopped | q quit";
	}

	if (route.id === "diagnostics") {
		return "keys: j/k arrows move | enter select | r refresh | esc/left back | q quit";
	}

	if (isInputRoute(route)) {
		return "keys: type input | enter confirm | esc back | q quit";
	}

	return "keys: j/k arrows move | enter select | esc/left back | q quit";
}
