import { randomUUID } from "node:crypto";

import type {
	AppleNotesIntegrationConfig,
	CalendarIntegrationConfig,
	ConnectionConfig,
	ConnectionSummary,
	ConnectorDefinitionSummary,
	ConnectorId,
	ConnectorPlugin,
	GmailIntegrationConfig,
	GoogleAccountConnectionConfig,
	IntegrationConfig,
	IntegrationSummary,
	NotionIntegrationConfig,
	NotionOAuthConnectionConfig,
	OAuthAppConfig,
	SyncdownConfig,
} from "./types.js";

export const DEFAULT_GOOGLE_OAUTH_APP_ID = "google-default";
export const DEFAULT_GOOGLE_CONNECTION_ID = "google-account-default";
export const DEFAULT_NOTION_OAUTH_APP_ID = "notion-oauth-app-default";
export const DEFAULT_NOTION_TOKEN_CONNECTION_ID = "notion-token-default";
export const DEFAULT_NOTION_OAUTH_CONNECTION_ID = "notion-oauth-default";
export const DEFAULT_APPLE_NOTES_CONNECTION_ID = "apple-notes-local-default";

function getFallbackOAuthApps(): OAuthAppConfig[] {
	return [
		{
			id: DEFAULT_GOOGLE_OAUTH_APP_ID,
			providerId: "google",
			label: "Default Google OAuth App",
		},
		{
			id: DEFAULT_NOTION_OAUTH_APP_ID,
			providerId: "notion",
			label: "Default Notion OAuth App",
		},
	];
}

function getFallbackConnections(): ConnectionConfig[] {
	return [
		{
			id: DEFAULT_GOOGLE_CONNECTION_ID,
			kind: "google-account",
			label: "Default Google Account",
			oauthAppId: DEFAULT_GOOGLE_OAUTH_APP_ID,
		},
		{
			id: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
			kind: "notion-token",
			label: "Default Notion Token Connection",
		},
		{
			id: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
			kind: "notion-oauth-account",
			label: "Default Notion OAuth Connection",
			oauthAppId: DEFAULT_NOTION_OAUTH_APP_ID,
		},
		{
			id: DEFAULT_APPLE_NOTES_CONNECTION_ID,
			kind: "apple-notes-local",
			label: "Default Apple Notes Connection",
		},
	];
}

function getFallbackIntegrations(): IntegrationConfig[] {
	return [
		{
			id: randomUUID(),
			connectorId: "notion",
			connectionId: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
			label: "Notion",
			enabled: false,
			interval: "1h",
			config: {},
		},
		{
			id: randomUUID(),
			connectorId: "gmail",
			connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
			label: "Gmail",
			enabled: false,
			interval: "1h",
			config: {
				fetchConcurrency: 10,
				syncFilter: "primary",
			},
		},
		{
			id: randomUUID(),
			connectorId: "google-calendar",
			connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
			label: "Google Calendar",
			enabled: false,
			interval: "1h",
			config: {
				selectedCalendarIds: [],
			},
		},
		{
			id: randomUUID(),
			connectorId: "apple-notes",
			connectionId: DEFAULT_APPLE_NOTES_CONNECTION_ID,
			label: "Apple Notes",
			enabled: false,
			interval: "1h",
			config: {},
		},
	];
}

function getConfigPlugins(
	plugins: readonly ConnectorPlugin[] = [],
): readonly ConnectorPlugin[] {
	return plugins;
}

function mergeById<T extends { id: string }>(values: readonly T[]): T[] {
	return [...values].reduceRight<T[]>((acc, value) => {
		if (!acc.some((candidate) => candidate.id === value.id)) {
			acc.unshift(value);
		}
		return acc;
	}, []);
}

function mergeIntegrationsByConnector(
	values: readonly IntegrationConfig[],
): IntegrationConfig[] {
	return [...values].reduceRight<IntegrationConfig[]>((acc, value) => {
		if (!acc.some((candidate) => candidate.connectorId === value.connectorId)) {
			acc.unshift(value);
		}
		return acc;
	}, []);
}

export function createDefaultOAuthApps(
	plugins: readonly ConnectorPlugin[] = [],
): OAuthAppConfig[] {
	const seeded = getConfigPlugins(plugins).flatMap(
		(plugin) => plugin.seedOAuthApps?.() ?? [],
	);
	return mergeById([...seeded, ...getFallbackOAuthApps()]);
}

export function createDefaultConnections(
	plugins: readonly ConnectorPlugin[] = [],
): ConnectionConfig[] {
	const seeded = getConfigPlugins(plugins).flatMap(
		(plugin) => plugin.seedConnections?.() ?? [],
	);
	return mergeById([...seeded, ...getFallbackConnections()]);
}

