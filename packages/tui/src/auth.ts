import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
	createGoogleCalendarAdapter,
	type GoogleCalendarSummary,
} from "@syncdown/connector-google-calendar";
import { createNotionConnector } from "@syncdown/connector-notion";
import type {
	AppIo,
	AppPaths,
	Connector,
	ConnectorSyncRequest,
	GoogleOAuthCredentials,
	HealthCheck,
	NotionOAuthResolvedAuth,
	SecretsStore,
	SourceRecord,
	SourceSnapshot,
	StateStore,
	StoredSourceSnapshot,
	SyncdownConfig,
} from "@syncdown/core";
import {
	assertGoogleGrantedScopes,
	buildGoogleAuthUrl,
	buildNotionAuthUrl,
	createDefaultConfig,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	exchangeGoogleAuthCode,
	exchangeNotionAuthCode,
	getDefaultConnection,
	getDefaultIntegration,
	NOTION_SETUP_URL,
} from "@syncdown/core";

const CALLBACK_PATH = "/oauth2callback";
const CALLBACK_RESPONSE = "Login completed. Return to syncdown.";
const GOOGLE_OAUTH_SETUP_URL = "https://console.cloud.google.com/auth/clients";

export interface BrowserOpenResult {
	opened: boolean;
	error?: string;
}

export type GoogleAuthCredentials = GoogleOAuthCredentials;

export interface GoogleAuthSession {
	readonly authorizationUrl: string;
	readonly browserOpened: boolean;
	readonly browserError?: string;
	complete(timeoutMs: number): Promise<{ refreshToken: string }>;
	cancel(): Promise<void>;
}

export interface NotionOAuthSession {
	readonly authorizationUrl: string;
	readonly browserOpened: boolean;
	readonly browserError?: string;
	complete(timeoutMs: number): Promise<{
		accessToken: string;
		refreshToken: string;
		workspaceId?: string;
		workspaceName?: string;
		botId?: string;
		ownerUserId?: string;
		ownerUserName?: string;
	}>;
	cancel(): Promise<void>;
}

type FetchImpl = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface TuiAuthService {
	openUrl(url: string): Promise<BrowserOpenResult>;
	startGoogleSession(
		clientId: string,
		clientSecret: string,
		scopes: string[],
	): Promise<GoogleAuthSession>;
	startNotionOAuthSession(
		clientId: string,
		clientSecret: string,
	): Promise<NotionOAuthSession>;
	openNotionSetup(): Promise<BrowserOpenResult>;
	openNotionOAuthSetup(): Promise<BrowserOpenResult>;
	openGoogleOAuthSetup(): Promise<BrowserOpenResult>;
	validateNotionToken(paths: AppPaths, token: string): Promise<void>;
	validateNotionOAuthAccessToken(
		paths: AppPaths,
		accessToken: string,
	): Promise<void>;
	validateGoogleCredentials(
		paths: AppPaths,
		credentials: GoogleAuthCredentials,
		requiredScopes: readonly string[],
	): Promise<void>;
	listGoogleCalendars?(
		credentials: GoogleAuthCredentials,
	): Promise<GoogleCalendarSummary[]>;
}

interface BrowserOpener {
	open(url: string): Promise<void>;
}

interface GoogleOAuthClient {
	generateAuthUrl(options: {
		access_type: "offline";
		prompt: "consent";
		scope: string[];
		redirect_uri: string;
		state: string;
	}): string;
	getToken(options: { code: string; redirect_uri: string }): Promise<{
		tokens: { refresh_token?: string | null };
	}>;
}

export interface CreateTuiAuthServiceOptions {
	browserOpener?: BrowserOpener;
	notionConnectorFactory?: () => Connector;
	oauthClientFactory?: (
		clientId: string,
		clientSecret: string,
		redirectUri: string,
	) => GoogleOAuthClient;
	callbackServerFactory?: (
		handler: (url: URL) => { status: number; body: string },
	) => Promise<LoopbackServer>;
	fetchImpl?: FetchImpl;
}

interface CallbackResult {
	status: number;
	body: string;
	code?: string;
	error?: Error;
}

interface LoopbackServer {
	port: number;
	close(): Promise<void>;
}

