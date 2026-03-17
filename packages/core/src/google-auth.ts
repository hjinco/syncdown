import {
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
} from "./config-model.js";
import type { AppPaths, SecretsStore, SetupMethodDescriptor } from "./types.js";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_INFO_URL = "https://www.googleapis.com/oauth2/v1/tokeninfo";

export const GOOGLE_SECRET_NAMES = {
	clientId: `oauthApps.${DEFAULT_GOOGLE_OAUTH_APP_ID}.clientId`,
	clientSecret: `oauthApps.${DEFAULT_GOOGLE_OAUTH_APP_ID}.clientSecret`,
	refreshToken: `connections.${DEFAULT_GOOGLE_CONNECTION_ID}.refreshToken`,
} as const;

type FetchImpl = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface GoogleOAuthCredentials {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

export interface GoogleTokenResponse {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string | null;
	scope?: string;
	error?: string;
	error_description?: string;
}

interface GoogleTokenInfoResponse {
	scope?: string;
	error?: string;
	error_description?: string;
}

export interface GoogleAccessTokenProvider {
	getAccessToken(credentials: GoogleOAuthCredentials): Promise<string>;
}

type HasGoogleAuthDescriptor = {
	id: string;
	setupMethods?: readonly SetupMethodDescriptor[];
	enabled?: boolean;
};

export function getGoogleOAuthAppSecretNames(oauthAppId: string): {
	clientId: string;
	clientSecret: string;
} {
	return {
		clientId: `oauthApps.${oauthAppId}.clientId`,
		clientSecret: `oauthApps.${oauthAppId}.clientSecret`,
	};
}

export function getGoogleConnectionSecretNames(connectionId: string): {
	refreshToken: string;
} {
	return {
		refreshToken: `connections.${connectionId}.refreshToken`,
	};
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

export function isGoogleProviderAuth(
	setupMethod: SetupMethodDescriptor | undefined,
): setupMethod is SetupMethodDescriptor & {
	kind: "provider-oauth";
	providerId: "google";
	requiredScopes: readonly string[];
} {
	return (
		setupMethod?.kind === "provider-oauth" &&
		setupMethod.providerId === "google"
	);
}

export async function hasGoogleCredentials(
	secrets: SecretsStore,
	paths: AppPaths,
): Promise<boolean> {
	return hasGoogleConnectionCredentials(secrets, paths, {
		oauthAppId: DEFAULT_GOOGLE_OAUTH_APP_ID,
		connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
	});
}

export async function hasGoogleConnectionCredentials(
	secrets: SecretsStore,
	paths: AppPaths,
	options: {
		oauthAppId: string;
		connectionId: string;
	},
): Promise<boolean> {
	const oauthSecretNames = getGoogleOAuthAppSecretNames(options.oauthAppId);
	const connectionSecretNames = getGoogleConnectionSecretNames(
		options.connectionId,
	);
	const [clientId, clientSecret, refreshToken] = await Promise.all([
		secrets.hasSecret(oauthSecretNames.clientId, paths),
		secrets.hasSecret(oauthSecretNames.clientSecret, paths),
		secrets.hasSecret(connectionSecretNames.refreshToken, paths),
	]);

	return clientId && clientSecret && refreshToken;
}

export async function readGoogleCredentials(
	secrets: SecretsStore,
	paths: AppPaths,
): Promise<GoogleOAuthCredentials> {
	return readGoogleConnectionCredentials(secrets, paths, {
		oauthAppId: DEFAULT_GOOGLE_OAUTH_APP_ID,
		connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
	});
}

export async function readGoogleConnectionCredentials(
	secrets: SecretsStore,
	paths: AppPaths,
	options: {
		oauthAppId: string;
		connectionId: string;
	},
): Promise<GoogleOAuthCredentials> {
	const oauthSecretNames = getGoogleOAuthAppSecretNames(options.oauthAppId);
	const connectionSecretNames = getGoogleConnectionSecretNames(
		options.connectionId,
	);
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

export function normalizeGoogleScopes(scopes: readonly string[]): string[] {
	return [
		...new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
	].sort();
}

export function getRequiredGoogleScopes(target: {
	setupMethods?: readonly SetupMethodDescriptor[];
}): string[] {
	const setupMethod = target.setupMethods?.find((candidate) =>
		isGoogleProviderAuth(candidate),
	);
	return setupMethod ? normalizeGoogleScopes(setupMethod.requiredScopes) : [];
}

export function collectGoogleProviderScopes(
	targets: readonly HasGoogleAuthDescriptor[],
	options: {
		includeIds?: readonly string[];
	} = {},
): string[] {
	const includedIds = new Set(options.includeIds ?? []);
	const scopes = targets.flatMap((target) =>
		target.enabled || includedIds.has(target.id)
			? getRequiredGoogleScopes(target)
			: [],
	);
	return normalizeGoogleScopes(scopes);
}

export function buildGoogleAuthUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
	scopes: readonly string[];
}): string {
	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set("client_id", options.clientId);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", options.state);
	url.searchParams.set(
		"scope",
		normalizeGoogleScopes(options.scopes).join(" "),
	);
	return url.toString();
}

export async function exchangeGoogleAuthCode(
	fetchImpl: FetchImpl,
	clientId: string,
	clientSecret: string,
	options: { code: string; redirectUri: string },
): Promise<GoogleTokenResponse> {
	const response = await fetchImpl(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code: options.code,
			grant_type: "authorization_code",
			redirect_uri: options.redirectUri,
		}),
	});

	const payload = await parseJsonResponse<GoogleTokenResponse>(response);
	if (!response.ok) {
		const reason =
			payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
		throw new Error(`Google token exchange failed: ${reason}`);
	}

	return payload ?? {};
}

