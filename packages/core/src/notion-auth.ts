import {
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
} from "./config-model.js";
import type { AppPaths, SecretsStore } from "./types.js";

export const NOTION_SETUP_URL = "https://www.notion.so/profile/integrations";
export const NOTION_AUTH_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_API_VERSION = "2022-06-28";

type FetchImpl = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface NotionOAuthCredentials {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

interface NotionOAuthOwnerUser {
	id?: string;
	name?: string | null;
	person?: {
		email?: string | null;
	};
}

interface NotionOAuthOwnerPayload {
	type?: "user" | string;
	user?: NotionOAuthOwnerUser | null;
}

interface NotionOAuthTokenResponse {
	access_token?: string;
	token_type?: string;
	bot_id?: string;
	workspace_id?: string;
	workspace_name?: string | null;
	owner?: NotionOAuthOwnerPayload | null;
	duplicated_template_id?: string | null;
	refresh_token?: string | null;
	error?: string;
	error_description?: string;
	message?: string;
}

export interface NotionOAuthTokenExchangeResult {
	accessToken: string;
	refreshToken: string;
	workspaceId?: string;
	workspaceName?: string;
	botId?: string;
	ownerUserId?: string;
	ownerUserName?: string;
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
	return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

function requireSecret(value: string | null, name: string): string {
	if (!value) {
		throw new Error(`Missing ${name} in encrypted store`);
	}

	return value;
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
	const text = await response.text();
	if (!text) {
		return null;
	}

	return JSON.parse(text) as T;
}

function mapTokenResponse(
	payload: NotionOAuthTokenResponse | null,
	refreshTokenFallback?: string,
): NotionOAuthTokenExchangeResult {
	if (!payload?.access_token) {
		throw new Error("Notion OAuth response did not include an access token");
	}

	const refreshToken = payload.refresh_token ?? refreshTokenFallback;
	if (!refreshToken) {
		throw new Error("Notion OAuth response did not include a refresh token");
	}

	return {
		accessToken: payload.access_token,
		refreshToken,
		workspaceId: payload.workspace_id ?? undefined,
		workspaceName: payload.workspace_name ?? undefined,
		botId: payload.bot_id ?? undefined,
		ownerUserId:
			payload.owner?.type === "user" ? payload.owner.user?.id : undefined,
		ownerUserName:
			payload.owner?.type === "user"
				? (payload.owner.user?.name ??
					payload.owner.user?.person?.email ??
					undefined)
				: undefined,
	};
}

export function getNotionOAuthAppSecretNames(oauthAppId: string): {
	clientId: string;
	clientSecret: string;
} {
	return {
		clientId: `oauthApps.${oauthAppId}.clientId`,
		clientSecret: `oauthApps.${oauthAppId}.clientSecret`,
	};
}

export function getNotionOAuthConnectionSecretNames(connectionId: string): {
	refreshToken: string;
} {
	return {
		refreshToken: `connections.${connectionId}.refreshToken`,
	};
}

export async function hasNotionOAuthConnectionCredentials(
	secrets: SecretsStore,
	paths: AppPaths,
	options: {
		oauthAppId?: string;
		connectionId?: string;
	} = {},
): Promise<boolean> {
	const oauthAppId = options.oauthAppId ?? DEFAULT_NOTION_OAUTH_APP_ID;
	const connectionId =
		options.connectionId ?? DEFAULT_NOTION_OAUTH_CONNECTION_ID;
	const oauthSecretNames = getNotionOAuthAppSecretNames(oauthAppId);
	const connectionSecretNames =
		getNotionOAuthConnectionSecretNames(connectionId);
	const [clientId, clientSecret, refreshToken] = await Promise.all([
		secrets.hasSecret(oauthSecretNames.clientId, paths),
		secrets.hasSecret(oauthSecretNames.clientSecret, paths),
		secrets.hasSecret(connectionSecretNames.refreshToken, paths),
	]);

	return clientId && clientSecret && refreshToken;
}

export async function readNotionOAuthConnectionCredentials(
	secrets: SecretsStore,
	paths: AppPaths,
	options: {
		oauthAppId?: string;
		connectionId?: string;
	} = {},
): Promise<NotionOAuthCredentials> {
	const oauthAppId = options.oauthAppId ?? DEFAULT_NOTION_OAUTH_APP_ID;
	const connectionId =
		options.connectionId ?? DEFAULT_NOTION_OAUTH_CONNECTION_ID;
	const oauthSecretNames = getNotionOAuthAppSecretNames(oauthAppId);
	const connectionSecretNames =
		getNotionOAuthConnectionSecretNames(connectionId);
	const [clientId, clientSecret, refreshToken] = await Promise.all([
		secrets.getSecret(oauthSecretNames.clientId, paths),
		secrets.getSecret(oauthSecretNames.clientSecret, paths),
		secrets.getSecret(connectionSecretNames.refreshToken, paths),
	]);

	return {
		clientId: requireSecret(clientId, oauthSecretNames.clientId),
		clientSecret: requireSecret(clientSecret, oauthSecretNames.clientSecret),
		refreshToken: requireSecret(
			refreshToken,
			connectionSecretNames.refreshToken,
		),
	};
}

export function buildNotionAuthUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
}): string {
	const url = new URL(NOTION_AUTH_URL);
	url.searchParams.set("client_id", options.clientId);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("owner", "user");
	url.searchParams.set("state", options.state);
	return url.toString();
}

export async function exchangeNotionAuthCode(
	fetchImpl: FetchImpl,
	clientId: string,
	clientSecret: string,
	options: { code: string; redirectUri: string },
): Promise<NotionOAuthTokenExchangeResult> {
	const response = await fetchImpl(NOTION_TOKEN_URL, {
		method: "POST",
		headers: {
			authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
			"content-type": "application/json",
			"notion-version": NOTION_API_VERSION,
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			code: options.code,
			redirect_uri: options.redirectUri,
		}),
	});

	const payload = await parseJsonResponse<NotionOAuthTokenResponse>(response);
	if (!response.ok) {
		const reason =
			payload?.error_description ??
			payload?.message ??
			payload?.error ??
			`HTTP ${response.status}`;
		throw new Error(`Notion token exchange failed: ${reason}`);
	}

	return mapTokenResponse(payload);
}

export async function refreshNotionAccessToken(
	fetchImpl: FetchImpl,
	credentials: NotionOAuthCredentials,
): Promise<NotionOAuthTokenExchangeResult> {
	const response = await fetchImpl(NOTION_TOKEN_URL, {
		method: "POST",
		headers: {
			authorization: `Basic ${encodeBasicAuth(credentials.clientId, credentials.clientSecret)}`,
			"content-type": "application/json",
			"notion-version": NOTION_API_VERSION,
		},
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: credentials.refreshToken,
		}),
	});

	const payload = await parseJsonResponse<NotionOAuthTokenResponse>(response);
	if (!response.ok) {
		const reason =
			payload?.error_description ??
			payload?.message ??
			payload?.error ??
			`HTTP ${response.status}`;
		throw new Error(`Failed to refresh Notion access token: ${reason}`);
	}

	return mapTokenResponse(payload, credentials.refreshToken);
}
