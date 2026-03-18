import { createGmailConnector } from "@syncdown/connector-gmail";
import { createGoogleCalendarConnector } from "@syncdown/connector-google-calendar";
import { createNotionConnector } from "@syncdown/connector-notion";
import type {
	AppIo,
	ApplyUpdateResult,
	GmailSyncFilter,
	RunOptions,
	SelfUpdater,
	SyncdownApp,
	SyncdownConfig,
	SyncIntervalPreset,
	UpdateStatus,
} from "@syncdown/core";
import {
	createStdIo,
	createSyncdownApp,
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	EXIT_CODES,
	ensureAppDirectories,
	GOOGLE_SECRET_NAMES,
	getDefaultIntegration,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
	hasGoogleCredentials,
	hasNotionOAuthConnectionCredentials,
	isCalendarIntegration,
	isGmailIntegration,
	readConfig,
	resolveAppPaths,
	writeConfig,
} from "@syncdown/core";
import { createMarkdownRenderer } from "@syncdown/renderer-md";
import { createSecretsStore } from "@syncdown/secrets";
import { createFileSystemSink } from "@syncdown/sink-fs";
import { createStateStore } from "@syncdown/state-sqlite";
import { launchConfigTui } from "@syncdown/tui";

import { createCliSelfUpdater } from "./updater.js";

function getHelpLines(): string[] {
	return [
		"syncdown",
		"",
		"Usage:",
		"  syncdown",
		"  syncdown status",
		"  syncdown config set <key> <value>",
		"  syncdown config set <key> --stdin",
		"  syncdown config unset <key>",
		"  syncdown run",
		"  syncdown run --connector <notion|gmail|google-calendar>",
		"  syncdown run --integration <integration-id>",
		"  syncdown run --reset [--connector <notion|gmail|google-calendar>|--integration <integration-id>]",
		"  syncdown run --watch [--interval <5m|15m|1h|6h|24h>]",
		"  syncdown connectors",
		"  syncdown doctor",
		"  syncdown update",
		"  syncdown update --check",
		"",
		"Interactive:",
		"  syncdown                    Launch the TUI with settings plus the sync dashboard.",
		"",
		"Headless config:",
		"  syncdown config set ...     Set config values non-interactively.",
		"  syncdown config unset ...   Remove config values non-interactively.",
		"",
		"Config keys:",
		"  outputDir",
		"  notion.enabled",
		"  notion.interval",
		"  notion.authMethod",
		"  notion.token",
		"  notion.oauth.clientId",
		"  notion.oauth.clientSecret",
		"  notion.oauth.refreshToken",
		"  gmail.enabled",
		"  gmail.interval",
		"  gmail.fetchConcurrency",
		"  gmail.syncFilter",
		"  googleCalendar.enabled",
		"  googleCalendar.interval",
		"  googleCalendar.selectedCalendarIds",
		"  google.clientId",
		"  google.clientSecret",
		"  google.refreshToken",
		"",
		"Run exit codes:",
		`  ${EXIT_CODES.OK} success`,
		`  ${EXIT_CODES.CONFIG_ERROR} configuration error`,
		`  ${EXIT_CODES.LOCKED} another sync is already running`,
		`  ${EXIT_CODES.VALIDATION_ERROR} connector validation failed`,
		`  ${EXIT_CODES.SYNC_ERROR} connector sync failed`,
	];
}

function writeLines(output: (line: string) => void, lines: string[]): void {
	for (const line of lines) {
		output(line);
	}
}

export function printHelp(
	output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): void {
	writeLines(output, getHelpLines());
}

function printConfigHelp(io: AppIo): void {
	writeLines(io.error, [
		"Usage:",
		"  syncdown config set <key> <value>",
		"  syncdown config set <key> --stdin",
		"  syncdown config unset <key>",
		"",
		"Use `syncdown` to launch the interactive TUI.",
	]);
}

const INTERVAL_PRESETS: SyncIntervalPreset[] = ["5m", "15m", "1h", "6h", "24h"];
const DEFAULT_WATCH_INTERVAL: SyncIntervalPreset = "1h";

