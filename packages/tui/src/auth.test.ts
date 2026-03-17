import { expect, test } from "bun:test";

import type {
	AppPaths,
	Connector,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	HealthCheck,
} from "@syncdown/core";

import { createTuiAuthService } from "./auth.js";

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

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

test("oauth setup pages open their expected provider URLs", async () => {
	const openedUrls: string[] = [];
	const auth = createTuiAuthService({
		browserOpener: {
			async open(url): Promise<void> {
				openedUrls.push(url);
			},
		},
	});

	await expect(auth.openUrl("/ko/docs/connectors/notion")).resolves.toEqual({
		opened: true,
	});
	await expect(auth.openNotionOAuthSetup()).resolves.toEqual({ opened: true });
	await expect(auth.openGoogleOAuthSetup()).resolves.toEqual({ opened: true });

	expect(openedUrls).toEqual([
		"/ko/docs/connectors/notion",
		"https://www.notion.so/profile/integrations",
		"https://console.cloud.google.com/auth/clients",
	]);
});

test("oauth setup page open failures return browser launch errors", async () => {
	const auth = createTuiAuthService({
		browserOpener: {
			async open(url): Promise<void> {
				throw new Error(`failed to open ${url}`);
			},
		},
	});

	await expect(auth.openUrl("/docs/connectors/gmail")).resolves.toEqual({
		opened: false,
		error: "failed to open /docs/connectors/gmail",
	});
	await expect(auth.openNotionOAuthSetup()).resolves.toEqual({
		opened: false,
		error: "failed to open https://www.notion.so/profile/integrations",
	});
	await expect(auth.openGoogleOAuthSetup()).resolves.toEqual({
		opened: false,
		error: "failed to open https://console.cloud.google.com/auth/clients",
	});
});

test("google auth session can complete even when browser open fails", async () => {
	let callbackHandler: unknown = null;
	const auth = createTuiAuthService({
		browserOpener: {
			async open(): Promise<void> {
				throw new Error("open failed");
			},
		},
		async callbackServerFactory(handler) {
			callbackHandler = handler;
			return {
				port: 43123,
				async close() {},
			};
		},
		oauthClientFactory(clientId, _clientSecret, _redirectUri) {
			return {
				generateAuthUrl({ redirect_uri, state }) {
					return `https://accounts.example/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state)}`;
				},
				async getToken({ code }) {
					expect(code).toBe("auth-code");
					return {
						tokens: {
							refresh_token: "refresh-token",
						},
					};
				},
			};
		},
	});

	const session = await auth.startGoogleSession("client-id", "client-secret", [
		GMAIL_SCOPE,
	]);
	expect(session.browserOpened).toBe(false);
	expect(session.browserError).toContain("open failed");

	const authUrl = new URL(session.authorizationUrl);
	const redirectUri = authUrl.searchParams.get("redirect_uri")!;
	const state = authUrl.searchParams.get("state")!;
	const completion = session.complete(1_000);
	if (!callbackHandler) {
		throw new Error("expected callback handler");
	}
	const callbackResponse = (
		callbackHandler as (url: URL) => { status: number; body: string }
	)(new URL(`${redirectUri}?code=auth-code&state=${state}`));

	expect(callbackResponse?.status).toBe(200);
	expect(callbackResponse?.body).toContain("Login completed");
	await expect(completion).resolves.toEqual({ refreshToken: "refresh-token" });
});

test("google auth session rejects callback state mismatch", async () => {
	let callbackHandler: unknown = null;
	const auth = createTuiAuthService({
		browserOpener: {
			async open(): Promise<void> {},
		},
		async callbackServerFactory(handler) {
			callbackHandler = handler;
			return {
				port: 43124,
				async close() {},
			};
		},
		oauthClientFactory() {
			return {
				generateAuthUrl({ redirect_uri, state }) {
					return `https://accounts.example/auth?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state)}`;
				},
				async getToken() {
					throw new Error("should not be called");
				},
			};
		},
	});

	const session = await auth.startGoogleSession("client-id", "client-secret", [
		GMAIL_SCOPE,
	]);
	const authUrl = new URL(session.authorizationUrl);
	const redirectUri = authUrl.searchParams.get("redirect_uri")!;
	const completion = session.complete(1_000);
	if (!callbackHandler) {
		throw new Error("expected callback handler");
	}
	const callbackResponse = (
		callbackHandler as (url: URL) => { status: number; body: string }
	)(new URL(`${redirectUri}?code=auth-code&state=wrong-state`));

	expect(callbackResponse?.status).toBe(400);
	await expect(completion).rejects.toThrow("state mismatch");
});

