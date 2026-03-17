import { expect, test } from "bun:test";
import {
	buildNotionAuthUrl,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
	readNotionOAuthConnectionCredentials,
	refreshNotionAccessToken,
} from "./notion-auth.js";
import type { AppPaths, SecretsStore } from "./types.js";

function createPaths(): AppPaths {
	return {
		configDir: "/tmp/config",
		dataDir: "/tmp/data",
		configPath: "/tmp/config/config.json",
		statePath: "/tmp/data/state.db",
		secretsPath: "/tmp/data/secrets.enc",
		masterKeyPath: "/tmp/data/master.key",
		lockPath: "/tmp/data/sync.lock",
	};
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

test("buildNotionAuthUrl includes the required oauth parameters", () => {
	const url = new URL(
		buildNotionAuthUrl({
			clientId: "client-id",
			redirectUri: "http://127.0.0.1:43126/oauth2callback",
			state: "state-123",
		}),
	);

	expect(`${url.origin}${url.pathname}`).toBe(
		"https://api.notion.com/v1/oauth/authorize",
	);
	expect(url.searchParams.get("client_id")).toBe("client-id");
	expect(url.searchParams.get("redirect_uri")).toBe(
		"http://127.0.0.1:43126/oauth2callback",
	);
	expect(url.searchParams.get("response_type")).toBe("code");
	expect(url.searchParams.get("owner")).toBe("user");
	expect(url.searchParams.get("state")).toBe("state-123");
});

test("readNotionOAuthConnectionCredentials loads the canonical notion oauth secret keys", async () => {
	const oauthSecrets = getNotionOAuthAppSecretNames("notion-oauth-app-default");
	const connectionSecrets = getNotionOAuthConnectionSecretNames(
		"notion-oauth-default",
	);
	const secrets = createSecretsStore(
		new Map([
			[oauthSecrets.clientId, "client-id"],
			[oauthSecrets.clientSecret, "client-secret"],
			[connectionSecrets.refreshToken, "refresh-token"],
		]),
	);

	await expect(
		readNotionOAuthConnectionCredentials(secrets, createPaths()),
	).resolves.toEqual({
		clientId: "client-id",
		clientSecret: "client-secret",
		refreshToken: "refresh-token",
	});
});

test("refreshNotionAccessToken returns access token and rotated refresh token", async () => {
	const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
	const result = await refreshNotionAccessToken(
		async (input, init) => {
			fetchCalls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token-2",
					workspace_id: "workspace-1",
					workspace_name: "Team Space",
					bot_id: "bot-1",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		},
		{
			clientId: "client-id",
			clientSecret: "client-secret",
			refreshToken: "refresh-token-1",
		},
	);

	expect(result).toEqual({
		accessToken: "access-token",
		refreshToken: "refresh-token-2",
		workspaceId: "workspace-1",
		workspaceName: "Team Space",
		botId: "bot-1",
	});
	expect(fetchCalls[0]?.url).toBe("https://api.notion.com/v1/oauth/token");
	expect(fetchCalls[0]?.init?.method).toBe("POST");
});