function createValidationConfig(
	enabledConnector: "notion" | "gmail",
): SyncdownConfig {
	const config = createDefaultConfig();
	getDefaultIntegration(config, "notion").enabled =
		enabledConnector === "notion";
	getDefaultIntegration(config, "gmail").enabled = enabledConnector === "gmail";
	return config;
}

function createSilentIo(): AppIo {
	return {
		write() {},
		error() {},
	};
}

class ValidationSecretsStore implements SecretsStore {
	constructor(private readonly values: Map<string, string>) {}

	async hasSecret(name: string): Promise<boolean> {
		return this.values.has(name);
	}

	async getSecret(name: string): Promise<string | null> {
		return this.values.get(name) ?? null;
	}

	async setSecret(name: string, value: string): Promise<void> {
		this.values.set(name, value);
	}

	async deleteSecret(name: string): Promise<void> {
		this.values.delete(name);
	}

	describe(): string {
		return "validation-memory";
	}
}

class NullStateStore implements StateStore {
	async getCursor(): Promise<string | null> {
		return null;
	}

	async setCursor(): Promise<void> {}

	async getLastSyncAt(): Promise<string | null> {
		return null;
	}

	async setLastSyncAt(): Promise<void> {}

	async resetIntegration(): Promise<SourceRecord[]> {
		return [];
	}

	async getSourceRecord(): Promise<SourceRecord | null> {
		return null;
	}

	async listSourceRecords(): Promise<SourceRecord[]> {
		return [];
	}

	async upsertSourceRecord(): Promise<void> {}

	async deleteSourceRecord(): Promise<void> {}

	async getSourceSnapshot(): Promise<StoredSourceSnapshot | null> {
		return null;
	}

	async upsertSourceSnapshot(): Promise<void> {}

	async deleteSourceSnapshot(): Promise<void> {}

	async describe(): Promise<string[]> {
		return [];
	}
}

function createValidationRequest(
	paths: AppPaths,
	config: SyncdownConfig,
	secrets: SecretsStore,
	options: {
		connector: "notion" | "gmail";
		notionConnectionId?: string;
		resolvedAuth: ConnectorSyncRequest["resolvedAuth"];
	},
): ConnectorSyncRequest {
	const integration = getDefaultIntegration(config, options.connector);
	integration.enabled = true;
	if (options.connector === "notion" && options.notionConnectionId) {
		integration.connectionId = options.notionConnectionId;
	}
	const connection = getDefaultConnection(config, options.connector);
	return {
		config,
		integration,
		connection,
		io: createSilentIo(),
		paths,
		since: null,
		renderVersion: "tui-auth",
		secrets,
		state: new NullStateStore(),
		resolvedAuth: options.resolvedAuth,
		throwIfCancelled() {},
		persistSource: async (_source: SourceSnapshot) => {},
		deleteSource: async (_sourceId: string) => {},
		resetIntegrationState: async () => {},
		setProgress: () => {},
	};
}

async function assertHealthy(check: HealthCheck): Promise<void> {
	if (check.status !== "ok") {
		throw new Error(check.message);
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		handle = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
	});

	return Promise.race([promise, timeout]).finally(() => {
		if (handle) {
			clearTimeout(handle);
		}
	});
}

async function openBrowserTarget(
	browserOpener: BrowserOpener,
	url: string,
): Promise<BrowserOpenResult> {
	try {
		await browserOpener.open(url);
		return { opened: true };
	} catch (error) {
		return {
			opened: false,
			error:
				error instanceof Error
					? error.message
					: "Unknown browser launch failure.",
		};
	}
}

function createSystemBrowserOpener(): BrowserOpener {
	return {
		async open(url: string): Promise<void> {
			const platform = process.platform;
			const [command, args] =
				platform === "darwin"
					? ["open", [url]]
					: platform === "win32"
						? ["cmd", ["/c", "start", "", url]]
						: ["xdg-open", [url]];

			await new Promise<void>((resolve, reject) => {
				const child = spawn(command, args, {
					stdio: "ignore",
				});
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) {
						return;
					}
					settled = true;
					if (error) {
						reject(error);
						return;
					}
					resolve();
				};

				child.once("error", (error) => finish(error));
				child.once("spawn", () => finish());
			});
		},
	};
}

