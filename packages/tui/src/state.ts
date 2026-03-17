import path from "node:path";
import type {
	AppIo,
	AppPaths,
	CalendarIntegrationConfig,
	ConnectionConfig,
	ConnectorId,
	GmailIntegrationConfig,
	GmailSyncFilter,
	NotionOAuthConnectionConfig,
	SecretsStore,
	SyncdownApp,
	SyncdownConfig,
	SyncIntervalPreset,
	SyncRuntimeSnapshot,
} from "@syncdown/core";
import {
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	getDefaultIntegration,
	getGoogleConnectionSecretNames,
	getGoogleOAuthAppSecretNames,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
	writeConfig,
} from "@syncdown/core";

export type SecretAction = "keep" | "set" | "delete";
export type OutputPresetAction =
	| "desktop"
	| "documents"
	| "downloads"
	| "home"
	| "custom";
export type ConnectorTarget = "notion" | "gmail" | "google-calendar";
export type ProviderTarget = "google" | "notion";
export type SecretTarget =
	| "notionToken"
	| "notionOauthClientId"
	| "notionOauthClientSecret"
	| "notionOauthRefreshToken"
	| "googleClientId"
	| "googleClientSecret"
	| "googleRefreshToken";
export type ConnectorStatusLabel = "connected" | "disconnected" | "needs setup";
export type ConnectorAuthStage =
	| "intro"
	| "collect-input"
	| "opening-browser"
	| "waiting-callback"
	| "validating"
	| "success"
	| "error";
export type AuthFieldKey =
	| "notionToken"
	| "notionOauthClientId"
	| "notionOauthClientSecret"
	| "googleClientId"
	| "googleClientSecret";
export type NotionAuthMethod = "token" | "oauth";

export interface SecretDraftState {
	stored: boolean;
	action: SecretAction;
	value: string;
}

export interface DraftState {
	config: SyncdownConfig;
	notionToken: SecretDraftState;
	notionOauthClientId: SecretDraftState;
	notionOauthClientSecret: SecretDraftState;
	notionOauthRefreshToken: SecretDraftState;
	googleClientId: SecretDraftState;
	googleClientSecret: SecretDraftState;
	googleRefreshToken: SecretDraftState;
}

export interface DiagnosticsResult {
	title: string;
	body: string;
}

export interface DraftSecretSnapshot {
	notionTokenStored?: boolean;
	notionOauthClientIdStored?: boolean;
	notionOauthClientSecretStored?: boolean;
	notionOauthRefreshTokenStored?: boolean;
	googleClientIdStored?: boolean;
	googleClientSecretStored?: boolean;
	googleRefreshTokenStored?: boolean;
}

export interface ConnectorStatus {
	label: ConnectorStatusLabel;
	description: string;
}

export const INTERVAL_OPTIONS: SyncIntervalPreset[] = [
	"5m",
	"15m",
	"1h",
	"6h",
	"24h",
];

export const OUTPUT_PRESET_LABELS: Record<
	Exclude<OutputPresetAction, "custom">,
	string
> = {
	desktop: "Desktop",
	documents: "Documents",
	downloads: "Downloads",
	home: "Home",
};

export function getDraftIntegration(
	draft: DraftState,
	connector: ConnectorTarget,
):
	| GmailIntegrationConfig
	| CalendarIntegrationConfig
	| ReturnType<typeof getDefaultIntegration> {
	return getDefaultIntegration(draft.config, connector as ConnectorId);
}

function getConnectionById(
	draft: DraftState,
	connectionId: string,
): ConnectionConfig {
	const connection = draft.config.connections.find(
		(candidate) => candidate.id === connectionId,
	);
	if (!connection) {
		throw new Error(`Missing connection: ${connectionId}`);
	}
	return connection;
}

export function getDraftNotionConnection(draft: DraftState): ConnectionConfig {
	return getConnectionById(
		draft,
		getDraftIntegration(draft, "notion").connectionId,
	);
}

export function getDraftNotionAuthMethod(draft: DraftState): NotionAuthMethod {
	return getDraftNotionConnection(draft).kind === "notion-oauth-account"
		? "oauth"
		: "token";
}

export function getDraftInterval(
	draft: DraftState,
	connector: ConnectorTarget,
): SyncIntervalPreset {
	return getDraftIntegration(draft, connector).interval;
}

export function getDraftGmailSyncFilter(draft: DraftState): GmailSyncFilter {
	const integration = getDraftIntegration(draft, "gmail");
	if (integration.connectorId !== "gmail") {
		throw new Error("Missing default Gmail integration");
	}

	return integration.config.syncFilter === "primary-important"
		? "primary-important"
		: "primary";
}