export function createDefaultIntegrations(
	plugins: readonly ConnectorPlugin[] = [],
): IntegrationConfig[] {
	const seeded = getConfigPlugins(plugins).flatMap(
		(plugin) => plugin.seedIntegrations?.() ?? [],
	);
	return mergeIntegrationsByConnector([
		...seeded,
		...getFallbackIntegrations(),
	]);
}

export function createDefaultConfig(
	plugins: readonly ConnectorPlugin[] = [],
): SyncdownConfig {
	return {
		oauthApps: createDefaultOAuthApps(plugins),
		connections: createDefaultConnections(plugins),
		integrations: createDefaultIntegrations(plugins),
	};
}

export function findConnection(
	config: SyncdownConfig,
	connectionId: string,
): ConnectionConfig | undefined {
	return config.connections.find(
		(connection) => connection.id === connectionId,
	);
}

export function findOAuthApp(
	config: SyncdownConfig,
	oauthAppId: string,
): OAuthAppConfig | undefined {
	return config.oauthApps.find((oauthApp) => oauthApp.id === oauthAppId);
}

export function findIntegration(
	config: SyncdownConfig,
	integrationId: string,
): IntegrationConfig | undefined {
	return config.integrations.find(
		(integration) => integration.id === integrationId,
	);
}

export function listIntegrationsForConnector(
	config: SyncdownConfig,
	connectorId: ConnectorId,
): IntegrationConfig[] {
	return config.integrations.filter(
		(integration) => integration.connectorId === connectorId,
	);
}

export function getDefaultIntegration(
	config: SyncdownConfig,
	connectorId: ConnectorId,
): IntegrationConfig {
	const integration = config.integrations.find(
		(candidate) => candidate.connectorId === connectorId,
	);
	if (!integration) {
		throw new Error(`Missing default integration for ${connectorId}`);
	}
	return integration;
}

export function getDefaultConnectionId(connectorId: ConnectorId): string {
	return connectorId === "gmail" || connectorId === "google-calendar"
		? DEFAULT_GOOGLE_CONNECTION_ID
		: connectorId === "apple-notes"
			? DEFAULT_APPLE_NOTES_CONNECTION_ID
			: DEFAULT_NOTION_TOKEN_CONNECTION_ID;
}

export function getDefaultConnection(
	config: SyncdownConfig,
	connectorId: ConnectorId,
): ConnectionConfig {
	const connection = findConnection(
		config,
		getDefaultIntegration(config, connectorId).connectionId,
	);
	if (!connection) {
		throw new Error(`Missing default connection for ${connectorId}`);
	}
	return connection;
}

export function isGoogleAccountConnection(
	connection: ConnectionConfig,
): connection is GoogleAccountConnectionConfig {
	return connection.kind === "google-account";
}

export function isNotionOAuthConnection(
	connection: ConnectionConfig,
): connection is NotionOAuthConnectionConfig {
	return connection.kind === "notion-oauth-account";
}

export function isNotionIntegration(
	integration: IntegrationConfig,
): integration is NotionIntegrationConfig {
	return integration.connectorId === "notion";
}

export function isGmailIntegration(
	integration: IntegrationConfig,
): integration is GmailIntegrationConfig {
	return integration.connectorId === "gmail";
}

export function isCalendarIntegration(
	integration: IntegrationConfig,
): integration is CalendarIntegrationConfig {
	return integration.connectorId === "google-calendar";
}

export function isAppleNotesIntegration(
	integration: IntegrationConfig,
): integration is AppleNotesIntegrationConfig {
	return integration.connectorId === "apple-notes";
}

export function toConnectorDefinitions(
	plugins: readonly ConnectorPlugin[],
): ConnectorDefinitionSummary[] {
	return plugins.map((plugin) => ({
		id: plugin.id,
		label: plugin.label,
		setupMethods: [...plugin.setupMethods],
	}));
}

export function toConnectionSummaries(
	config: SyncdownConfig,
): ConnectionSummary[] {
	return config.connections.map((connection) => ({
		id: connection.id,
		kind: connection.kind,
		label: connection.label,
	}));
}

export function toIntegrationSummary(
	integration: IntegrationConfig,
	plugin: ConnectorPlugin,
	lastSyncAt: string | null,
): IntegrationSummary {
	return {
		id: integration.id,
		connectorId: integration.connectorId,
		connectionId: integration.connectionId,
		label: integration.label,
		setupMethods: [...plugin.setupMethods],
		enabled: integration.enabled,
		interval: integration.interval,
		lastSyncAt,
	};
}