function createGoogleOAuthClient(
	fetchImpl: FetchImpl,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
): GoogleOAuthClient {
	return {
		generateAuthUrl(options) {
			return buildGoogleAuthUrl({
				clientId,
				redirectUri,
				scopes: options.scope,
				state: options.state,
			});
		},
		async getToken(options) {
			const response = await exchangeGoogleAuthCode(
				fetchImpl,
				clientId,
				clientSecret,
				{
					code: options.code,
					redirectUri,
				},
			);
			return {
				tokens: {
					refresh_token: response.refresh_token ?? null,
				},
			};
		},
	};
}

function createLoopbackServerFactory() {
	return async (
		handler: (url: URL) => { status: number; body: string },
	): Promise<LoopbackServer> => {
		const bunApi = (
			globalThis as {
				Bun?: {
					serve?: (options: {
						port: number;
						hostname: string;
						fetch: (request: Request) => Response;
					}) => {
						port: number;
						stop: (closeActiveConnections?: boolean) => void;
					};
				};
			}
		).Bun;

		if (bunApi?.serve) {
			const server = bunApi.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: (request) => {
					const response = handler(new URL(request.url));
					return new Response(response.body, {
						status: response.status,
						headers: {
							"content-type": "text/plain; charset=utf-8",
						},
					});
				},
			});

			return {
				port: server.port,
				async close(): Promise<void> {
					server.stop(true);
				},
			};
		}

		return await new Promise<LoopbackServer>((resolve, reject) => {
			const server = createServer((request, response) => {
				const host = request.headers.host ?? "127.0.0.1";
				const result = handler(new URL(request.url ?? "/", `http://${host}`));
				response.statusCode = result.status;
				response.setHeader("content-type", "text/plain; charset=utf-8");
				response.end(result.body);
			});

			server.once("error", (error) => {
				reject(error);
			});

			server.listen(0, () => {
				const address = server.address() as AddressInfo | null;
				if (!address) {
					reject(new Error("Failed to start local callback server."));
					return;
				}

				resolve({
					port: address.port,
					async close(): Promise<void> {
						await new Promise<void>((resolveClose) => {
							server.close(() => {
								resolveClose();
							});
						});
					},
				});
			});
		});
	};
}

class DefaultTuiAuthService implements TuiAuthService {
	private readonly browserOpener: BrowserOpener;
	private readonly notionConnectorFactory: () => Connector;
	private readonly oauthClientFactory: (
		clientId: string,
		clientSecret: string,
		redirectUri: string,
	) => GoogleOAuthClient;
	private readonly callbackServerFactory: (
		handler: (url: URL) => { status: number; body: string },
	) => Promise<LoopbackServer>;
	private readonly fetchImpl: FetchImpl;
	private readonly googleCalendarAdapter = createGoogleCalendarAdapter();

	constructor(options: CreateTuiAuthServiceOptions = {}) {
		this.browserOpener = options.browserOpener ?? createSystemBrowserOpener();
		this.notionConnectorFactory =
			options.notionConnectorFactory ?? (() => createNotionConnector());
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.oauthClientFactory =
			options.oauthClientFactory ??
			((clientId, clientSecret, redirectUri) =>
				createGoogleOAuthClient(
					this.fetchImpl,
					clientId,
					clientSecret,
					redirectUri,
				));
		this.callbackServerFactory =
			options.callbackServerFactory ?? createLoopbackServerFactory();
	}