export function getDraftSelectedGoogleCalendarIds(draft: DraftState): string[] {
	const integration = getDraftIntegration(draft, "google-calendar");
	if (integration.connectorId !== "google-calendar") {
		throw new Error("Missing default Google Calendar integration");
	}

	return integration.config.selectedCalendarIds;
}

export function isDraftConnectorEnabled(
	draft: DraftState,
	connector: ConnectorTarget,
): boolean {
	return getDraftIntegration(draft, connector).enabled;
}

function createSecretDraftState(stored: boolean): SecretDraftState {
	return {
		stored,
		action: "keep",
		value: "",
	};
}

function cloneSecretDraftState(secret: SecretDraftState): SecretDraftState {
	return {
		stored: secret.stored,
		action: secret.action,
		value: secret.value,
	};
}

export function getSecretDraft(
	draft: DraftState,
	target: SecretTarget,
): SecretDraftState {
	switch (target) {
		case "notionToken":
			return draft.notionToken;
		case "notionOauthClientId":
			return draft.notionOauthClientId;
		case "notionOauthClientSecret":
			return draft.notionOauthClientSecret;
		case "notionOauthRefreshToken":
			return draft.notionOauthRefreshToken;
		case "googleClientId":
			return draft.googleClientId;
		case "googleClientSecret":
			return draft.googleClientSecret;
		case "googleRefreshToken":
			return draft.googleRefreshToken;
	}
}

export function hasCompleteNotionCredentials(draft: DraftState): boolean {
	if (getDraftNotionAuthMethod(draft) === "token") {
		return (
			draft.notionToken.action === "set" ||
			(draft.notionToken.action !== "delete" && draft.notionToken.stored)
		);
	}

	return [
		draft.notionOauthClientId,
		draft.notionOauthClientSecret,
		draft.notionOauthRefreshToken,
	].every(
		(secret) =>
			secret.action === "set" || (secret.action !== "delete" && secret.stored),
	);
}

export function hasCompleteGoogleCredentials(draft: DraftState): boolean {
	return [
		draft.googleClientId,
		draft.googleClientSecret,
		draft.googleRefreshToken,
	].every(
		(secret) =>
			secret.action === "set" || (secret.action !== "delete" && secret.stored),
	);
}

export function hasAnyStoredCredentials(
	draft: DraftState,
	connector: ConnectorTarget,
): boolean {
	if (connector === "notion") {
		return [
			draft.notionToken,
			draft.notionOauthClientId,
			draft.notionOauthClientSecret,
			draft.notionOauthRefreshToken,
		].some(
			(secret) =>
				secret.action === "set" ||
				(secret.action !== "delete" && secret.stored),
		);
	}

	return [
		draft.googleClientId,
		draft.googleClientSecret,
		draft.googleRefreshToken,
	].some(
		(secret) =>
			secret.action === "set" || (secret.action !== "delete" && secret.stored),
	);
}

export function getConnectorStatus(
	draft: DraftState,
	connector: ConnectorTarget,
): ConnectorStatus {
	const enabled = isDraftConnectorEnabled(draft, connector);
	const completeCredentials =
		connector === "notion"
			? hasCompleteNotionCredentials(draft)
			: hasCompleteGoogleCredentials(draft);
	const stored = hasAnyStoredCredentials(draft, connector);
	const hasCalendarSelection =
		connector !== "google-calendar" ||
		getDraftSelectedGoogleCalendarIds(draft).length > 0;

	if (enabled && completeCredentials && hasCalendarSelection) {
		return {
			label: "connected",
			description: "Ready to sync.",
		};
	}

	if (enabled && !completeCredentials) {
		return {
			label: "needs setup",
			description: "Finish connecting to complete setup.",
		};
	}

	if (enabled && connector === "google-calendar" && !hasCalendarSelection) {
		return {
			label: "needs setup",
			description: "Select at least one calendar to finish setup.",
		};
	}

	if (stored) {
		return {
			label: "disconnected",
			description:
				connector === "notion"
					? `Stored ${getDraftNotionAuthMethod(draft) === "oauth" ? "OAuth credentials" : "token"}, but the connector is disabled.`
					: "Google account is stored, but the connector is disabled.",
		};
	}

	return {
		label: "disconnected",
		description: "No stored credentials.",
	};
}