export function normalizeConfig(
	parsed: Partial<SyncdownConfig>,
	plugins: readonly ConnectorPlugin[] = [],
): SyncdownConfig {
	const defaults = createDefaultConfig(plugins);
	const outputDir =
		typeof parsed.outputDir === "string" ? parsed.outputDir : undefined;

	const oauthApps = Array.isArray(parsed.oauthApps)
		? parsed.oauthApps.flatMap((entry): OAuthAppConfig[] => {
				if (!entry || typeof entry !== "object") {
					return [];
				}

				const candidate = entry as Partial<OAuthAppConfig>;
				if (
					typeof candidate.id !== "string" ||
					(candidate.providerId !== "google" &&
						candidate.providerId !== "notion")
				) {
					return [];
				}

				return [
					{
						id: candidate.id,
						providerId: candidate.providerId,
						label:
							typeof candidate.label === "string" && candidate.label.trim()
								? candidate.label
								: candidate.id,
					},
				];
			})
		: defaults.oauthApps;

	const connections = Array.isArray(parsed.connections)
		? parsed.connections.flatMap((entry): ConnectionConfig[] => {
				if (!entry || typeof entry !== "object") {
					return [];
				}

				const candidate = entry as Partial<ConnectionConfig>;
				if (
					typeof candidate.id !== "string" ||
					typeof candidate.label !== "string"
				) {
					return [];
				}

				for (const plugin of plugins) {
					const normalized = plugin.normalizeConnection?.(candidate);
					if (normalized && normalized.length > 0) {
						return normalized;
					}
				}

				return normalizeLegacyConnection(candidate);
			})
		: defaults.connections;

	const integrations = Array.isArray(parsed.integrations)
		? parsed.integrations.flatMap((entry): IntegrationConfig[] => {
				if (!entry || typeof entry !== "object") {
					return [];
				}

				const candidate = entry as Partial<IntegrationConfig>;
				if (
					typeof candidate.id !== "string" ||
					typeof candidate.connectionId !== "string" ||
					typeof candidate.label !== "string" ||
					typeof candidate.enabled !== "boolean" ||
					(candidate.interval !== "5m" &&
						candidate.interval !== "15m" &&
						candidate.interval !== "1h" &&
						candidate.interval !== "6h" &&
						candidate.interval !== "24h")
				) {
					return [];
				}

				for (const plugin of plugins) {
					const normalized = plugin.normalizeIntegration?.(candidate);
					if (normalized && normalized.length > 0) {
						return normalized;
					}
				}

				return normalizeLegacyIntegration(candidate);
			})
		: defaults.integrations;

	return {
		outputDir,
		oauthApps: ensureSeededOauthApps(oauthApps, plugins),
		connections: ensureSeededConnections(connections, plugins),
		integrations: ensureSeededIntegrations(integrations, plugins),
	};
}

function normalizeLegacyConnection(
	candidate: Partial<ConnectionConfig>,
): ConnectionConfig[] {
	const googleAccountCandidate =
		candidate as Partial<GoogleAccountConnectionConfig>;
	if (
		candidate.kind === "google-account" &&
		typeof googleAccountCandidate.oauthAppId === "string"
	) {
		return [
			{
				id: candidate.id ?? DEFAULT_GOOGLE_CONNECTION_ID,
				kind: "google-account",
				label: candidate.label ?? "Google Account",
				oauthAppId: googleAccountCandidate.oauthAppId,
				accountEmail:
					typeof googleAccountCandidate.accountEmail === "string"
						? googleAccountCandidate.accountEmail
						: undefined,
			},
		];
	}

	if (candidate.kind === "notion-token") {
		return [
			{
				id: candidate.id ?? DEFAULT_NOTION_TOKEN_CONNECTION_ID,
				kind: "notion-token",
				label: candidate.label ?? "Notion Token Connection",
				workspaceName:
					typeof (candidate as { workspaceName?: unknown }).workspaceName ===
					"string"
						? (candidate as { workspaceName?: string }).workspaceName
						: undefined,
			},
		];
	}

	if (candidate.kind === "apple-notes-local") {
		return [
			{
				id: candidate.id ?? DEFAULT_APPLE_NOTES_CONNECTION_ID,
				kind: "apple-notes-local",
				label: candidate.label ?? "Apple Notes Connection",
			},
		];
	}

	const notionOauthCandidate =
		candidate as Partial<NotionOAuthConnectionConfig>;
	if (
		candidate.kind === "notion-oauth-account" &&
		typeof notionOauthCandidate.oauthAppId === "string"
	) {
		return [
			{
				id: candidate.id ?? DEFAULT_NOTION_OAUTH_CONNECTION_ID,
				kind: "notion-oauth-account",
				label: candidate.label ?? "Notion OAuth Connection",
				oauthAppId: notionOauthCandidate.oauthAppId,
				workspaceId:
					typeof notionOauthCandidate.workspaceId === "string"
						? notionOauthCandidate.workspaceId
						: undefined,
				workspaceName:
					typeof notionOauthCandidate.workspaceName === "string"
						? notionOauthCandidate.workspaceName
						: undefined,
				botId:
					typeof notionOauthCandidate.botId === "string"
						? notionOauthCandidate.botId
						: undefined,
				ownerUserId:
					typeof notionOauthCandidate.ownerUserId === "string"
						? notionOauthCandidate.ownerUserId
						: undefined,
				ownerUserName:
					typeof notionOauthCandidate.ownerUserName === "string"
						? notionOauthCandidate.ownerUserName
						: undefined,
			},
		];
	}

	return [];
}

