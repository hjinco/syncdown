import type {
	AppIo,
	SecretsStore,
	SelfUpdater,
	SyncdownApp,
	SyncSession,
} from "@syncdown/core";
import {
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	EXIT_CODES,
	ensureAppDirectories,
	ensureConfig,
	getGoogleConnectionSecretNames,
	getGoogleOAuthAppSecretNames,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
	resolveAppPaths,
} from "@syncdown/core";

import { ConfigTuiApp } from "./app.js";
import { createDraftState } from "./state.js";

const DEV_DOCS_BASE_URL = "http://localhost:3000";
const PROD_DOCS_BASE_URL = "https://syncdown.dev";

export interface ConfigTuiRequest {
	app: SyncdownApp;
	io: AppIo;
	secrets: SecretsStore;
	session: SyncSession;
	updater?: SelfUpdater;
	docsBaseUrl?: string | null;
}

export function resolveDocsBaseUrl(request: ConfigTuiRequest): string {
	if (request.docsBaseUrl) {
		return request.docsBaseUrl;
	}

	if (process.env.DOCS_BASE_URL) {
		return process.env.DOCS_BASE_URL;
	}

	return request.updater?.supportsSelfUpdate()
		? PROD_DOCS_BASE_URL
		: DEV_DOCS_BASE_URL;
}

export async function launchConfigTui(
	request: ConfigTuiRequest,
): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		request.io.error("`syncdown` requires an interactive terminal.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const paths = resolveAppPaths();
	await ensureAppDirectories(paths);
	const currentConfig = await ensureConfig(paths);
	const [
		notionTokenStored,
		notionOauthClientIdStored,
		notionOauthClientSecretStored,
		notionOauthRefreshTokenStored,
		googleClientIdStored,
		googleClientSecretStored,
		googleRefreshTokenStored,
	] = await Promise.all([
		request.secrets.hasSecret(
			`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`,
			paths,
		),
		request.secrets.hasSecret(
			getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientId,
			paths,
		),
		request.secrets.hasSecret(
			getNotionOAuthAppSecretNames(DEFAULT_NOTION_OAUTH_APP_ID).clientSecret,
			paths,
		),
		request.secrets.hasSecret(
			getNotionOAuthConnectionSecretNames(DEFAULT_NOTION_OAUTH_CONNECTION_ID)
				.refreshToken,
			paths,
		),
		request.secrets.hasSecret(
			getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientId,
			paths,
		),
		request.secrets.hasSecret(
			getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID).clientSecret,
			paths,
		),
		request.secrets.hasSecret(
			getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID).refreshToken,
			paths,
		),
	]);
	const draft = createDraftState(currentConfig, {
		notionTokenStored,
		notionOauthClientIdStored,
		notionOauthClientSecretStored,
		notionOauthRefreshTokenStored,
		googleClientIdStored,
		googleClientSecretStored,
		googleRefreshTokenStored,
	});
	const app = await ConfigTuiApp.create(
		{
			...request,
			docsBaseUrl: resolveDocsBaseUrl(request),
		},
		paths,
		draft,
	);

	try {
		return await app.run();
	} finally {
		await request.session.dispose();
	}
}
