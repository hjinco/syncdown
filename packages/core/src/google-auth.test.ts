import { expect, test } from "bun:test";
import {
	assertGoogleGrantedScopes,
	collectGoogleProviderScopes,
	createGoogleAccessTokenProvider,
	GOOGLE_SECRET_NAMES,
	normalizeGoogleScopes,
	readGoogleCredentials,
} from "./google-auth.js";
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

test("normalizeGoogleScopes trims, deduplicates, and sorts", () => {
	expect(normalizeGoogleScopes([" b ", "a", "b", "", "a"])).toEqual(["a", "b"]);
});

test("collectGoogleProviderScopes unions enabled connectors and included ids", () => {
	expect(
		collectGoogleProviderScopes(
			[
				{
					id: "gmail",
					enabled: false,
					setupMethods: [
						{
							kind: "provider-oauth",
							providerId: "google",
							requiredScopes: ["scope.gmail"],
						},
					],
				},
				{
					id: "calendar",
					enabled: true,
					setupMethods: [
						{
							kind: "provider-oauth",
							providerId: "google",
							requiredScopes: ["scope.calendar", "scope.shared"],
						},
					],
				},
				{
					id: "notion",
					enabled: true,
				},
			],
			{
				includeIds: ["gmail"],
			},
		),
	).toEqual(["scope.calendar", "scope.gmail", "scope.shared"]);
});

test("readGoogleCredentials loads the canonical google secret keys", async () => {
	const secrets = createSecretsStore(
		new Map([
			[GOOGLE_SECRET_NAMES.clientId, "client-id"],
			[GOOGLE_SECRET_NAMES.clientSecret, "client-secret"],
			[GOOGLE_SECRET_NAMES.refreshToken, "refresh-token"],
		]),
	);

	await expect(readGoogleCredentials(secrets, createPaths())).resolves.toEqual({
		clientId: "client-id",
		clientSecret: "client-secret",
		refreshToken: "refresh-token",
	});
});

test("assertGoogleGrantedScopes fails when required scopes are missing", async () => {
	const fetchCalls: string[] = [];
	await expect(
		assertGoogleGrantedScopes(
			async (input) => {
				const url = String(input);
				fetchCalls.push(url);
				if (url === "https://oauth2.googleapis.com/token") {
					return new Response(
						JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
							},
						},
					);
				}

				if (
					url ===
					"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token"
				) {
					return new Response(JSON.stringify({ scope: "scope.gmail" }), {
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					});
				}

				throw new Error(`unexpected url: ${url}`);
			},
			{
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "refresh-token",
			},
			["scope.gmail", "scope.calendar"],
		),
	).rejects.toThrow("scope.calendar");

	expect(fetchCalls).toEqual([
		"https://oauth2.googleapis.com/token",
		"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token",
	]);
});

test("createGoogleAccessTokenProvider caches refreshed access tokens", async () => {
	let tokenCalls = 0;
	const provider = createGoogleAccessTokenProvider(async (input) => {
		const url = String(input);
		if (url !== "https://oauth2.googleapis.com/token") {
			throw new Error(`unexpected url: ${url}`);
		}

		tokenCalls += 1;
		return new Response(
			JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			},
		);
	});

	const credentials = {
		clientId: "client-id",
		clientSecret: "client-secret",
		refreshToken: "refresh-token",
	};

	await expect(provider.getAccessToken(credentials)).resolves.toBe(
		"access-token",
	);
	await expect(provider.getAccessToken(credentials)).resolves.toBe(
		"access-token",
	);
	expect(tokenCalls).toBe(1);
});