test("default google oauth client exchanges code over fetch", async () => {
	let callbackHandler: unknown = null;
	const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
	const auth = createTuiAuthService({
		browserOpener: {
			async open(): Promise<void> {},
		},
		async callbackServerFactory(handler) {
			callbackHandler = handler;
			return {
				port: 43125,
				async close() {},
			};
		},
		async fetchImpl(input, init) {
			fetchCalls.push({ url: String(input), init });
			return new Response(JSON.stringify({ refresh_token: "refresh-token" }), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			});
		},
	});

	const session = await auth.startGoogleSession("client-id", "client-secret", [
		GMAIL_SCOPE,
	]);
	const authUrl = new URL(session.authorizationUrl);
	expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
		"https://accounts.google.com/o/oauth2/v2/auth",
	);
	expect(authUrl.searchParams.get("client_id")).toBe("client-id");
	expect(authUrl.searchParams.get("response_type")).toBe("code");
	expect(authUrl.searchParams.get("access_type")).toBe("offline");
	expect(authUrl.searchParams.get("prompt")).toBe("consent");
	expect(authUrl.searchParams.get("scope")).toContain("gmail.readonly");

	const redirectUri = authUrl.searchParams.get("redirect_uri")!;
	const state = authUrl.searchParams.get("state")!;
	const completion = session.complete(1_000);
	if (!callbackHandler) {
		throw new Error("expected callback handler");
	}

	(callbackHandler as (url: URL) => { status: number; body: string })(
		new URL(`${redirectUri}?code=auth-code&state=${state}`),
	);

	await expect(completion).resolves.toEqual({ refreshToken: "refresh-token" });
	expect(fetchCalls).toHaveLength(1);
	expect(fetchCalls[0]?.url).toBe("https://oauth2.googleapis.com/token");
	expect(fetchCalls[0]?.init?.method).toBe("POST");
	expect(String(fetchCalls[0]?.init?.body)).toContain(
		"grant_type=authorization_code",
	);
	expect(String(fetchCalls[0]?.init?.body)).toContain("code=auth-code");
	expect(String(fetchCalls[0]?.init?.body)).toContain("client_id=client-id");
});

test("notion oauth session exchanges the callback code over fetch", async () => {
	let callbackHandler: unknown = null;
	const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
	const auth = createTuiAuthService({
		browserOpener: {
			async open(): Promise<void> {},
		},
		async callbackServerFactory(handler) {
			callbackHandler = handler;
			return {
				port: 43126,
				async close() {},
			};
		},
		async fetchImpl(input, init) {
			fetchCalls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					access_token: "notion-access-token",
					refresh_token: "notion-refresh-token",
					workspace_id: "workspace-1",
					workspace_name: "Team Space",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		},
	});

	const session = await auth.startNotionOAuthSession(
		"client-id",
		"client-secret",
	);
	const authUrl = new URL(session.authorizationUrl);
	expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
		"https://api.notion.com/v1/oauth/authorize",
	);
	expect(authUrl.searchParams.get("client_id")).toBe("client-id");
	expect(authUrl.searchParams.get("response_type")).toBe("code");
	expect(authUrl.searchParams.get("owner")).toBe("user");

	const redirectUri = authUrl.searchParams.get("redirect_uri")!;
	const state = authUrl.searchParams.get("state")!;
	const completion = session.complete(1_000);
	if (!callbackHandler) {
		throw new Error("expected callback handler");
	}

	(callbackHandler as (url: URL) => { status: number; body: string })(
		new URL(`${redirectUri}?code=auth-code&state=${state}`),
	);

	await expect(completion).resolves.toEqual({
		accessToken: "notion-access-token",
		refreshToken: "notion-refresh-token",
		workspaceId: "workspace-1",
		workspaceName: "Team Space",
	});
	expect(fetchCalls[0]?.url).toBe("https://api.notion.com/v1/oauth/token");
	expect(fetchCalls[0]?.init?.method).toBe("POST");
});

test("auth validation reuses notion connector validation and checks google scopes", async () => {
	const checks: string[] = [];
	const fetchCalls: string[] = [];
	const createConnector = (expectedId: "notion"): Connector => ({
		id: expectedId,
		label: "Notion",
		setupMethods: [
			{ kind: "token" },
			{ kind: "provider-oauth", providerId: "notion", requiredScopes: [] },
		],
		async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
			checks.push(expectedId);
			expect(request.integration.connectorId).toBe("notion");
			expect(request.integration.enabled).toBe(true);
			expect(
				await request.secrets.getSecret(
					"connections.notion-token-default.token",
					request.paths,
				),
			).toBe("secret-token");

			return {
				status: "ok",
				message: "ok",
			};
		},
		async sync(_request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
			return {
				nextCursor: null,
			};
		},
	});

	const auth = createTuiAuthService({
		browserOpener: {
			async open(): Promise<void> {},
		},
		notionConnectorFactory: () => createConnector("notion"),
		async fetchImpl(input) {
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
				return new Response(JSON.stringify({ scope: GMAIL_SCOPE }), {
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				});
			}

			throw new Error(`unexpected url: ${url}`);
		},
	});

	await auth.validateNotionToken(createPaths(), "secret-token");
	await auth.validateGoogleCredentials(
		createPaths(),
		{
			clientId: "client-id",
			clientSecret: "client-secret",
			refreshToken: "refresh-token",
		},
		[GMAIL_SCOPE],
	);

	expect(checks).toEqual(["notion"]);
	expect(fetchCalls).toEqual([
		"https://oauth2.googleapis.com/token",
		"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token",
	]);
});