	async startGoogleSession(
		clientId: string,
		clientSecret: string,
		scopes: string[],
	): Promise<GoogleAuthSession> {
		return await new Promise<GoogleAuthSession>((resolve, reject) => {
			let finished = false;
			let closed = false;
			let settleCallback: ((value: { code: string }) => void) | null = null;
			let failCallback: ((error: Error) => void) | null = null;
			const callbackPromise = new Promise<{ code: string }>(
				(resolveCallback, rejectCallback) => {
					settleCallback = resolveCallback;
					failCallback = rejectCallback;
				},
			);

			const fail = (error: Error) => {
				if (finished) {
					return;
				}
				finished = true;
				failCallback?.(error);
			};

			const succeed = (code: string) => {
				if (finished) {
					return;
				}
				finished = true;
				settleCallback?.({ code });
			};

			let serverState = "";
			const handleCallback = (url: URL): CallbackResult => {
				if (url.pathname !== CALLBACK_PATH) {
					return {
						status: 404,
						body: "Not found.",
					};
				}

				const error = url.searchParams.get("error");
				if (error) {
					return {
						status: 400,
						body: "Login failed. Return to syncdown.",
						error: new Error(`Google login failed: ${error}`),
					};
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				if (!code) {
					return {
						status: 400,
						body: "Missing authorization code.",
						error: new Error(
							"Google login did not return an authorization code.",
						),
					};
				}

				if (!state || state !== serverState) {
					return {
						status: 400,
						body: "Authentication state mismatch.",
						error: new Error(
							"Google login state mismatch. Retry the connection flow.",
						),
					};
				}

				return {
					status: 200,
					body: CALLBACK_RESPONSE,
					code,
				};
			};

			const setupSession = async (
				port: number,
				closeServer: () => Promise<void>,
			) => {
				const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
				serverState = crypto.randomUUID();
				const oauthClient = this.oauthClientFactory(
					clientId,
					clientSecret,
					redirectUri,
				);
				const authorizationUrl = oauthClient.generateAuthUrl({
					access_type: "offline",
					prompt: "consent",
					scope: scopes,
					redirect_uri: redirectUri,
					state: serverState,
				});

				const browserResult = await openBrowserTarget(
					this.browserOpener,
					authorizationUrl,
				);

				resolve({
					authorizationUrl,
					browserOpened: browserResult.opened,
					browserError: browserResult.error,
					complete: async (timeoutMs: number) => {
						try {
							const { code } = await withTimeout(
								callbackPromise,
								timeoutMs,
								"Timed out waiting for Google login. Retry the connection flow.",
							);
							const tokenResponse = await oauthClient.getToken({
								code,
								redirect_uri: redirectUri,
							});
							const refreshToken = tokenResponse.tokens.refresh_token ?? null;
							if (!refreshToken) {
								throw new Error(
									"Google did not return a refresh token. Retry and approve again.",
								);
							}

							return { refreshToken };
						} finally {
							await closeServer();
						}
					},
					cancel: async () => {
						fail(new Error("Login cancelled."));
						await closeServer();
					},
				});
			};

			const requestHandler = (url: URL) => {
				const result = handleCallback(url);
				if (result.error) {
					fail(result.error);
				} else if (result.code) {
					succeed(result.code);
				}
				return {
					status: result.status,
					body: result.body,
				};
			};

			void this.callbackServerFactory(requestHandler)
				.then((server) =>
					setupSession(server.port, async () => {
						if (closed) {
							return;
						}
						closed = true;
						await server.close();
					}),
				)
				.catch(reject);
		});
	}

	async startNotionOAuthSession(
		clientId: string,
		clientSecret: string,
	): Promise<NotionOAuthSession> {
		return await new Promise<NotionOAuthSession>((resolve, reject) => {
			let finished = false;
			let closed = false;
			let settleCallback: ((value: { code: string }) => void) | null = null;
			let failCallback: ((error: Error) => void) | null = null;
			const callbackPromise = new Promise<{ code: string }>(
				(resolveCallback, rejectCallback) => {
					settleCallback = resolveCallback;
					failCallback = rejectCallback;
				},
			);

			const fail = (error: Error) => {
				if (finished) {
					return;
				}
				finished = true;
				failCallback?.(error);
			};

			const succeed = (code: string) => {
				if (finished) {
					return;
				}
				finished = true;
				settleCallback?.({ code });
			};

			let serverState = "";
			const handleCallback = (url: URL): CallbackResult => {
				if (url.pathname !== CALLBACK_PATH) {
					return {
						status: 404,
						body: "Not found.",
					};
				}

				const error = url.searchParams.get("error");
				if (error) {
					return {
						status: 400,
						body: "Login failed. Return to syncdown.",
						error: new Error(`Notion login failed: ${error}`),
					};
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				if (!code) {
					return {
						status: 400,
						body: "Missing authorization code.",
						error: new Error(
							"Notion login did not return an authorization code.",
						),
					};
				}

				if (!state || state !== serverState) {
					return {
						status: 400,
						body: "Authentication state mismatch.",
						error: new Error(
							"Notion login state mismatch. Retry the connection flow.",
						),
					};
				}

				return {
					status: 200,
					body: CALLBACK_RESPONSE,
					code,
				};
			};

			const setupSession = async (
				port: number,
				closeServer: () => Promise<void>,
			) => {
				const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
				serverState = crypto.randomUUID();
				const authorizationUrl = buildNotionAuthUrl({
					clientId,
					redirectUri,
					state: serverState,
				});

				const browserResult = await openBrowserTarget(
					this.browserOpener,
					authorizationUrl,
				);

				resolve({
					authorizationUrl,
					browserOpened: browserResult.opened,
					browserError: browserResult.error,
					complete: async (timeoutMs: number) => {
						try {
							const { code } = await withTimeout(
								callbackPromise,
								timeoutMs,
								"Timed out waiting for Notion login. Retry the connection flow.",
							);
							return await exchangeNotionAuthCode(
								this.fetchImpl,
								clientId,
								clientSecret,
								{
									code,
									redirectUri,
								},
							);
						} finally {
							await closeServer();
						}
					},
					cancel: async () => {
						fail(new Error("Login cancelled."));
						await closeServer();
					},
				});
			};

			const requestHandler = (url: URL) => {
				const result = handleCallback(url);
				if (result.error) {
					fail(result.error);
				} else if (result.code) {
					succeed(result.code);
				}
				return {
					status: result.status,
					body: result.body,
				};
			};

			void this.callbackServerFactory(requestHandler)
				.then((server) =>
					setupSession(server.port, async () => {
						if (closed) {
							return;
						}
						closed = true;
						await server.close();
					}),
				)
				.catch(reject);
		});
	}

	async openUrl(url: string): Promise<BrowserOpenResult> {
		return await openBrowserTarget(this.browserOpener, url);
	}

	async openNotionSetup(): Promise<BrowserOpenResult> {
		return await this.openUrl(NOTION_SETUP_URL);
	}

	async openNotionOAuthSetup(): Promise<BrowserOpenResult> {
		return await this.openUrl(NOTION_SETUP_URL);
	}

	async openGoogleOAuthSetup(): Promise<BrowserOpenResult> {
		return await this.openUrl(GOOGLE_OAUTH_SETUP_URL);
	}

	async validateNotionToken(paths: AppPaths, token: string): Promise<void> {
		const connector = this.notionConnectorFactory();
		const secrets = new ValidationSecretsStore(
			new Map([
				[`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`, token],
			]),
		);
		const request = createValidationRequest(
			paths,
			createValidationConfig("notion"),
			secrets,
			{
				connector: "notion",
				notionConnectionId: DEFAULT_NOTION_TOKEN_CONNECTION_ID,
				resolvedAuth: { kind: "notion-token", token },
			},
		);
		await assertHealthy(await connector.validate(request));
	}

	async validateNotionOAuthAccessToken(
		paths: AppPaths,
		accessToken: string,
	): Promise<void> {
		const connector = this.notionConnectorFactory();
		const secrets = new ValidationSecretsStore(new Map());
		const request = createValidationRequest(
			paths,
			createValidationConfig("notion"),
			secrets,
			{
				connector: "notion",
				notionConnectionId: DEFAULT_NOTION_OAUTH_CONNECTION_ID,
				resolvedAuth: {
					kind: "notion-oauth",
					accessToken,
				} satisfies NotionOAuthResolvedAuth,
			},
		);
		await assertHealthy(await connector.validate(request));
	}

	async validateGoogleCredentials(
		_paths: AppPaths,
		credentials: GoogleAuthCredentials,
		requiredScopes: readonly string[],
	): Promise<void> {
		await assertGoogleGrantedScopes(
			this.fetchImpl,
			credentials,
			requiredScopes,
		);
	}

	async listGoogleCalendars(
		credentials: GoogleAuthCredentials,
	): Promise<GoogleCalendarSummary[]> {
		return this.googleCalendarAdapter.listCalendars(credentials);
	}
}

export function createTuiAuthService(
	options: CreateTuiAuthServiceOptions = {},
): TuiAuthService {
	return new DefaultTuiAuthService(options);
}