export async function refreshGoogleAccessToken(
	fetchImpl: FetchImpl,
	credentials: GoogleOAuthCredentials,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
	const response = await fetchImpl(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			refresh_token: credentials.refreshToken,
			grant_type: "refresh_token",
		}),
	});

	const payload = await parseJsonResponse<GoogleTokenResponse>(response);
	if (!response.ok || !payload?.access_token) {
		const reason =
			payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
		throw new Error(`Failed to refresh Google access token: ${reason}`);
	}

	return {
		accessToken: payload.access_token,
		expiresInSeconds: Math.max(60, payload.expires_in ?? 3600),
	};
}

export function createGoogleAccessTokenProvider(
	fetchImpl: FetchImpl = fetch,
): GoogleAccessTokenProvider {
	let accessTokenCache: {
		key: string;
		accessToken: string;
		expiresAt: number;
	} | null = null;

	return {
		async getAccessToken(credentials: GoogleOAuthCredentials): Promise<string> {
			const cacheKey = JSON.stringify(credentials);
			const now = Date.now();
			if (
				accessTokenCache &&
				accessTokenCache.key === cacheKey &&
				accessTokenCache.expiresAt > now + 30_000
			) {
				return accessTokenCache.accessToken;
			}

			const token = await refreshGoogleAccessToken(fetchImpl, credentials);
			accessTokenCache = {
				key: cacheKey,
				accessToken: token.accessToken,
				expiresAt: now + token.expiresInSeconds * 1000,
			};
			return token.accessToken;
		},
	};
}

export async function fetchGoogleGrantedScopes(
	fetchImpl: FetchImpl,
	accessToken: string,
): Promise<string[]> {
	const url = new URL(GOOGLE_TOKEN_INFO_URL);
	url.searchParams.set("access_token", accessToken);

	const response = await fetchImpl(url);
	const payload = await parseJsonResponse<GoogleTokenInfoResponse>(response);
	if (!response.ok) {
		const reason =
			payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
		throw new Error(`Failed to inspect Google access token scopes: ${reason}`);
	}

	return normalizeGoogleScopes((payload?.scope ?? "").split(" "));
}

export async function assertGoogleGrantedScopes(
	fetchImpl: FetchImpl,
	credentials: GoogleOAuthCredentials,
	requiredScopes: readonly string[],
): Promise<void> {
	const normalizedRequired = normalizeGoogleScopes(requiredScopes);
	if (normalizedRequired.length === 0) {
		return;
	}

	const { accessToken } = await refreshGoogleAccessToken(
		fetchImpl,
		credentials,
	);
	const grantedScopes = await fetchGoogleGrantedScopes(fetchImpl, accessToken);
	const missingScopes = normalizedRequired.filter(
		(scope) => !grantedScopes.includes(scope),
	);
	if (missingScopes.length > 0) {
		throw new Error(
			`Google account is missing required scopes: ${missingScopes.join(", ")}`,
		);
	}
}

export function getGoogleAuthConnectors(
	connectors: readonly HasGoogleAuthDescriptor[],
): Array<{
	id: string;
	setupMethods?: readonly SetupMethodDescriptor[];
}> {
	return connectors.filter((connector) =>
		connector.setupMethods?.some((setupMethod) =>
			isGoogleProviderAuth(setupMethod),
		),
	);
}