export function setNotionAuthMethod(
	draft: DraftState,
	method: NotionAuthMethod,
): void {
	getDraftIntegration(draft, "notion").connectionId =
		method === "oauth"
			? DEFAULT_NOTION_OAUTH_CONNECTION_ID
			: DEFAULT_NOTION_TOKEN_CONNECTION_ID;
}

function getNotionOAuthConnectionConfig(
	draft: DraftState,
): NotionOAuthConnectionConfig {
	const connection = getConnectionById(
		draft,
		DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	);
	if (connection.kind !== "notion-oauth-account") {
		throw new Error("Missing default Notion OAuth connection");
	}
	return connection;
}

export function stageNotionConnection(draft: DraftState, token: string): void {
	setNotionAuthMethod(draft, "token");
	applySecretAction(draft, "notionToken", "set", token);
	setConnectorEnabled(draft, "notion", true);
}

export function stageNotionOAuthConnection(
	draft: DraftState,
	clientId: string,
	clientSecret: string,
	refreshToken: string,
	metadata: Partial<
		Pick<
			NotionOAuthConnectionConfig,
			| "workspaceId"
			| "workspaceName"
			| "botId"
			| "ownerUserId"
			| "ownerUserName"
		>
	> = {},
): void {
	setNotionAuthMethod(draft, "oauth");
	applySecretAction(draft, "notionOauthClientId", "set", clientId);
	applySecretAction(draft, "notionOauthClientSecret", "set", clientSecret);
	applySecretAction(draft, "notionOauthRefreshToken", "set", refreshToken);
	Object.assign(getNotionOAuthConnectionConfig(draft), metadata);
	setConnectorEnabled(draft, "notion", true);
}

export function stageGoogleConnection(
	draft: DraftState,
	clientId: string,
	clientSecret: string,
	refreshToken: string,
	connector: Extract<ConnectorTarget, "gmail" | "google-calendar"> = "gmail",
): void {
	applySecretAction(draft, "googleClientId", "set", clientId);
	applySecretAction(draft, "googleClientSecret", "set", clientSecret);
	applySecretAction(draft, "googleRefreshToken", "set", refreshToken);
	setConnectorEnabled(draft, connector, true);
}

export function stageConnectorDisconnect(
	draft: DraftState,
	connector: ConnectorTarget,
): void {
	setConnectorEnabled(draft, connector, false);
}

export function stageStoredCredentialDisconnect(
	draft: DraftState,
	connector: ConnectorTarget,
): void {
	setConnectorEnabled(draft, connector, false);
	if (connector === "notion") {
		if (getDraftNotionAuthMethod(draft) === "oauth") {
			applySecretAction(draft, "notionOauthClientId", "delete");
			applySecretAction(draft, "notionOauthClientSecret", "delete");
			applySecretAction(draft, "notionOauthRefreshToken", "delete");
		} else {
			applySecretAction(draft, "notionToken", "delete");
		}
	}
}

export function stageProviderDisconnect(
	draft: DraftState,
	provider: ProviderTarget,
): void {
	if (provider === "notion") {
		applySecretAction(draft, "notionOauthClientId", "delete");
		applySecretAction(draft, "notionOauthClientSecret", "delete");
		applySecretAction(draft, "notionOauthRefreshToken", "delete");
		if (getDraftNotionAuthMethod(draft) === "oauth") {
			setConnectorEnabled(draft, "notion", false);
		}
		return;
	}

	applySecretAction(draft, "googleClientId", "delete");
	applySecretAction(draft, "googleClientSecret", "delete");
	applySecretAction(draft, "googleRefreshToken", "delete");
	setConnectorEnabled(draft, "gmail", false);
	setConnectorEnabled(draft, "google-calendar", false);
}

export function toCronExpression(interval: SyncIntervalPreset): string {
	switch (interval) {
		case "5m":
			return "*/5 * * * *";
		case "15m":
			return "*/15 * * * *";
		case "1h":
			return "0 * * * *";
		case "6h":
			return "0 */6 * * *";
		case "24h":
			return "0 0 * * *";
	}
}

