import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
	ensureAppDirectories,
	readConfig,
	resolveAppPaths,
	writeConfig,
} from "./config.js";
import {
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	getDefaultIntegration,
	isGmailIntegration,
} from "./config-model.js";
import { createTestPaths } from "./test-support.js";

test("readConfig returns defaults when config file is missing", async () => {
	const { cleanup, paths } = await createTestPaths();

	try {
		await rm(paths.configPath, { force: true });
		const config = await readConfig(paths);
		const notion = getDefaultIntegration(config, "notion");
		expect(config.outputDir).toBeUndefined();
		expect(notion.enabled).toBe(false);
		expect(notion.label).toBe("Notion");
		expect(notion.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const gmail = getDefaultIntegration(config, "gmail");
		expect(gmail.label).toBe("Gmail");
		expect(gmail.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(
			isGmailIntegration(gmail) ? gmail.config.syncFilter : undefined,
		).toBe("primary");
	} finally {
		await cleanup();
	}
});

test("normalizeConfig re-seeds a missing integration per connector without duplicating existing connectors", async () => {
	const { cleanup, paths, config } = await createTestPaths();

	try {
		const notionId = getDefaultIntegration(config, "notion").id;
		config.integrations = config.integrations.filter(
			(integration) => integration.connectorId !== "gmail",
		);
		await writeConfig(paths, config);

		const reloaded = await readConfig(paths);
		const notionIntegrations = reloaded.integrations.filter(
			(integration) => integration.connectorId === "notion",
		);
		const gmailIntegrations = reloaded.integrations.filter(
			(integration) => integration.connectorId === "gmail",
		);

		expect(notionIntegrations).toHaveLength(1);
		expect(gmailIntegrations).toHaveLength(1);
		expect(notionIntegrations[0]?.id).toBe(notionId);
		expect(gmailIntegrations[0]?.label).toBe("Gmail");
		expect(gmailIntegrations[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
	} finally {
		await cleanup();
	}
});

test("writeConfig persists config after ensuring app directories", async () => {
	const { cleanup, paths, config } = await createTestPaths();

	try {
		await ensureAppDirectories(paths);
		const gmail = getDefaultIntegration(config, "gmail");
		if (!isGmailIntegration(gmail)) {
			throw new Error("expected gmail integration");
		}
		gmail.enabled = true;
		gmail.config.syncFilter = "primary-important";
		await writeConfig(paths, config);

		const reloaded = await readConfig(paths);
		const reloadedGmail = getDefaultIntegration(reloaded, "gmail");
		expect(reloadedGmail.enabled).toBe(true);
		expect(
			isGmailIntegration(reloadedGmail)
				? reloadedGmail.config.syncFilter
				: undefined,
		).toBe("primary-important");
		expect(reloaded.outputDir).toBe(config.outputDir);
	} finally {
		await cleanup();
	}
});

test("readConfig normalizes legacy gmail config without a sync filter", async () => {
	const { cleanup, paths, config } = await createTestPaths();

	try {
		const gmail = getDefaultIntegration(config, "gmail");
		if (!isGmailIntegration(gmail)) {
			throw new Error("expected gmail integration");
		}
		delete gmail.config.syncFilter;
		await writeConfig(paths, config);

		const reloaded = await readConfig(paths);
		const reloadedGmail = getDefaultIntegration(reloaded, "gmail");
		expect(
			isGmailIntegration(reloadedGmail)
				? reloadedGmail.config.syncFilter
				: undefined,
		).toBe("primary");
	} finally {
		await cleanup();
	}
});

test("readConfig preserves notion token and oauth connections", async () => {
	const { cleanup, paths, config } = await createTestPaths();

	try {
		const notion = getDefaultIntegration(config, "notion");
		notion.connectionId = DEFAULT_NOTION_OAUTH_CONNECTION_ID;
		await writeConfig(paths, config);

		const reloaded = await readConfig(paths);
		expect(getDefaultIntegration(reloaded, "notion").connectionId).toBe(
			DEFAULT_NOTION_OAUTH_CONNECTION_ID,
		);
		expect(
			reloaded.connections.some(
				(connection) => connection.id === DEFAULT_NOTION_TOKEN_CONNECTION_ID,
			),
		).toBe(true);
		expect(
			reloaded.connections.some(
				(connection) => connection.id === DEFAULT_NOTION_OAUTH_CONNECTION_ID,
			),
		).toBe(true);
	} finally {
		await cleanup();
	}
});

test("readConfig re-seeds the default Notion oauth app when it is missing", async () => {
	const { cleanup, paths, config } = await createTestPaths();

	try {
		config.oauthApps = config.oauthApps.filter(
			(oauthApp) => oauthApp.id !== DEFAULT_NOTION_OAUTH_APP_ID,
		);
		getDefaultIntegration(config, "notion").connectionId =
			DEFAULT_NOTION_OAUTH_CONNECTION_ID;
		await writeConfig(paths, config);

		const reloaded = await readConfig(paths);
		expect(
			reloaded.oauthApps.some(
				(oauthApp) => oauthApp.id === DEFAULT_NOTION_OAUTH_APP_ID,
			),
		).toBe(true);
		expect(getDefaultIntegration(reloaded, "notion").connectionId).toBe(
			DEFAULT_NOTION_OAUTH_CONNECTION_ID,
		);
	} finally {
		await cleanup();
	}
});

test("resolveAppPaths respects XDG environment overrides", () => {
	const paths = resolveAppPaths({
		platform: "linux",
		env: {
			HOME: "/tmp/syncdown-home",
			XDG_CONFIG_HOME: "/tmp/syncdown-config-home",
			XDG_DATA_HOME: "/tmp/syncdown-data-home",
		},
	});

	expect(paths.configDir).toBe(
		path.join("/tmp/syncdown-config-home", "syncdown"),
	);
	expect(paths.dataDir).toBe(path.join("/tmp/syncdown-data-home", "syncdown"));
	expect(paths.lockPath).toBe(
		path.join("/tmp/syncdown-data-home", "syncdown", "sync.lock"),
	);
});

test("resolveAppPaths uses AppData defaults on Windows", () => {
	const paths = resolveAppPaths({
		platform: "win32",
		env: {
			USERPROFILE: "C:\\Users\\tester",
			APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
		},
	});

	expect(paths.configDir).toBe("C:\\Users\\tester\\AppData\\Roaming\\syncdown");
	expect(paths.dataDir).toBe("C:\\Users\\tester\\AppData\\Local\\syncdown");
	expect(paths.configPath).toBe(
		"C:\\Users\\tester\\AppData\\Roaming\\syncdown\\config.json",
	);
	expect(paths.statePath).toBe(
		"C:\\Users\\tester\\AppData\\Local\\syncdown\\state.db",
	);
});
