import type {
	AppIo,
	SecretsStore,
	SyncdownApp,
	SyncdownConfig,
	SyncIntervalPreset,
} from "@syncdown/core";
import {
	DEFAULT_APPLE_NOTES_CONNECTION_ID,
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	EXIT_CODES,
	getDefaultIntegration,
	hasGoogleCredentials,
	hasNotionOAuthConnectionCredentials,
	isAppleNotesIntegration,
	isCalendarIntegration,
	isGmailIntegration,
	type resolveAppPaths,
} from "@syncdown/core";
import { createSecretsStore } from "@syncdown/secrets";

type CredentialStatus = "complete" | "missing" | "local";

interface PrintOverviewOptions {
	defaultWatchInterval: SyncIntervalPreset;
	interactiveTerminal: boolean;
	secrets?: SecretsStore;
}

function supportsAppleNotes(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "darwin";
}

async function getCredentialStatus(
	connectorId: "notion" | "gmail" | "google-calendar" | "apple-notes",
	config: SyncdownConfig,
	paths: ReturnType<typeof resolveAppPaths>,
	secrets: SecretsStore,
): Promise<CredentialStatus> {
	if (connectorId === "apple-notes") {
		return supportsAppleNotes() ? "local" : "missing";
	}

	if (connectorId === "notion") {
		const notionIntegration = getNotionIntegrationConfig(config);
		if (notionIntegration.connectionId === DEFAULT_NOTION_OAUTH_CONNECTION_ID) {
			return (await hasNotionOAuthConnectionCredentials(secrets, paths, {
				oauthAppId: DEFAULT_NOTION_OAUTH_APP_ID,
				connectionId: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
			}))
				? "complete"
				: "missing";
		}

		return (await secrets.hasSecret(
			`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
			paths,
		))
			? "complete"
			: "missing";
	}

	return (await hasGoogleCredentials(secrets, paths)) ? "complete" : "missing";
}

function getNotionIntegrationConfig(config: SyncdownConfig) {
	const integration = getDefaultIntegration(config, "notion");
	if (integration.connectorId !== "notion") {
		throw new Error("Expected default Notion integration");
	}
	return integration;
}

function getNotionAuthMethod(config: SyncdownConfig): "token" | "oauth" {
	return getNotionIntegrationConfig(config).connectionId ===
		DEFAULT_NOTION_OAUTH_CONNECTION_ID
		? "oauth"
		: "token";
}

function getGmailIntegrationConfig(config: SyncdownConfig) {
	const integration = getDefaultIntegration(config, "gmail");
	if (!isGmailIntegration(integration)) {
		throw new Error("Expected default Gmail integration");
	}
	return integration;
}

function getGoogleCalendarIntegrationConfig(config: SyncdownConfig) {
	const integration = getDefaultIntegration(config, "google-calendar");
	if (!isCalendarIntegration(integration)) {
		throw new Error("Expected default Google Calendar integration");
	}
	return integration;
}

function getAppleNotesIntegrationConfig(config: SyncdownConfig) {
	const integration = getDefaultIntegration(config, "apple-notes");
	if (!isAppleNotesIntegration(integration)) {
		throw new Error("Expected default Apple Notes integration");
	}
	return integration;
}

function writeLines(io: AppIo, lines: string[]): void {
	for (const line of lines) {
		io.write(line);
	}
}

function buildHeadlessSetupLines(appleNotesSupported: boolean): string[] {
	const lines = [
		"- Run `syncdown config set ...` to finish setup in headless mode.",
		"- Example: `syncdown config set outputDir /path/to/output`",
		"- Example: `syncdown config set notion.enabled true`",
		"- Example: `syncdown config set notion.authMethod oauth`",
		"- Example: `printf '%s' \"$NOTION_TOKEN\" | syncdown config set notion.token --stdin`",
		"- Example: `printf '%s' \"$NOTION_CLIENT_ID\" | syncdown config set notion.oauth.clientId --stdin`",
		"- Example: `printf '%s' \"$NOTION_CLIENT_SECRET\" | syncdown config set notion.oauth.clientSecret --stdin`",
		"- Example: `printf '%s' \"$NOTION_REFRESH_TOKEN\" | syncdown config set notion.oauth.refreshToken --stdin`",
		"- Example: `syncdown config set gmail.enabled true`",
		"- Example: `syncdown config set gmail.syncFilter primary`",
		"- Example: `syncdown config set gmail.fetchConcurrency 10`",
		"- Example: `syncdown config set googleCalendar.enabled true`",
		"- Example: `syncdown config set googleCalendar.selectedCalendarIds primary,work@example.com`",
		"- Example: `printf '%s' \"$GOOGLE_CLIENT_ID\" | syncdown config set google.clientId --stdin`",
		"- Example: `printf '%s' \"$GOOGLE_CLIENT_SECRET\" | syncdown config set google.clientSecret --stdin`",
		"- Example: `printf '%s' \"$GOOGLE_REFRESH_TOKEN\" | syncdown config set google.refreshToken --stdin`",
	];

	if (appleNotesSupported) {
		lines.push("- Example: `syncdown config set appleNotes.enabled true`");
		lines.push("- Example: `syncdown config set appleNotes.interval 1h`");
	}

	return lines;
}

function buildNextStepLines(options: {
	appleNotesSupported: boolean;
	defaultWatchInterval: SyncIntervalPreset;
	hasEnabledConfiguredConnector: boolean;
	interactiveTerminal: boolean;
	outputDir: string | undefined;
}): string[] {
	if (!options.outputDir || !options.hasEnabledConfiguredConnector) {
		if (options.interactiveTerminal) {
			return ["- Run `syncdown` to finish setup in the TUI."];
		}

		return buildHeadlessSetupLines(options.appleNotesSupported);
	}

	return [
		"- Run `syncdown run` to start a sync.",
		`- Run \`syncdown run --watch\` to keep syncing every ${options.defaultWatchInterval}.`,
		options.interactiveTerminal
			? "- Run `syncdown` to update settings in the TUI."
			: "- Run `syncdown doctor` for a health check.",
	];
}

export async function printOverview(
	io: AppIo,
	app: SyncdownApp,
	options: PrintOverviewOptions,
): Promise<number> {
	const secrets = options.secrets ?? createSecretsStore();
	const snapshot = await app.inspect();
	const notionConfig = getNotionIntegrationConfig(snapshot.config);
	const gmailConfig = getGmailIntegrationConfig(snapshot.config);
	const googleCalendarConfig = getGoogleCalendarIntegrationConfig(
		snapshot.config,
	);
	const appleNotesSupported = snapshot.connectors.some(
		(connector) => connector.id === "apple-notes",
	);
	const appleNotesConfig = appleNotesSupported
		? getAppleNotesIntegrationConfig(snapshot.config)
		: null;
	const notion = snapshot.integrations.find(
		(integration) => integration.connectorId === "notion",
	);
	const gmail = snapshot.integrations.find(
		(integration) => integration.connectorId === "gmail",
	);
	const googleCalendar = snapshot.integrations.find(
		(integration) => integration.connectorId === "google-calendar",
	);
	const appleNotes = appleNotesSupported
		? snapshot.integrations.find(
				(integration) => integration.connectorId === "apple-notes",
			)
		: undefined;
	const [
		notionCredentials,
		gmailCredentials,
		googleCalendarCredentials,
		googleCredentials,
	] = await Promise.all([
		getCredentialStatus("notion", snapshot.config, snapshot.paths, secrets),
		getCredentialStatus("gmail", snapshot.config, snapshot.paths, secrets),
		getCredentialStatus(
			"google-calendar",
			snapshot.config,
			snapshot.paths,
			secrets,
		),
		hasGoogleCredentials(secrets, snapshot.paths),
	]);
	const appleNotesCredentials = appleNotesSupported
		? await getCredentialStatus(
				"apple-notes",
				snapshot.config,
				snapshot.paths,
				secrets,
			)
		: "missing";
	const hasEnabledConfiguredConnector =
		((notion?.enabled ?? notionConfig.enabled) &&
			notionCredentials === "complete") ||
		((gmail?.enabled ?? gmailConfig.enabled) &&
			gmailCredentials === "complete") ||
		((googleCalendar?.enabled ?? googleCalendarConfig.enabled) &&
			googleCalendarCredentials === "complete" &&
			googleCalendarConfig.config.selectedCalendarIds.length > 0) ||
		(appleNotesSupported &&
			(appleNotes?.enabled ?? appleNotesConfig?.enabled ?? false) &&
			appleNotesCredentials === "local");

	const lines = [
		"syncdown",
		"",
		`config: ${snapshot.paths.configPath}`,
		`output: ${snapshot.config.outputDir ?? "<unset>"}`,
		`google: ${googleCredentials ? "connected" : "missing"}`,
		`notion: ${(notion?.enabled ?? notionConfig.enabled) ? "enabled" : "disabled"} | method=${getNotionAuthMethod(snapshot.config)} | interval=${notion?.interval ?? notionConfig.interval} | credentials=${notionCredentials} | last sync=${notion?.lastSyncAt ?? "never"}`,
		`gmail: ${(gmail?.enabled ?? gmailConfig.enabled) ? "enabled" : "disabled"} | interval=${gmail?.interval ?? gmailConfig.interval} | filter=${gmailConfig.config.syncFilter ?? "primary"} | concurrency=${gmailConfig.config.fetchConcurrency ?? 10} | credentials=${gmailCredentials} | last sync=${gmail?.lastSyncAt ?? "never"}`,
		`google-calendar: ${(googleCalendar?.enabled ?? googleCalendarConfig.enabled) ? "enabled" : "disabled"} | interval=${googleCalendar?.interval ?? googleCalendarConfig.interval} | selected calendars=${googleCalendarConfig.config.selectedCalendarIds.length} | credentials=${googleCalendarCredentials} | last sync=${googleCalendar?.lastSyncAt ?? "never"}`,
	];

	if (appleNotesSupported && appleNotesConfig) {
		lines.push(
			`apple-notes: ${(appleNotes?.enabled ?? appleNotesConfig.enabled) ? "enabled" : "disabled"} | interval=${appleNotes?.interval ?? appleNotesConfig.interval} | access=${appleNotesCredentials} | connection=${DEFAULT_APPLE_NOTES_CONNECTION_ID} | last sync=${appleNotes?.lastSyncAt ?? "never"}`,
		);
	}

	lines.push("", "Next:");
	lines.push(
		...buildNextStepLines({
			appleNotesSupported,
			defaultWatchInterval: options.defaultWatchInterval,
			hasEnabledConfiguredConnector,
			interactiveTerminal: options.interactiveTerminal,
			outputDir: snapshot.config.outputDir,
		}),
	);

	writeLines(io, lines);
	return EXIT_CODES.OK;
}
