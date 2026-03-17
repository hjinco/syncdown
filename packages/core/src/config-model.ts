import { randomUUID } from "node:crypto";

import type {
	CalendarIntegrationConfig,
	ConnectionConfig,
	ConnectionSummary,
	Connector,
	ConnectorDefinitionSummary,
	ConnectorId,
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

export function createDefaultOAuthApps(): OAuthAppConfig[] {
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

export function createDefaultConnections(): ConnectionConfig[] {
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
	];
}

export function createDefaultIntegrations(): IntegrationConfig[] {
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
				initialSyncLimit: 5000,
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
	];
}

export function createDefaultConfig(): SyncdownConfig {
	return {
		oauthApps: createDefaultOAuthApps(),
		connections: createDefaultConnections(),
		integrations: createDefaultIntegrations(),
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

export function toConnectorDefinitions(
	connectors: readonly Connector[],
): ConnectorDefinitionSummary[] {
	return connectors.map((connector) => ({
		id: connector.id,
		label: connector.label,
		setupMethods: [...connector.setupMethods],
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
	connector: Connector,
	lastSyncAt: string | null,
): IntegrationSummary {
	return {
		id: integration.id,
		connectorId: integration.connectorId,
		connectionId: integration.connectionId,
		label: integration.label,
		setupMethods: [...connector.setupMethods],
		enabled: integration.enabled,
		interval: integration.interval,
		lastSyncAt,
	};
}

export function normalizeConfig(
	parsed: Partial<SyncdownConfig>,
): SyncdownConfig {
	const defaults = createDefaultConfig();
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

				const googleAccountCandidate =
					candidate as Partial<GoogleAccountConnectionConfig>;
				if (
					candidate.kind === "google-account" &&
					typeof googleAccountCandidate.oauthAppId === "string"
				) {
					return [
						{
							id: candidate.id,
							kind: "google-account",
							label: candidate.label,
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
							id: candidate.id,
							kind: "notion-token",
							label: candidate.label,
							workspaceName:
								typeof (candidate as { workspaceName?: unknown })
									.workspaceName === "string"
									? (candidate as { workspaceName?: string }).workspaceName
									: undefined,
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
							id: candidate.id,
							kind: "notion-oauth-account",
							label: candidate.label,
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

				if (candidate.connectorId === "notion") {
					return [
						{
							id: candidate.id,
							connectorId: "notion",
							connectionId: candidate.connectionId,
							label: candidate.label,
							enabled: candidate.enabled,
							interval: candidate.interval,
							config: {},
						},
					];
				}

				if (candidate.connectorId === "gmail") {
					const settings = (candidate as Partial<GmailIntegrationConfig>)
						.config;
					return [
						{
							id: candidate.id,
							connectorId: "gmail",
							connectionId: candidate.connectionId,
							label: candidate.label,
							enabled: candidate.enabled,
							interval: candidate.interval,
							config: {
								initialSyncLimit:
									typeof settings?.initialSyncLimit === "number"
										? settings.initialSyncLimit
										: 5000,
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
					const settings = (candidate as Partial<CalendarIntegrationConfig>)
						.config;
					return [
						{
							id: candidate.id,
							connectorId: "google-calendar",
							connectionId: candidate.connectionId,
							label: candidate.label,
							enabled: candidate.enabled,
							interval: candidate.interval,
							config: {
								selectedCalendarIds: Array.isArray(
									settings?.selectedCalendarIds,
								)
									? [
											...new Set(
												settings.selectedCalendarIds.filter(
													(value): value is string =>
														typeof value === "string" &&
														value.trim().length > 0,
												),
											),
										]
									: [],
							},
						},
					];
				}

				return [];
			})
		: defaults.integrations;

	return {
		outputDir,
		oauthApps: ensureSeededOauthApps(oauthApps),
		connections: ensureSeededConnections(connections),
		integrations: ensureSeededIntegrations(integrations),
	};
}

function ensureSeededOauthApps(oauthApps: OAuthAppConfig[]): OAuthAppConfig[] {
	const values = [...oauthApps];
	const defaults = createDefaultOAuthApps();
	for (const seed of defaults.reverse()) {
		if (!values.some((oauthApp) => oauthApp.id === seed.id)) {
			values.unshift(seed);
		}
	}
	return values;
}

function ensureSeededConnections(
	connections: ConnectionConfig[],
): ConnectionConfig[] {
	const values = [...connections];
	const defaults = createDefaultConnections();
	for (const seed of defaults.reverse()) {
		if (!values.some((connection) => connection.id === seed.id)) {
			values.unshift(seed);
		}
	}
	return values;
}

function ensureSeededIntegrations(
	integrations: IntegrationConfig[],
): IntegrationConfig[] {
	const values = [...integrations];
	const defaults = createDefaultIntegrations();
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