interface CliDependencies {
	app?: SyncdownApp;
	io?: AppIo;
	secrets?: ReturnType<typeof createSecretsStore>;
	launchConfig?: typeof launchConfigTui;
	updater?: SelfUpdater;
}

function isSyncIntervalPreset(value: string): value is SyncIntervalPreset {
	return INTERVAL_PRESETS.includes(value as SyncIntervalPreset);
}

function parseBoolean(value: string): boolean | null {
	if (value === "true") {
		return true;
	}

	if (value === "false") {
		return false;
	}

	return null;
}

function isGmailSyncFilter(value: string): value is GmailSyncFilter {
	return value === "primary" || value === "primary-important";
}

async function readValueFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

async function loadConfig(): Promise<{
	config: SyncdownConfig;
	paths: ReturnType<typeof resolveAppPaths>;
}> {
	const paths = resolveAppPaths();
	await ensureAppDirectories(paths);
	const config = await readConfig(paths);
	return { config, paths };
}

function printConfigSetUsage(io: AppIo): void {
	io.error(
		"Usage: syncdown config set <outputDir|notion.enabled|notion.interval|notion.authMethod|notion.token|notion.oauth.clientId|notion.oauth.clientSecret|notion.oauth.refreshToken|gmail.enabled|gmail.interval|gmail.fetchConcurrency|gmail.syncFilter|googleCalendar.enabled|googleCalendar.interval|googleCalendar.selectedCalendarIds|google.clientId|google.clientSecret|google.refreshToken> <value|--stdin>",
	);
}

function printConfigUnsetUsage(io: AppIo): void {
	io.error(
		"Usage: syncdown config unset <outputDir|notion.token|notion.oauth.clientId|notion.oauth.clientSecret|notion.oauth.refreshToken|google.clientId|google.clientSecret|google.refreshToken>",
	);
}

function printRunUsage(io: AppIo): void {
	io.error(
		"Usage: syncdown run [--connector <notion|gmail|google-calendar>|--integration <integration-id>] [--reset] [--watch] [--interval <5m|15m|1h|6h|24h>]",
	);
}

function printUpdateUsage(io: AppIo): void {
	io.error("Usage: syncdown update [--check]");
}

function isInteractiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function parsePositiveInteger(value: string): number | null {
	if (!/^\d+$/.test(value)) {
		return null;
	}

	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseRunOptions(args: string[], io: AppIo): RunOptions | null {
	let watch = false;
	let watchInterval: SyncIntervalPreset | undefined;
	let target: RunOptions["target"];
	let resetState = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		if (arg === "--watch") {
			watch = true;
			continue;
		}

		if (arg === "--interval") {
			const value = args[index + 1];
			if (!value || !isSyncIntervalPreset(value)) {
				io.error(
					value
						? `--interval must be one of: ${INTERVAL_PRESETS.join(", ")}`
						: "--interval requires a value.",
				);
				printRunUsage(io);
				return null;
			}

			watchInterval = value;
			index += 1;
			continue;
		}

		if (arg === "--connector") {
			const value = args[index + 1];
			if (
				value !== "notion" &&
				value !== "gmail" &&
				value !== "google-calendar"
			) {
				io.error(
					value
						? "--connector must be one of: notion, gmail, google-calendar"
						: "--connector requires a value.",
				);
				printRunUsage(io);
				return null;
			}

			if (target) {
				io.error("--connector cannot be used together with --integration.");
				printRunUsage(io);
				return null;
			}

			target = { kind: "connector", connectorId: value };
			index += 1;
			continue;
		}

		if (arg === "--integration") {
			const value = args[index + 1]?.trim();
			if (!value) {
				io.error("--integration requires a value.");
				printRunUsage(io);
				return null;
			}

			if (target) {
				io.error("--integration cannot be used together with --connector.");
				printRunUsage(io);
				return null;
			}

			target = { kind: "integration", integrationId: value };
			index += 1;
			continue;
		}

		if (arg === "--reset") {
			resetState = true;
			continue;
		}

		io.error(`Unknown run option: ${arg}`);
		printRunUsage(io);
		return null;
	}

	if (watchInterval && !watch) {
		io.error("--interval can only be used together with --watch.");
		printRunUsage(io);
		return null;
	}

	if (watch && target) {
		io.error(
			"--connector and --integration are only supported for one-shot runs.",
		);
		printRunUsage(io);
		return null;
	}

	if (watch && resetState) {
		io.error("--reset can only be used for one-shot runs.");
		printRunUsage(io);
		return null;
	}

	if (!watch) {
		return {
			target,
			resetState,
		};
	}

	return {
		watch: true,
		watchInterval: watchInterval ?? DEFAULT_WATCH_INTERVAL,
	};
}