export function toSystemdOnCalendar(interval: SyncIntervalPreset): string {
	switch (interval) {
		case "5m":
			return "*-*-* *:0/5:00";
		case "15m":
			return "*-*-* *:0/15:00";
		case "1h":
			return "hourly";
		case "6h":
			return "*-*-* 0/6:00:00";
		case "24h":
			return "daily";
	}
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildRunCommand(paths: AppPaths): string {
	const configRoot = path.dirname(paths.configDir);
	const dataRoot = path.dirname(paths.dataDir);
	const envPrefix = [
		`XDG_CONFIG_HOME=${shellQuote(configRoot)}`,
		`XDG_DATA_HOME=${shellQuote(dataRoot)}`,
	].join(" ");

	const scriptPath = process.argv[1];
	if (scriptPath) {
		return `${envPrefix} ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} run`;
	}

	return `${envPrefix} syncdown run`;
}

export function buildSchedulerHelp(
	interval: SyncIntervalPreset,
	paths: AppPaths,
): string {
	const runCommand = buildRunCommand(paths);
	const configRoot = path.dirname(paths.configDir);
	const dataRoot = path.dirname(paths.dataDir);
	return [
		"In-process watch:",
		`  ${runCommand} --watch --interval ${interval}`,
		"",
		"External scheduler:",
		`cron: ${toCronExpression(interval)} ${runCommand}`,
		"",
		"systemd timer:",
		`  OnCalendar=${toSystemdOnCalendar(interval)}`,
		"",
		"systemd service:",
		`  Environment="XDG_CONFIG_HOME=${configRoot}"`,
		`  Environment="XDG_DATA_HOME=${dataRoot}"`,
		`  ExecStart=${process.execPath} ${process.argv[1] ?? "syncdown"} run`,
	].join("\n");
}

export function normalizeOutputPath(value: string): string {
	return path.resolve(value);
}

export function buildOutputPresetPaths(): Record<
	Exclude<OutputPresetAction, "custom">,
	string
> {
	const homeDir = resolveHomeDirectory();
	return {
		desktop: path.join(homeDir, "Desktop"),
		documents: path.join(homeDir, "Documents"),
		downloads: path.join(homeDir, "Downloads"),
		home: homeDir,
	};
}

export function detectOutputPreset(
	outputDir: string | undefined,
): OutputPresetAction {
	if (!outputDir) {
		return "custom";
	}

	const presets = buildOutputPresetPaths();
	for (const [preset, presetPath] of Object.entries(presets)) {
		if (outputDir === presetPath) {
			return preset as Exclude<OutputPresetAction, "custom">;
		}
	}

	return "custom";
}

function resolveHomeDirectory(): string {
	const home =
		Bun.env.HOME ??
		Bun.env.USERPROFILE ??
		(Bun.env.HOMEDRIVE && Bun.env.HOMEPATH
			? path.join(Bun.env.HOMEDRIVE, Bun.env.HOMEPATH)
			: undefined);

	if (!home) {
		throw new Error(
			"Unable to resolve the user home directory from the environment",
		);
	}

	return home;
}

export function buildOverview(paths: AppPaths, draft: DraftState): string {
	const notionStatus = getConnectorStatus(draft, "notion");
	const gmailStatus = getConnectorStatus(draft, "gmail");
	const googleCalendarStatus = getConnectorStatus(draft, "google-calendar");
	return [
		`config: ${paths.configPath}`,
		`secrets: ${paths.secretsPath}`,
		`output: ${draft.config.outputDir ?? "<unset>"}`,
		`notion: ${notionStatus.label} | method=${getDraftNotionAuthMethod(draft)} | interval=${getDraftInterval(draft, "notion")} | enabled=${isDraftConnectorEnabled(draft, "notion") ? "yes" : "no"}`,
		`gmail: ${gmailStatus.label} | interval=${getDraftInterval(draft, "gmail")} | enabled=${isDraftConnectorEnabled(draft, "gmail") ? "yes" : "no"}`,
		`google-calendar: ${googleCalendarStatus.label} | interval=${getDraftInterval(draft, "google-calendar")} | selected=${getDraftSelectedGoogleCalendarIds(draft).length} | enabled=${isDraftConnectorEnabled(draft, "google-calendar") ? "yes" : "no"}`,
	].join("\n");
}

function padTwo(value: number): string {
	return String(value).padStart(2, "0");
}

function formatDashboardTimestamp(
	value: string | null,
	fallback = "--",
): string {
	if (!value) {
		return fallback;
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return truncate(value, 16);
	}

	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear() &&
		now.getMonth() === date.getMonth() &&
		now.getDate() === date.getDate();

	const time = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
	if (sameDay) {
		return time;
	}

	return `${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())} ${time}`;
}

function formatWatchLabel(snapshot: SyncRuntimeSnapshot): string {
	if (!snapshot.watch.active || !snapshot.watch.strategy) {
		return "off";
	}

	if (snapshot.watch.strategy.kind === "per-integration") {
		return "per-integration";
	}

	return `global (${snapshot.watch.strategy.interval})`;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(maxLength - 3, 0)).trimEnd()}...`;
}

function formatLastRunResult(snapshot: SyncRuntimeSnapshot): string {
	if (snapshot.lastRunExitCode === null) {
		return "never";
	}

	if (snapshot.lastRunExitCode === 0) {
		return snapshot.lastRunFinishedAt
			? `ok ${formatDashboardTimestamp(snapshot.lastRunFinishedAt)}`
			: "ok";
	}

	return snapshot.lastRunFinishedAt
		? `failed ${formatDashboardTimestamp(snapshot.lastRunFinishedAt)}`
		: "failed";
}

function formatStatusStrip(
	snapshot: SyncRuntimeSnapshot,
	width: number,
): string {
	const activeCount = snapshot.integrations.filter(
		(integration) => integration.running,
	).length;
	const queuedCount = snapshot.integrations.filter(
		(integration) => integration.queuedImmediateRun,
	).length;
	const errorCount = snapshot.integrations.filter(
		(integration) => integration.status === "error",
	).length;

	return truncate(
		[
			snapshot.status.toUpperCase(),
			`watch ${formatWatchLabel(snapshot)}`,
			`last ${formatLastRunResult(snapshot)}`,
			`active ${activeCount}`,
			`queued ${queuedCount}`,
			`errors ${errorCount}`,
		].join(" | "),
		width,
	);
}

function summarizeLogMessage(message: string): string {
	if (message.startsWith("Integration start: ")) {
		return `Starting ${message.slice("Integration start: ".length)} sync`;
	}

	if (message.startsWith("Discovering shared Notion pages and data sources")) {
		return "Discovering shared pages and data sources";
	}

	const notionDiscoveryMatch =
		/^Notion discovery: shared_pages=(\d+) data_sources=(\d+)$/.exec(message);
	if (notionDiscoveryMatch) {
		return `Found ${notionDiscoveryMatch[1]} shared pages and ${notionDiscoveryMatch[2]} data sources`;
	}

	const notionProgressMatch =
		/^Notion progress: discovered=(\d+) processed=(\d+) saved=(\d+) skipped=(\d+) failed=(\d+)$/.exec(
			message,
		);
	if (notionProgressMatch) {
		const [, discovered, processed, saved, skipped, failed] =
			notionProgressMatch;
		return `Processing pages ${processed}/${discovered} | saved ${saved} | skipped ${skipped} | failed ${failed}`;
	}

	if (message.startsWith("Gmail progress: streaming initial sync")) {
		return "Scanning inbox for the first sync";
	}

	const gmailProgressMatch =
		/^Gmail progress: messages=(\d+) concurrency=(\d+)$/.exec(message);
	if (gmailProgressMatch) {
		return `Fetching ${gmailProgressMatch[1]} changed Gmail messages`;
	}

	if (message.startsWith("Gmail history cursor expired.")) {
		return "Gmail history expired, switching to a full inbox scan";
	}

	if (message.startsWith("Sync finished. Documents written: ")) {
		return `Sync finished with ${message.slice("Sync finished. Documents written: ".length)} documents written`;
	}

	if (message.startsWith("Resetting integration state: ")) {
		return `Resetting ${message.slice("Resetting integration state: ".length)} state`;
	}

	if (message.startsWith("Querying ")) {
		return message;
	}

	return truncate(message, 80);
}

function getRelevantIntegrationLog(
	snapshot: SyncRuntimeSnapshot,
	integrationId: string,
	connectorId: ConnectorId,
	clearedAfter: string | null,
): SyncRuntimeSnapshot["logs"][number] | null {
	const visibleLogs = snapshot.logs.filter((entry) =>
		clearedAfter ? entry.timestamp > clearedAfter : true,
	);
	for (let index = visibleLogs.length - 1; index >= 0; index -= 1) {
		const entry = visibleLogs[index];
		if (entry.integrationId === integrationId) {
			return entry;
		}

		if (!entry.integrationId && entry.connectorId === connectorId) {
			return entry;
		}
	}

	return null;
}

function formatIntegrationBadge(
	snapshot: SyncRuntimeSnapshot["integrations"][number],
): string {
	if (!snapshot.enabled) {
		return "OFF";
	}

	if (snapshot.running) {
		return "RUNNING";
	}

	if (snapshot.queuedImmediateRun) {
		return "QUEUED";
	}

	if (snapshot.status === "error") {
		return "ERROR";
	}

	if (snapshot.status === "success") {
		return "OK";
	}

	return "IDLE";
}

function formatIntegrationHeadline(
	snapshot: SyncRuntimeSnapshot["integrations"][number],
	lastLog: SyncRuntimeSnapshot["logs"][number] | null,
	width: number,
): string {
	if (!snapshot.enabled) {
		return truncate("Disabled", width);
	}

	if (snapshot.progress?.phase) {
		return truncate(snapshot.progress.phase, width);
	}

	if (snapshot.lastError) {
		return truncate(`Blocked: ${snapshot.lastError}`, width);
	}

	if (snapshot.running && lastLog) {
		return truncate(summarizeLogMessage(lastLog.message), width);
	}

	if (snapshot.running) {
		return truncate("Sync in progress", width);
	}

	if (snapshot.queuedImmediateRun) {
		return truncate("Queued to run next", width);
	}

	if (snapshot.lastSuccessAt) {
		return truncate("Waiting for the next run", width);
	}

	return truncate("Ready to sync", width);
}

function createDashboardBar(
	width: number,
	filled: number,
	emptyChar = "░",
	filledChar = "█",
): string {
	return `${filledChar.repeat(Math.max(0, Math.min(width, filled)))}${emptyChar.repeat(Math.max(0, width - filled))}`;
}

function shouldIncludeActivity(message: string): boolean {
	return (
		!message.startsWith("Document created:") &&
		!message.startsWith("Document updated:") &&
		!message.startsWith("Document deleted:") &&
		!message.includes("credentials valid") &&
		!message.includes("token valid")
	);
}

function formatActivityLine(
	entry: SyncRuntimeSnapshot["logs"][number],
): string {
	const scope = entry.integrationLabel
		? entry.integrationLabel
		: entry.connectorId
			? entry.connectorId
			: entry.integrationId
				? entry.integrationId
				: "sync";
	const level = entry.level === "error" ? "ERR" : "INF";
	return `${formatDashboardTimestamp(entry.timestamp, "--:--")} | ${scope} | ${level} | ${summarizeLogMessage(entry.message)}`;
}

function formatDetailedLogLine(
	entry: SyncRuntimeSnapshot["logs"][number],
): string {
	const scopePrefix = entry.integrationLabel
		? `[${entry.integrationLabel}] `
		: entry.connectorId
			? `[${entry.connectorId}] `
			: entry.integrationId
				? `[${entry.integrationId}] `
				: "";
	return `${formatDashboardTimestamp(entry.timestamp, "--:--")} ${entry.level.toUpperCase()} ${scopePrefix}${entry.message}`;
}

function formatProgressLine(
	integration: SyncRuntimeSnapshot["integrations"][number],
	width: number,
): string {
	const barWidth = width >= 96 ? 18 : width >= 76 ? 14 : 10;

	if (integration.progress?.mode === "determinate") {
		const total =
			integration.progress.total ?? integration.progress.completed ?? 0;
		const rawCompleted = integration.progress.completed ?? 0;
		const completed = total > 0 ? Math.min(rawCompleted, total) : rawCompleted;
		const ratio = total > 0 ? completed / total : 0;
		const filled = total > 0 ? Math.round(ratio * barWidth) : 0;
		const percent = total > 0 ? `${Math.round(ratio * 100)}%` : "0%";
		const count = `${completed}/${total} ${integration.progress.unit}`;
		return truncate(
			`${createDashboardBar(barWidth, filled)} ${percent} ${count}`,
			width,
		);
	}

	if (integration.progress?.mode === "indeterminate") {
		const pattern = "▓▓▓░░";
		const bar = pattern
			.repeat(Math.ceil(barWidth / pattern.length))
			.slice(0, barWidth);
		const summary = integration.progress.detail
			? truncate(integration.progress.detail, Math.max(width - barWidth - 1, 0))
			: "working";
		return truncate(`${bar} ${summary}`, width);
	}

	if (integration.queuedImmediateRun) {
		return truncate(
			`${createDashboardBar(barWidth, Math.max(2, Math.floor(barWidth / 4)))} queued`,
			width,
		);
	}

	if (integration.running) {
		const pattern = "▓▓░░";
		const bar = pattern
			.repeat(Math.ceil(barWidth / pattern.length))
			.slice(0, barWidth);
		return truncate(`${bar} in progress`, width);
	}

	return truncate(
		`${createDashboardBar(barWidth, 0)} ${integration.enabled ? "ready" : "disabled"}`,
		width,
	);
}

function formatIntegrationDetails(
	integration: SyncRuntimeSnapshot["integrations"][number],
	width: number,
): string {
	const parts = [
		`docs ${integration.lastDocumentsWritten}`,
		`next ${formatDashboardTimestamp(integration.nextRunAt)}`,
		integration.lastError
			? `error ${truncate(integration.lastError, Math.max(Math.floor(width / 3), 12))}`
			: `ok ${formatDashboardTimestamp(integration.lastSuccessAt)}`,
	];

	return truncate(parts.join(" · "), width);
}

function formatIntegrationCard(
	integration: SyncRuntimeSnapshot["integrations"][number],
	lastLog: SyncRuntimeSnapshot["logs"][number] | null,
	width: number,
): string[] {
	const lineWidth = Math.max(24, width);
	return [
		truncate(
			`${integration.label} [${formatIntegrationBadge(integration)}] ${formatIntegrationHeadline(integration, lastLog, lineWidth)}`,
			lineWidth,
		),
		truncate(
			`  ${formatProgressLine(integration, Math.max(lineWidth - 2, 8))}`,
			lineWidth,
		),
		truncate(
			`  ${formatIntegrationDetails(integration, Math.max(lineWidth - 2, 8))}`,
			lineWidth,
		),
	];
}

export function buildSyncDashboardBody(
	snapshot: SyncRuntimeSnapshot,
	clearedAfter: string | null,
	showDetailedLogs = false,
	width = 80,
): string {
	const bodyWidth = Math.max(48, width);
	const visibleLogs = snapshot.logs.filter((entry) =>
		clearedAfter ? entry.timestamp > clearedAfter : true,
	);
	const connectorLines = snapshot.integrations.flatMap((integration, index) => {
		const lastLog = getRelevantIntegrationLog(
			snapshot,
			integration.id,
			integration.connectorId,
			clearedAfter,
		);
		return [
			...formatIntegrationCard(integration, lastLog, bodyWidth),
			...(index < snapshot.integrations.length - 1 ? [""] : []),
		];
	});

	const feedSource = showDetailedLogs
		? visibleLogs
				.slice(-4)
				.map((entry) => truncate(formatDetailedLogLine(entry), bodyWidth))
		: visibleLogs
				.filter((entry) => shouldIncludeActivity(entry.message))
				.slice(-4)
				.map((entry) => truncate(formatActivityLine(entry), bodyWidth));
	const feedLines =
		feedSource.length === 0
			? [
					showDetailedLogs
						? "No raw log entries yet."
						: "No recent activity yet.",
				]
			: feedSource;

	return [
		formatStatusStrip(snapshot, bodyWidth),
		"",
		...connectorLines,
		`${showDetailedLogs ? "Raw log" : "Recent activity"}`,
		...feedLines,
	].join("\n");
}

export function createDraftState(
	config: SyncdownConfig,
	secrets: DraftSecretSnapshot,
): DraftState {
	return {
		config: structuredClone(config),
		notionToken: createSecretDraftState(secrets.notionTokenStored ?? false),
		notionOauthClientId: createSecretDraftState(
			secrets.notionOauthClientIdStored ?? false,
		),
		notionOauthClientSecret: createSecretDraftState(
			secrets.notionOauthClientSecretStored ?? false,
		),
		notionOauthRefreshToken: createSecretDraftState(
			secrets.notionOauthRefreshTokenStored ?? false,
		),
		googleClientId: createSecretDraftState(
			secrets.googleClientIdStored ?? false,
		),
		googleClientSecret: createSecretDraftState(
			secrets.googleClientSecretStored ?? false,
		),
		googleRefreshToken: createSecretDraftState(
			secrets.googleRefreshTokenStored ?? false,
		),
	};
}

export function cloneDraftState(draft: DraftState): DraftState {
	return {
		config: structuredClone(draft.config),
		notionToken: cloneSecretDraftState(draft.notionToken),
		notionOauthClientId: cloneSecretDraftState(draft.notionOauthClientId),
		notionOauthClientSecret: cloneSecretDraftState(
			draft.notionOauthClientSecret,
		),
		notionOauthRefreshToken: cloneSecretDraftState(
			draft.notionOauthRefreshToken,
		),
		googleClientId: cloneSecretDraftState(draft.googleClientId),
		googleClientSecret: cloneSecretDraftState(draft.googleClientSecret),
		googleRefreshToken: cloneSecretDraftState(draft.googleRefreshToken),
	};
}

export function syncDraftState(target: DraftState, source: DraftState): void {
	target.config = structuredClone(source.config);
	target.notionToken = cloneSecretDraftState(source.notionToken);
	target.notionOauthClientId = cloneSecretDraftState(
		source.notionOauthClientId,
	);
	target.notionOauthClientSecret = cloneSecretDraftState(
		source.notionOauthClientSecret,
	);
	target.notionOauthRefreshToken = cloneSecretDraftState(
		source.notionOauthRefreshToken,
	);
	target.googleClientId = cloneSecretDraftState(source.googleClientId);
	target.googleClientSecret = cloneSecretDraftState(source.googleClientSecret);
	target.googleRefreshToken = cloneSecretDraftState(source.googleRefreshToken);
}

export function setConnectorEnabled(
	draft: DraftState,
	connector: ConnectorTarget,
	enabled: boolean,
): void {
	getDraftIntegration(draft, connector).enabled = enabled;
}

export function applySecretAction(
	draft: DraftState,
	target: SecretTarget,
	action: SecretAction,
	value = "",
): void {
	const secret = getSecretDraft(draft, target);
	secret.action = action;
	secret.value = action === "set" ? value.trim() : "";

	if (action === "set") {
		secret.stored = true;
		return;
	}

	if (action === "delete") {
		secret.stored = false;
	}
}

export function setOutputDirectory(draft: DraftState, outputDir: string): void {
	draft.config.outputDir = outputDir;
}

export function setSyncInterval(
	draft: DraftState,
	connector: ConnectorTarget,
	interval: SyncIntervalPreset,
): void {
	getDraftIntegration(draft, connector).interval = interval;
}

export function setGmailSyncFilter(
	draft: DraftState,
	syncFilter: GmailSyncFilter,
): void {
	const integration = getDraftIntegration(draft, "gmail");
	if (integration.connectorId !== "gmail") {
		throw new Error("Missing default Gmail integration");
	}

	integration.config.syncFilter = syncFilter;
}

export function setSelectedGoogleCalendarIds(
	draft: DraftState,
	selectedCalendarIds: string[],
): void {
	const integration = getDraftIntegration(draft, "google-calendar");
	if (integration.connectorId !== "google-calendar") {
		throw new Error("Missing default Google Calendar integration");
	}

	integration.config.selectedCalendarIds = [
		...new Set(
			selectedCalendarIds.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			),
		),
	];
}

export async function collectDiagnostics(
	app: SyncdownApp,
	_io: AppIo,
	paths: AppPaths,
	draft: DraftState,
): Promise<DiagnosticsResult> {
	const lines: string[] = [];
	const captureIo: AppIo = {
		write(line) {
			lines.push(line);
		},
		error(line) {
			lines.push(`ERROR: ${line}`);
		},
	};

	await app.doctor(captureIo);
	return {
		title: "Diagnostics",
		body: [buildOverview(paths, draft), "", ...lines].join("\n"),
	};
}

async function persistSecret(
	paths: AppPaths,
	secrets: SecretsStore,
	name: string,
	draftState: SecretDraftState,
): Promise<void> {
	if (draftState.action === "set") {
		await secrets.setSecret(name, draftState.value, paths);
	} else if (draftState.action === "delete") {
		await secrets.deleteSecret(name, paths);
	}

	draftState.action = "keep";
	draftState.value = "";
	draftState.stored = await secrets.hasSecret(name, paths);
}

export async function saveDraft(
	paths: AppPaths,
	secrets: SecretsStore,
	draft: DraftState,
): Promise<void> {
	await writeConfig(paths, draft.config);

	await persistSecret(
		paths,
		secrets,
		`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
		draft.notionToken,
	);
	await persistSecret(
		paths,
		secrets,
		getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientId,
		draft.notionOauthClientId,
	);
	await persistSecret(
		paths,
		secrets,
		getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientSecret,
		draft.notionOauthClientSecret,
	);
	await persistSecret(
		paths,
		secrets,
		getNotionOAuthConnectionSecretNames(DEFAULT_NOTION_OAUTH_CONNECTION_ID)
			.refreshToken,
		draft.notionOauthRefreshToken,
	);
	await persistSecret(
		paths,
		secrets,
		getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientId,
		draft.googleClientId,
	);
	await persistSecret(
		paths,
		secrets,
		getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientSecret,
		draft.googleClientSecret,
	);
	await persistSecret(
		paths,
		secrets,
		getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID).refreshToken,
		draft.googleRefreshToken,
	);
}