function normalizeLegacyIntegration(
	candidate: Partial<IntegrationConfig>,
): IntegrationConfig[] {
	if (candidate.connectorId === "notion") {
		return [
			{
				id: candidate.id ?? randomUUID(),
				connectorId: "notion",
				connectionId:
					candidate.connectionId ?? DEFAULT_NOTION_TOKEN_CONNECTION_ID,
				label: candidate.label ?? "Notion",
				enabled: candidate.enabled ?? false,
				interval: candidate.interval ?? "1h",
				config: {},
			},
		];
	}

	if (candidate.connectorId === "gmail") {
		const settings = (candidate as Partial<GmailIntegrationConfig>).config;
		return [
			{
				id: candidate.id ?? randomUUID(),
				connectorId: "gmail",
				connectionId: candidate.connectionId ?? DEFAULT_GOOGLE_CONNECTION_ID,
				label: candidate.label ?? "Gmail",
				enabled: candidate.enabled ?? false,
				interval: candidate.interval ?? "1h",
				config: {
					fetchConcurrency:
						typeof settings?.fetchConcurrency === "number"
							? settings.fetchConcurrency
							: 10,
					syncFilter:
						settings?.syncFilter === "primary-important"
							? "primary-important"
							: "primary",
				},
			},
		];
	}

	if (candidate.connectorId === "google-calendar") {
		const settings = (candidate as Partial<CalendarIntegrationConfig>).config;
		return [
			{
				id: candidate.id ?? randomUUID(),
				connectorId: "google-calendar",
				connectionId: candidate.connectionId ?? DEFAULT_GOOGLE_CONNECTION_ID,
				label: candidate.label ?? "Google Calendar",
				enabled: candidate.enabled ?? false,
				interval: candidate.interval ?? "1h",
				config: {
					selectedCalendarIds: Array.isArray(settings?.selectedCalendarIds)
						? [
								...new Set(
									settings.selectedCalendarIds.filter(
										(value): value is string =>
											typeof value === "string" && value.trim().length > 0,
									),
								),
							]
						: [],
				},
			},
		];
	}

	if (candidate.connectorId === "apple-notes") {
		return [
			{
				id: candidate.id ?? randomUUID(),
				connectorId: "apple-notes",
				connectionId:
					candidate.connectionId ?? DEFAULT_APPLE_NOTES_CONNECTION_ID,
				label: candidate.label ?? "Apple Notes",
				enabled: candidate.enabled ?? false,
				interval: candidate.interval ?? "1h",
				config: {},
			},
		];
	}

	return [];
}

function ensureSeededOauthApps(
	oauthApps: OAuthAppConfig[],
	plugins: readonly ConnectorPlugin[] = [],
): OAuthAppConfig[] {
	const values = [...oauthApps];
	const defaults = createDefaultOAuthApps(plugins);
	for (const seed of defaults.reverse()) {
		if (!values.some((oauthApp) => oauthApp.id === seed.id)) {
			values.unshift(seed);
		}
	}
	return values;
}

function ensureSeededConnections(
	connections: ConnectionConfig[],
	plugins: readonly ConnectorPlugin[] = [],
): ConnectionConfig[] {
	const values = [...connections];
	const defaults = createDefaultConnections(plugins);
	for (const seed of defaults.reverse()) {
		if (!values.some((connection) => connection.id === seed.id)) {
			values.unshift(seed);
		}
	}
	return values;
}

function ensureSeededIntegrations(
	integrations: IntegrationConfig[],
	plugins: readonly ConnectorPlugin[] = [],
): IntegrationConfig[] {
	const values = [...integrations];
	const defaults = createDefaultIntegrations(plugins);
	for (const seed of defaults.reverse()) {
		if (
			!values.some(
				(integration) => integration.connectorId === seed.connectorId,
			)
		) {
			values.unshift(seed);
		}
	}
	return values;
}
