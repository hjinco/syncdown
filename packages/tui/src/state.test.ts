import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";

import {
	type AppPaths,
	createDefaultConfig,
	getDefaultIntegration,
	type SecretsStore,
	type SyncdownConfig,
} from "@syncdown/core";

import {
	applySecretAction,
	cloneDraftState,
	createDraftState,
	getConnectorStatus,
	getDraftNotionAuthMethod,
	hasCompleteGoogleCredentials,
	normalizeOutputPath,
	saveDraft,
	setConnectorEnabled,
	setOutputDirectory,
	setSyncInterval,
	stageConnectorDisconnect,
	stageGoogleConnection,
	stageNotionConnection,
	stageNotionOAuthConnection,
	stageProviderDisconnect,
	syncDraftState,
} from "./state.js";

function createConfig(): SyncdownConfig {
	const config = createDefaultConfig();
	getDefaultIntegration(config, "notion").enabled = true;
	getDefaultIntegration(config, "gmail").enabled = false;
	return config;
}

function createSecrets() {
	return {
		notionTokenStored: true,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	};
}

function createPaths(): AppPaths {
	const root = mkdtempSync(
		path.join(resolveTempDirectory(), "syncdown-state-"),
	);
	return {
		configDir: path.join(root, "config"),
		dataDir: path.join(root, "data"),
		configPath: path.join(root, "config", "config.json"),
		statePath: path.join(root, "data", "state.sqlite"),
		secretsPath: path.join(root, "data", "secrets.json"),
		masterKeyPath: path.join(root, "data", "master.key"),
		lockPath: path.join(root, "data", "run.lock"),
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

function createSecretsStore(values = new Map<string, string>()): SecretsStore {
	return {
		async hasSecret(name) {
			return values.has(name);
		},
		async getSecret(name) {
			return values.get(name) ?? null;
		},
		async setSecret(name, value) {
			values.set(name, value);
		},
		async deleteSecret(name) {
			values.delete(name);
		},
		describe() {
			return "memory";
		},
	};
}

test("editing connector state updates the config", () => {
	const draft = createDraftState(createConfig(), createSecrets());

	setConnectorEnabled(draft, "notion", false);

	expect(getDefaultIntegration(draft.config, "notion").enabled).toBe(false);
});

test("notion token action transitions keep set and delete semantics", () => {
	const draft = createDraftState(createConfig(), createSecrets());

	applySecretAction(draft, "notionToken", "set", "secret-token");
	expect(draft.notionToken.action).toBe("set");
	expect(draft.notionToken.value).toBe("secret-token");
	expect(draft.notionToken.stored).toBe(true);

	applySecretAction(draft, "notionToken", "delete");
	expect(draft.notionToken.action).toBe("delete");
	expect(draft.notionToken.stored).toBe(false);
	expect(draft.notionToken.value).toBe("");
});

test("google credentials become complete only when all three values exist", () => {
	const draft = createDraftState(createConfig(), createSecrets());

	expect(hasCompleteGoogleCredentials(draft)).toBe(false);
	applySecretAction(draft, "googleClientId", "set", "client-id");
	applySecretAction(draft, "googleClientSecret", "set", "client-secret");
	expect(hasCompleteGoogleCredentials(draft)).toBe(false);
	applySecretAction(draft, "googleRefreshToken", "set", "refresh-token");
	expect(hasCompleteGoogleCredentials(draft)).toBe(true);
});

test("connector status reports needs setup when enabled credentials are missing", () => {
	const draft = createDraftState(createConfig(), createSecrets());

	expect(getConnectorStatus(draft, "notion")).toEqual({
		label: "connected",
		description: "Ready to sync.",
	});
	expect(getConnectorStatus(draft, "gmail")).toEqual({
		label: "disconnected",
		description: "No stored credentials.",
	});
});

test("google staged connection stores all required secret updates", () => {
	const draft = createDraftState(createConfig(), createSecrets());

	stageGoogleConnection(draft, "client-id", "client-secret", "refresh-token");

	expect(getDefaultIntegration(draft.config, "gmail").enabled).toBe(true);
	expect(draft.googleClientId.action).toBe("set");
	expect(draft.googleClientSecret.action).toBe("set");
	expect(draft.googleRefreshToken.action).toBe("set");
});

test("notion oauth staged connection switches the active method and stores oauth secrets", () => {
	const draft = createDraftState(createConfig(), createSecrets());

	stageNotionOAuthConnection(
		draft,
		"client-id",
		"client-secret",
		"refresh-token",
		{
			workspaceId: "workspace-1",
			workspaceName: "Team Space",
		},
	);

	expect(getDraftNotionAuthMethod(draft)).toBe("oauth");
	expect(draft.notionOauthClientId.action).toBe("set");
	expect(draft.notionOauthClientSecret.action).toBe("set");
	expect(draft.notionOauthRefreshToken.action).toBe("set");
});

test("gmail disconnect keeps the stored google account and disables the connector", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	setConnectorEnabled(draft, "gmail", true);
	stageConnectorDisconnect(draft, "gmail");

	expect(getDefaultIntegration(draft.config, "gmail").enabled).toBe(false);
	expect(draft.googleClientId.action).toBe("keep");
	expect(draft.googleClientSecret.action).toBe("keep");
	expect(draft.googleRefreshToken.action).toBe("keep");
});

test("google account disconnect deletes shared credentials and disables gmail", () => {
	const draft = createDraftState(createConfig(), {
		notionTokenStored: true,
		googleClientIdStored: true,
		googleClientSecretStored: true,
		googleRefreshTokenStored: true,
	});

	setConnectorEnabled(draft, "gmail", true);
	stageProviderDisconnect(draft, "google");

	expect(getDefaultIntegration(draft.config, "gmail").enabled).toBe(false);
	expect(draft.googleClientId.action).toBe("delete");
	expect(draft.googleClientSecret.action).toBe("delete");
	expect(draft.googleRefreshToken.action).toBe("delete");
});

test("output preset and interval updates modify the draft immediately", () => {
	const draft = createDraftState(createConfig(), createSecrets());
	const customPath = normalizeOutputPath("./tmp-output");

	setOutputDirectory(draft, customPath);
	setSyncInterval(draft, "gmail", "24h");

	expect(draft.config.outputDir).toBe(customPath);
	expect(getDefaultIntegration(draft.config, "gmail").interval).toBe("24h");
});

test("clone and sync draft state support atomic persistence", () => {
	const draft = createDraftState(createConfig(), createSecrets());
	const clone = cloneDraftState(draft);

	stageNotionConnection(clone, "fresh-token");
	setOutputDirectory(clone, "/tmp/output");
	syncDraftState(draft, clone);

	expect(draft.notionToken.value).toBe("fresh-token");
	expect(draft.config.outputDir).toBe("/tmp/output");
});

test("saveDraft writes config and resets secret actions", async () => {
	const paths = createPaths();
	const draft = createDraftState(createConfig(), {
		notionTokenStored: false,
		googleClientIdStored: false,
		googleClientSecretStored: false,
		googleRefreshTokenStored: false,
	});
	const secrets = createSecretsStore();

	stageNotionConnection(draft, "secret-token");
	setOutputDirectory(draft, "/tmp/output");

	await saveDraft(paths, secrets, draft);

	expect(JSON.parse(readFileSync(paths.configPath, "utf8"))).toEqual(
		draft.config,
	);
	expect(draft.notionToken.action).toBe("keep");
	expect(
		await secrets.getSecret("connections.notion-token-default.token", paths),
	).toBe("secret-token");
});