async function getCredentialStatus(
	connectorId: "notion" | "gmail" | "google-calendar",
	config: SyncdownConfig,
	paths: ReturnType<typeof resolveAppPaths>,
	secrets: ReturnType<typeof createSecretsStore>,
): Promise<"complete" | "missing"> {
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

function parseCommaSeparatedIds(value: string): string[] {
	return [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0),
		),
	];
}

async function handleConfigSet(
	io: AppIo,
	argv: string[],
	secrets = createSecretsStore(),
): Promise<number> {
	const key = argv[4];
	const rawValue = argv[5];

	if (!key || !rawValue) {
		printConfigSetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const value = rawValue === "--stdin" ? await readValueFromStdin() : rawValue;
	const { config, paths } = await loadConfig();

	switch (key) {
		case "outputDir": {
			const nextValue = value.trim();
			if (!nextValue) {
				io.error("outputDir cannot be empty.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			config.outputDir = nextValue;
			await writeConfig(paths, config);
			io.write(`Set outputDir=${config.outputDir}`);
			return EXIT_CODES.OK;
		}
		case "notion.enabled": {
			const parsed = parseBoolean(value.trim());
			if (parsed === null) {
				io.error("notion.enabled must be `true` or `false`.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			getNotionIntegrationConfig(config).enabled = parsed;
			await writeConfig(paths, config);
			io.write(
				`Set notion.enabled=${getNotionIntegrationConfig(config).enabled}`,
			);
			return EXIT_CODES.OK;
		}
		case "notion.authMethod": {
			const nextValue = value.trim();
			if (nextValue !== "token" && nextValue !== "oauth") {
				io.error("notion.authMethod must be `token` or `oauth`.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			getNotionIntegrationConfig(config).connectionId =
				nextValue === "oauth"
					? DEFAULT_NOTION_OAUTH_CONNECTION_ID
					: DEFAULT_NOTION_TOKEN_CONNECTION_ID;
			await writeConfig(paths, config);
			io.write(`Set notion.authMethod=${getNotionAuthMethod(config)}`);
			return EXIT_CODES.OK;
		}
		case "notion.interval": {
			const nextValue = value.trim();
			if (!isSyncIntervalPreset(nextValue)) {
				io.error(
					`notion.interval must be one of: ${INTERVAL_PRESETS.join(", ")}`,
				);
				return EXIT_CODES.CONFIG_ERROR;
			}
			getNotionIntegrationConfig(config).interval = nextValue;
			await writeConfig(paths, config);
			io.write(
				`Set notion.interval=${getNotionIntegrationConfig(config).interval}`,
			);
			return EXIT_CODES.OK;
		}
		case "notion.token": {
			const nextValue = value.trim();
			if (!nextValue) {
				io.error("notion.token cannot be empty.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			await secrets.setSecret(
				`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
				nextValue,
				paths,
			);
			io.write("Stored notion.token in encrypted secrets store.");
			return EXIT_CODES.OK;
		}
		case "notion.oauth.clientId":
		case "notion.oauth.clientSecret":
		case "notion.oauth.refreshToken": {
			const nextValue = value.trim();
			if (!nextValue) {
				io.error(`${key} cannot be empty.`);
				return EXIT_CODES.CONFIG_ERROR;
			}
			const mappedKey =
				key === "notion.oauth.clientId"
					? getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientId
					: key === "notion.oauth.clientSecret"
						? getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID)
								.clientSecret
						: getNotionOAuthConnectionSecretNames(
								DEFAULT_NOTION_OAUTH_CONNECTION_ID,
							).refreshToken;
			await secrets.setSecret(mappedKey, nextValue, paths);
			io.write(`Stored ${key} in encrypted secrets store.`);
			return EXIT_CODES.OK;
		}
		case "gmail.enabled": {
			const parsed = parseBoolean(value.trim());
			if (parsed === null) {
				io.error("gmail.enabled must be `true` or `false`.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			getGmailIntegrationConfig(config).enabled = parsed;
			await writeConfig(paths, config);
			io.write(
				`Set gmail.enabled=${getGmailIntegrationConfig(config).enabled}`,
			);
			return EXIT_CODES.OK;
		}
		case "gmail.interval": {
			const nextValue = value.trim();
			if (!isSyncIntervalPreset(nextValue)) {
				io.error(
					`gmail.interval must be one of: ${INTERVAL_PRESETS.join(", ")}`,
				);
				return EXIT_CODES.CONFIG_ERROR;
			}
			getGmailIntegrationConfig(config).interval = nextValue;
			await writeConfig(paths, config);
			io.write(
				`Set gmail.interval=${getGmailIntegrationConfig(config).interval}`,
			);
			return EXIT_CODES.OK;
		}
		case "gmail.fetchConcurrency": {
			const parsed = parsePositiveInteger(value.trim());
			if (parsed === null) {
				io.error("gmail.fetchConcurrency must be a positive integer.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			getGmailIntegrationConfig(config).config.fetchConcurrency = parsed;
			await writeConfig(paths, config);
			io.write(
				`Set gmail.fetchConcurrency=${getGmailIntegrationConfig(config).config.fetchConcurrency}`,
			);
			return EXIT_CODES.OK;
		}
		case "gmail.syncFilter": {
			const nextValue = value.trim();
			if (!isGmailSyncFilter(nextValue)) {
				io.error(
					"gmail.syncFilter must be one of: primary, primary-important.",
				);
				return EXIT_CODES.CONFIG_ERROR;
			}
			getGmailIntegrationConfig(config).config.syncFilter = nextValue;
			await writeConfig(paths, config);
			io.write(
				`Set gmail.syncFilter=${getGmailIntegrationConfig(config).config.syncFilter}`,
			);
			return EXIT_CODES.OK;
		}
		case "googleCalendar.enabled": {
			const parsed = parseBoolean(value.trim());
			if (parsed === null) {
				io.error("googleCalendar.enabled must be `true` or `false`.");
				return EXIT_CODES.CONFIG_ERROR;
			}
			getGoogleCalendarIntegrationConfig(config).enabled = parsed;
			await writeConfig(paths, config);
			io.write(
				`Set googleCalendar.enabled=${getGoogleCalendarIntegrationConfig(config).enabled}`,
			);
			return EXIT_CODES.OK;
		}
		case "googleCalendar.interval": {
			const nextValue = value.trim();
			if (!isSyncIntervalPreset(nextValue)) {
				io.error(
					`googleCalendar.interval must be one of: ${INTERVAL_PRESETS.join(", ")}`,
				);
				return EXIT_CODES.CONFIG_ERROR;
			}
			getGoogleCalendarIntegrationConfig(config).interval = nextValue;
			await writeConfig(paths, config);
			io.write(
				`Set googleCalendar.interval=${getGoogleCalendarIntegrationConfig(config).interval}`,
			);
			return EXIT_CODES.OK;
		}
		case "googleCalendar.selectedCalendarIds": {
			const selectedCalendarIds = parseCommaSeparatedIds(value.trim());
			getGoogleCalendarIntegrationConfig(config).config.selectedCalendarIds =
				selectedCalendarIds;
			await writeConfig(paths, config);
			io.write(
				`Set googleCalendar.selectedCalendarIds=${selectedCalendarIds.join(",")}`,
			);
			return EXIT_CODES.OK;
		}
		case GOOGLE_SECRET_NAMES.clientId:
		case GOOGLE_SECRET_NAMES.clientSecret:
		case GOOGLE_SECRET_NAMES.refreshToken: {
			const nextValue = value.trim();
			if (!nextValue) {
				io.error(`${key} cannot be empty.`);
				return EXIT_CODES.CONFIG_ERROR;
			}
			await secrets.setSecret(key, nextValue, paths);
			io.write(`Stored ${key} in encrypted secrets store.`);
			return EXIT_CODES.OK;
		}
		default:
			io.error(`Unknown config key: ${key}`);
			printConfigSetUsage(io);
			return EXIT_CODES.CONFIG_ERROR;
	}
}

async function handleConfigUnset(
	io: AppIo,
	argv: string[],
	secrets = createSecretsStore(),
): Promise<number> {
	const key = argv[4];

	if (!key) {
		printConfigUnsetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const { config, paths } = await loadConfig();

	switch (key) {
		case "outputDir":
			delete config.outputDir;
			await writeConfig(paths, config);
			io.write("Removed outputDir.");
			return EXIT_CODES.OK;
		case "notion.token":
			await secrets.deleteSecret(
				`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
				paths,
			);
			io.write("Removed notion.token from encrypted secrets store.");
			return EXIT_CODES.OK;
		case "notion.oauth.clientId":
			await secrets.deleteSecret(
				getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientId,
				paths,
			);
			io.write("Removed notion.oauth.clientId from encrypted secrets store.");
			return EXIT_CODES.OK;
		case "notion.oauth.clientSecret":
			await secrets.deleteSecret(
				getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientSecret,
				paths,
			);
			io.write(
				"Removed notion.oauth.clientSecret from encrypted secrets store.",
			);
			return EXIT_CODES.OK;
		case "notion.oauth.refreshToken":
			await secrets.deleteSecret(
				getNotionOAuthConnectionSecretNames(DEFAULT_NOTION_OAUTH_CONNECTION_ID)
					.refreshToken,
				paths,
			);
			io.write(
				"Removed notion.oauth.refreshToken from encrypted secrets store.",
			);
			return EXIT_CODES.OK;
		case GOOGLE_SECRET_NAMES.clientId:
		case GOOGLE_SECRET_NAMES.clientSecret:
		case GOOGLE_SECRET_NAMES.refreshToken:
			await secrets.deleteSecret(key, paths);
			io.write(`Removed ${key} from encrypted secrets store.`);
			return EXIT_CODES.OK;
		default:
			io.error(`Unknown config key: ${key}`);
			printConfigUnsetUsage(io);
			return EXIT_CODES.CONFIG_ERROR;
	}
}

async function printOverview(
	io: AppIo,
	app: ReturnType<typeof createSyncdownApp>,
	secrets = createSecretsStore(),
): Promise<number> {
	const snapshot = await app.inspect();
	const notionConfig = getNotionIntegrationConfig(snapshot.config);
	const gmailConfig = getGmailIntegrationConfig(snapshot.config);
	const googleCalendarConfig = getGoogleCalendarIntegrationConfig(
		snapshot.config,
	);
	const notion = snapshot.integrations.find(
		(integration) => integration.connectorId === "notion",
	);
	const gmail = snapshot.integrations.find(
		(integration) => integration.connectorId === "gmail",
	);
	const googleCalendar = snapshot.integrations.find(
		(integration) => integration.connectorId === "google-calendar",
	);
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
	const hasEnabledConfiguredConnector =
		((notion?.enabled ?? notionConfig.enabled) &&
			notionCredentials === "complete") ||
		((gmail?.enabled ?? gmailConfig.enabled) &&
			gmailCredentials === "complete") ||
		((googleCalendar?.enabled ?? googleCalendarConfig.enabled) &&
			googleCalendarCredentials === "complete" &&
			googleCalendarConfig.config.selectedCalendarIds.length > 0);

	io.write("syncdown");
	io.write("");
	io.write(`config: ${snapshot.paths.configPath}`);
	io.write(`output: ${snapshot.config.outputDir ?? "<unset>"}`);
	io.write(`google: ${googleCredentials ? "connected" : "missing"}`);
	io.write(
		`notion: ${(notion?.enabled ?? notionConfig.enabled) ? "enabled" : "disabled"} | method=${getNotionAuthMethod(snapshot.config)} | interval=${notion?.interval ?? notionConfig.interval} | credentials=${notionCredentials} | last sync=${notion?.lastSyncAt ?? "never"}`,
	);
	io.write(
		`gmail: ${(gmail?.enabled ?? gmailConfig.enabled) ? "enabled" : "disabled"} | interval=${gmail?.interval ?? gmailConfig.interval} | filter=${gmailConfig.config.syncFilter ?? "primary"} | concurrency=${gmailConfig.config.fetchConcurrency ?? 10} | credentials=${gmailCredentials} | last sync=${gmail?.lastSyncAt ?? "never"}`,
	);
	io.write(
		`google-calendar: ${(googleCalendar?.enabled ?? googleCalendarConfig.enabled) ? "enabled" : "disabled"} | interval=${googleCalendar?.interval ?? googleCalendarConfig.interval} | selected calendars=${googleCalendarConfig.config.selectedCalendarIds.length} | credentials=${googleCalendarCredentials} | last sync=${googleCalendar?.lastSyncAt ?? "never"}`,
	);
	io.write("");
	io.write("Next:");

	if (!snapshot.config.outputDir || !hasEnabledConfiguredConnector) {
		if (isInteractiveTerminal()) {
			io.write("- Run `syncdown` to finish setup in the TUI.");
		} else {
			io.write(
				"- Run `syncdown config set ...` to finish setup in headless mode.",
			);
			io.write("- Example: `syncdown config set outputDir /path/to/output`");
			io.write("- Example: `syncdown config set notion.enabled true`");
			io.write("- Example: `syncdown config set notion.authMethod oauth`");
			io.write(
				"- Example: `printf '%s' \"$NOTION_TOKEN\" | syncdown config set notion.token --stdin`",
			);
			io.write(
				"- Example: `printf '%s' \"$NOTION_CLIENT_ID\" | syncdown config set notion.oauth.clientId --stdin`",
			);
			io.write(
				"- Example: `printf '%s' \"$NOTION_CLIENT_SECRET\" | syncdown config set notion.oauth.clientSecret --stdin`",
			);
			io.write(
				"- Example: `printf '%s' \"$NOTION_REFRESH_TOKEN\" | syncdown config set notion.oauth.refreshToken --stdin`",
			);
			io.write("- Example: `syncdown config set gmail.enabled true`");
			io.write("- Example: `syncdown config set gmail.syncFilter primary`");
			io.write("- Example: `syncdown config set gmail.fetchConcurrency 10`");
			io.write("- Example: `syncdown config set googleCalendar.enabled true`");
			io.write(
				"- Example: `syncdown config set googleCalendar.selectedCalendarIds primary,work@example.com`",
			);
			io.write(
				"- Example: `printf '%s' \"$GOOGLE_CLIENT_ID\" | syncdown config set google.clientId --stdin`",
			);
			io.write(
				"- Example: `printf '%s' \"$GOOGLE_CLIENT_SECRET\" | syncdown config set google.clientSecret --stdin`",
			);
			io.write(
				"- Example: `printf '%s' \"$GOOGLE_REFRESH_TOKEN\" | syncdown config set google.refreshToken --stdin`",
			);
		}
	} else {
		io.write("- Run `syncdown run` to start a sync.");
		io.write(
			`- Run \`syncdown run --watch\` to keep syncing every ${DEFAULT_WATCH_INTERVAL}.`,
		);
		if (isInteractiveTerminal()) {
			io.write("- Run `syncdown` to update settings in the TUI.");
		} else {
			io.write("- Run `syncdown doctor` for a health check.");
		}
	}

	return EXIT_CODES.OK;
}

function formatVersion(version: string): string {
	return version.startsWith("v") ? version : `v${version}`;
}

function writeUpdateStatus(io: AppIo, status: UpdateStatus): void {
	io.write(`current: ${formatVersion(status.currentVersion)}`);
	io.write(
		`latest: ${status.latestVersion ? formatVersion(status.latestVersion) : "unknown"}`,
	);
	io.write(
		`self-update: ${status.canSelfUpdate ? "available" : "unavailable"}`,
	);
	if (status.reason) {
		io.write(`reason: ${status.reason}`);
	}
	if (status.hasUpdate) {
		io.write(
			`update available: ${formatVersion(status.currentVersion)} -> ${status.latestVersion ? formatVersion(status.latestVersion) : "unknown"}`,
		);
	} else {
		io.write(`already up to date: ${formatVersion(status.currentVersion)}`);
	}
}

function writeApplyResult(io: AppIo, result: ApplyUpdateResult): void {
	io.write(result.message);
}

async function handleUpdateCommand(
	io: AppIo,
	args: string[],
	updater: SelfUpdater,
): Promise<number> {
	const checkOnly = args[0] === "--check";
	if (args.length > 1 || (args.length === 1 && !checkOnly)) {
		printUpdateUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	let status: UpdateStatus;
	try {
		status = await updater.checkForUpdate();
	} catch (error) {
		io.error(
			error instanceof Error ? error.message : "Unknown update check failure.",
		);
		return EXIT_CODES.GENERAL_ERROR;
	}

	writeUpdateStatus(io, status);
	if (checkOnly) {
		return EXIT_CODES.OK;
	}

	if (!status.canSelfUpdate) {
		io.error(status.reason ?? "Self-update is unavailable.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	if (!status.hasUpdate) {
		return EXIT_CODES.OK;
	}

	try {
		const result = await updater.applyUpdate();
		writeApplyResult(io, result);
		return EXIT_CODES.OK;
	} catch (error) {
		io.error(
			error instanceof Error ? error.message : "Unknown update failure.",
		);
		return EXIT_CODES.GENERAL_ERROR;
	}
}

function shouldRunAutoUpdateCheck(command: string | undefined): boolean {
	return (
		command !== undefined &&
		command !== "update" &&
		command !== "--help" &&
		command !== "-h"
	);
}

function startBestEffortUpdateCheck(io: AppIo, updater: SelfUpdater): void {
	void updater
		.checkForUpdate()
		.then((status) => {
			if (!status.canSelfUpdate || !status.hasUpdate || !status.latestVersion) {
				return;
			}
			io.error(
				`Update available: ${formatVersion(status.currentVersion)} -> ${formatVersion(status.latestVersion)}. Run \`syncdown update\`.`,
			);
		})
		.catch(() => {});
}

export async function runCli(
	argv = process.argv,
	dependencies: CliDependencies = {},
): Promise<number> {
	const io = dependencies.io ?? createStdIo();
	const secrets = dependencies.secrets ?? createSecretsStore();
	const app =
		dependencies.app ??
		createSyncdownApp({
			connectors: [
				createNotionConnector(),
				createGmailConnector(),
				createGoogleCalendarConnector(),
			],
			renderer: createMarkdownRenderer(),
			sink: createFileSystemSink(),
			state: createStateStore(),
			secrets,
		});
	const launchConfig = dependencies.launchConfig ?? launchConfigTui;
	const updater = dependencies.updater ?? createCliSelfUpdater();

	const command = argv[2];
	if (shouldRunAutoUpdateCheck(command)) {
		startBestEffortUpdateCheck(io, updater);
	}

	switch (command) {
		case "config": {
			const subcommand = argv[3];
			if (subcommand === "set") {
				return handleConfigSet(io, argv, secrets);
			}
			if (subcommand === "unset") {
				return handleConfigUnset(io, argv, secrets);
			}
			printConfigHelp(io);
			return EXIT_CODES.CONFIG_ERROR;
		}
		case "status":
			return printOverview(io, app, secrets);
		case "run": {
			const runOptions = parseRunOptions(argv.slice(3), io);
			if (!runOptions) {
				return EXIT_CODES.CONFIG_ERROR;
			}
			return app.run(io, runOptions);
		}
		case "connectors":
			return app.listConnectors(io);
		case "doctor":
			return app.doctor(io);
		case "update":
			return handleUpdateCommand(io, argv.slice(3), updater);
		case "--help":
		case "-h":
			printHelp();
			return EXIT_CODES.OK;
		case undefined:
			if (!isInteractiveTerminal()) {
				printHelp(io.error);
				return EXIT_CODES.CONFIG_ERROR;
			}
			return launchConfig({
				app,
				io,
				secrets,
				session: await app.openSession(),
				updater,
			});
		default:
			io.error(`Unknown command: ${command}`);
			printHelp();
			return EXIT_CODES.GENERAL_ERROR;
	}
}
