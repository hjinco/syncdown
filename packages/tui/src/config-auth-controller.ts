import type { AppPaths } from "@syncdown/core";
import {
	collectGoogleProviderScopes,
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	getGoogleConnectionSecretNames,
	getGoogleOAuthAppSecretNames,
} from "@syncdown/core";
import type {
	BrowserOpenResult,
	GoogleAuthCredentials,
	GoogleAuthSession,
	NotionOAuthSession,
	TuiAuthService,
} from "./auth.js";
import type { ConfigTuiRequest } from "./index.js";
import type { DraftState } from "./state.js";
import {
	getDraftIntegration,
	isDraftConnectorEnabled,
	stageGoogleConnection,
	stageNotionConnection,
	stageNotionOAuthConnection,
} from "./state.js";
import type {
	ConfigUiState,
	ConnectorAuthRoute,
	GoogleCalendarSelectionRoute,
} from "./view-state.js";
import {
	createConnectorAuthRoute,
	getConnectorAuthDocsUrl,
	getCurrentAuthField,
	getCurrentRoute,
	popRoute,
	pushRoute,
	setNotice,
} from "./view-state.js";

const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1_000;

type ActiveBrowserAuthSession = GoogleAuthSession | NotionOAuthSession;

interface ConfigAuthControllerDeps {
	ui: ConfigUiState;
	draft: DraftState;
	paths: AppPaths;
	authService: TuiAuthService;
	refreshView(): void;
	persistDraftMutation(
		mutate: (draft: DraftState) => void,
		failureFallback: string,
	): Promise<boolean>;
	inspectApp(): ReturnType<ConfigTuiRequest["app"]["inspect"]>;
	getSecret(name: string): Promise<string | null>;
	getActiveAuthRun(): number;
	incrementActiveAuthRun(): number;
	getActiveBrowserAuthSession(): ActiveBrowserAuthSession | null;
	setActiveBrowserAuthSession(session: ActiveBrowserAuthSession | null): void;
}

export function createConfigAuthController(deps: ConfigAuthControllerDeps) {
	return {
		async activateAuthSelection(
			route: ConnectorAuthRoute,
			selection: unknown,
		): Promise<void> {
			if (route.stage === "intro") {
				if (selection === "cancel") {
					popRoute(deps.ui);
					deps.refreshView();
					return;
				}

				if (selection === "openDocs") {
					const docsUrl = getConnectorAuthDocsUrl(route, deps.ui.docsBaseUrl);
					if (!docsUrl) {
						setNotice(deps.ui, {
							kind: "error",
							text: "Docs link is unavailable for this auth flow.",
						});
						deps.refreshView();
						return;
					}

					const browserResult = await deps.authService.openUrl(docsUrl);
					setNotice(
						deps.ui,
						browserResult.opened
							? {
									kind: "success",
									text: "Connector docs opened in your browser.",
								}
							: {
									kind: "error",
									text:
										browserResult.error ??
										"Failed to open the connector docs in your browser.",
								},
					);
					deps.refreshView();
					return;
				}

				if (route.authMethod === "notion-token") {
					await startNotionSetup(route);
				} else if (route.authMethod === "notion-oauth") {
					await openOAuthSetupPage(route, () =>
						deps.authService.openNotionOAuthSetup(),
					);
				} else {
					await openOAuthSetupPage(route, () =>
						deps.authService.openGoogleOAuthSetup(),
					);
				}
				return;
			}

			if (route.stage === "success") {
				const message =
					deps.ui.notice?.kind === "success"
						? deps.ui.notice.text
						: `${route.connector} connected.`;
				popRoute(deps.ui);
				setNotice(deps.ui, {
					kind: "success",
					text: message,
				});
				deps.refreshView();
				return;
			}

			if (selection === "cancel") {
				await runCancelAuthFlow();
				return;
			}

			if (route.stage === "error" && selection === "retry") {
				await runRetryAuthFlow(route);
			}
		},

		async submitConnectorAuthInput(route: ConnectorAuthRoute): Promise<void> {
			const field = getCurrentAuthField(route);
			const value = route.inputValue.trim();
			if (!value) {
				route.error = `${field.label} is required.`;
				setNotice(deps.ui, {
					kind: "error",
					text: route.error,
				});
				deps.refreshView();
				return;
			}

			route.values[field.key] = value;
			route.error = null;
			setNotice(deps.ui, null);

			if (
				(route.authMethod === "google-oauth" ||
					route.authMethod === "notion-oauth") &&
				route.fieldIndex === 0
			) {
				route.fieldIndex = 1;
				route.inputValue =
					route.authMethod === "notion-oauth"
						? (route.values.notionOauthClientSecret ?? "")
						: (route.values.googleClientSecret ?? "");
				deps.refreshView();
				return;
			}

			if (route.authMethod === "notion-token") {
				await validateNotionToken(route, value);
				return;
			}

			if (route.authMethod === "notion-oauth") {
				const clientId = route.values.notionOauthClientId ?? "";
				const clientSecret = value;
				await runNotionOAuthConnectFlow(route, clientId, clientSecret);
				return;
			}

			const clientId = route.values.googleClientId ?? "";
			const clientSecret = value;
			await runGoogleConnectFlow(route, clientId, clientSecret);
		},

		async ensureGoogleScopesForConnector(
			connector: "gmail" | "google-calendar",
		): Promise<boolean> {
			const credentials = await getCurrentGoogleCredentials();
			const requiredScopes = await getRequiredGoogleScopes(connector);
			if (credentials) {
				try {
					await deps.authService.validateGoogleCredentials(
						deps.paths,
						credentials,
						requiredScopes,
					);
					return true;
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: "Google account is missing required scopes.";
					setNotice(deps.ui, {
						kind: "error",
						text: message,
					});
				}
			} else {
				setNotice(deps.ui, {
					kind: "error",
					text: "Google account setup is incomplete. Reconnect to continue.",
				});
			}

			const authRoute = createConnectorAuthRoute(connector, "google-oauth");
			pushRoute(deps.ui, authRoute);
			const oauthAppCredentials = await getCurrentGoogleOAuthAppCredentials();
			if (oauthAppCredentials) {
				authRoute.values.googleClientId = oauthAppCredentials.clientId;
				authRoute.values.googleClientSecret = oauthAppCredentials.clientSecret;
				await runGoogleConnectFlow(
					authRoute,
					oauthAppCredentials.clientId,
					oauthAppCredentials.clientSecret,
				);
				if (
					getCurrentRoute(deps.ui) !== authRoute ||
					authRoute.stage !== "success"
				) {
					return false;
				}

				popRoute(deps.ui);
				deps.refreshView();
				return true;
			}

			await openOAuthSetupPage(authRoute, () =>
				deps.authService.openGoogleOAuthSetup(),
			);
			return false;
		},

		async refreshGoogleCalendarSelection(
			route: GoogleCalendarSelectionRoute,
		): Promise<void> {
			route.loading = true;
			route.error = null;
			deps.refreshView();

			try {
				const credentials = await getCurrentGoogleCredentials();
				if (!credentials) {
					throw new Error(
						"Connect a Google account before selecting calendars.",
					);
				}

				if (!deps.authService.listGoogleCalendars) {
					throw new Error("Google calendar listing is unavailable.");
				}
				const calendars =
					await deps.authService.listGoogleCalendars(credentials);
				route.calendars = calendars;
				route.selectedCalendarIds = route.selectedCalendarIds.filter((id) =>
					calendars.some((calendar) => calendar.id === id),
				);
				route.loading = false;
				route.error = null;
				deps.refreshView();
			} catch (error) {
				route.loading = false;
				route.error =
					error instanceof Error
						? error.message
						: "Failed to load Google calendars.";
				deps.refreshView();
			}
		},

		async retryAuthFlow(route: ConnectorAuthRoute): Promise<void> {
			await runRetryAuthFlow(route);
		},

		async cancelAuthFlow(): Promise<void> {
			await runCancelAuthFlow();
		},
	};

	async function runRetryAuthFlow(route: ConnectorAuthRoute): Promise<void> {
		route.error = null;
		route.authUrl = undefined;
		route.browserOpened = undefined;
		route.browserError = null;
		route.selectedIndex = 0;
		setNotice(deps.ui, null);

		if (route.authMethod === "notion-token") {
			route.stage = "intro";
			deps.refreshView();
			return;
		}

		route.stage = "collect-input";
		route.fieldIndex = 0;
		route.inputValue =
			route.authMethod === "notion-oauth"
				? (route.values.notionOauthClientId ?? "")
				: (route.values.googleClientId ?? "");
		deps.refreshView();
	}

	async function runCancelAuthFlow(): Promise<void> {
		deps.incrementActiveAuthRun();
		const session = deps.getActiveBrowserAuthSession();
		deps.setActiveBrowserAuthSession(null);
		if (session) {
			await session.cancel().catch(() => {});
		}

		popRoute(deps.ui);
		deps.refreshView();
	}

	async function startNotionSetup(route: ConnectorAuthRoute): Promise<void> {
		const runId = deps.incrementActiveAuthRun();
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		deps.refreshView();

		const browserResult = await deps.authService.openNotionSetup();
		if (!isAuthRouteActive(route, runId)) {
			return;
		}

		route.browserOpened = browserResult.opened;
		route.browserError = browserResult.error ?? null;
		route.stage = "collect-input";
		route.fieldIndex = 0;
		route.inputValue = route.values.notionToken ?? "";
		route.error = null;
		deps.refreshView();
	}

	async function openOAuthSetupPage(
		route: ConnectorAuthRoute,
		openSetupPage: () => Promise<BrowserOpenResult>,
	): Promise<void> {
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		deps.refreshView();

		const browserResult = await openSetupPage();
		if (getCurrentRoute(deps.ui) !== route) {
			return;
		}

		route.browserOpened = browserResult.opened;
		route.browserError = browserResult.error ?? null;
		route.stage = "collect-input";
		route.fieldIndex = 0;
		route.inputValue =
			route.authMethod === "notion-oauth"
				? (route.values.notionOauthClientId ?? "")
				: (route.values.googleClientId ?? "");
		route.error = null;
		route.selectedIndex = 0;
		deps.refreshView();
	}

	async function validateNotionToken(
		route: ConnectorAuthRoute,
		token: string,
	): Promise<void> {
		const runId = deps.incrementActiveAuthRun();
		route.stage = "validating";
		route.error = null;
		route.selectedIndex = 0;
		deps.refreshView();

		try {
			await deps.authService.validateNotionToken(deps.paths, token);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}

			const saved = await deps.persistDraftMutation(
				(draft) => stageNotionConnection(draft, token),
				"Failed to save Notion credentials.",
			);
			if (!saved || !isAuthRouteActive(route, runId)) {
				route.stage = "collect-input";
				route.error =
					deps.ui.notice?.kind === "error"
						? deps.ui.notice.text
						: "Failed to save Notion credentials.";
				deps.refreshView();
				return;
			}

			route.stage = "success";
			route.error = null;
			route.selectedIndex = 0;
			setNotice(deps.ui, {
				kind: "success",
				text: "Notion connected.",
			});
			deps.refreshView();
		} catch (error) {
			if (!isAuthRouteActive(route, runId)) {
				return;
			}
			route.stage = "collect-input";
			route.error =
				error instanceof Error
					? error.message
					: "Unknown Notion validation failure.";
			setNotice(deps.ui, {
				kind: "error",
				text: route.error,
			});
			deps.refreshView();
		}
	}

	async function getRequiredGoogleScopes(
		connectorId: "gmail" | "google-calendar",
	): Promise<string[]> {
		const snapshot = await deps.inspectApp();
		const integrations = snapshot.integrations.map((integration) => ({
			...integration,
			enabled:
				integration.connectorId === "notion"
					? isDraftConnectorEnabled(deps.draft, "notion")
					: integration.connectorId === "gmail"
						? isDraftConnectorEnabled(deps.draft, "gmail")
						: integration.connectorId === "google-calendar"
							? isDraftConnectorEnabled(deps.draft, "google-calendar")
							: integration.enabled,
		}));
		return collectGoogleProviderScopes(integrations, {
			includeIds: [
				snapshot.integrations.find(
					(integration) => integration.connectorId === connectorId,
				)?.id ?? getDraftIntegration(deps.draft, connectorId).id,
			],
		});
	}

	async function getCurrentGoogleOAuthAppCredentials(): Promise<{
		clientId: string;
		clientSecret: string;
	} | null> {
		const clientId =
			deps.draft.googleClientId.action === "set"
				? deps.draft.googleClientId.value
				: deps.draft.googleClientId.action === "delete"
					? null
					: await deps.getSecret(
							getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID)
								.clientId,
						);
		const clientSecret =
			deps.draft.googleClientSecret.action === "set"
				? deps.draft.googleClientSecret.value
				: deps.draft.googleClientSecret.action === "delete"
					? null
					: await deps.getSecret(
							getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID)
								.clientSecret,
						);
		if (!clientId || !clientSecret) {
			return null;
		}

		return {
			clientId,
			clientSecret,
		};
	}

	async function getCurrentGoogleCredentials(): Promise<GoogleAuthCredentials | null> {
		const oauthAppCredentials = await getCurrentGoogleOAuthAppCredentials();
		const refreshToken =
			deps.draft.googleRefreshToken.action === "set"
				? deps.draft.googleRefreshToken.value
				: deps.draft.googleRefreshToken.action === "delete"
					? null
					: await deps.getSecret(
							getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID)
								.refreshToken,
						);

		if (!oauthAppCredentials || !refreshToken) {
			return null;
		}

		return {
			clientId: oauthAppCredentials.clientId,
			clientSecret: oauthAppCredentials.clientSecret,
			refreshToken,
		};
	}

	async function runGoogleConnectFlow(
		route: ConnectorAuthRoute,
		clientId: string,
		clientSecret: string,
	): Promise<void> {
		const runId = deps.incrementActiveAuthRun();
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		route.inputValue = "";
		deps.refreshView();

		try {
			const requiredScopes = await getRequiredGoogleScopes(
				route.connector === "google-calendar" ? "google-calendar" : "gmail",
			);
			const session = await deps.authService.startGoogleSession(
				clientId,
				clientSecret,
				requiredScopes,
			);
			if (!isAuthRouteActive(route, runId)) {
				await session.cancel();
				return;
			}

			deps.setActiveBrowserAuthSession(session);
			route.stage = "waiting-callback";
			route.authUrl = session.authorizationUrl;
			route.browserOpened = session.browserOpened;
			route.browserError = session.browserError ?? null;
			route.selectedIndex = 0;
			deps.refreshView();

			const tokenResult = await session.complete(GOOGLE_AUTH_TIMEOUT_MS);
			deps.setActiveBrowserAuthSession(null);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}

			route.stage = "validating";
			deps.refreshView();

			const credentials: GoogleAuthCredentials = {
				clientId,
				clientSecret,
				refreshToken: tokenResult.refreshToken,
			};
			await deps.authService.validateGoogleCredentials(
				deps.paths,
				credentials,
				requiredScopes,
			);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}

			const saved = await deps.persistDraftMutation(
				(draft) =>
					stageGoogleConnection(
						draft,
						clientId,
						clientSecret,
						tokenResult.refreshToken,
						route.connector === "google-calendar" ? "google-calendar" : "gmail",
					),
				"Failed to save Google account credentials.",
			);
			if (!saved || !isAuthRouteActive(route, runId)) {
				route.stage = "error";
				route.error =
					deps.ui.notice?.kind === "error"
						? deps.ui.notice.text
						: "Failed to save Google account credentials.";
				deps.refreshView();
				return;
			}

			route.stage = "success";
			route.error = null;
			route.selectedIndex = 0;
			setNotice(deps.ui, {
				kind: "success",
				text: "Google account connected.",
			});
			deps.refreshView();
		} catch (error) {
			deps.setActiveBrowserAuthSession(null);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}
			route.stage = "error";
			route.error =
				error instanceof Error
					? error.message
					: "Unknown Google connection failure.";
			route.selectedIndex = 0;
			setNotice(deps.ui, {
				kind: "error",
				text: route.error,
			});
			deps.refreshView();
		}
	}

	async function runNotionOAuthConnectFlow(
		route: ConnectorAuthRoute,
		clientId: string,
		clientSecret: string,
	): Promise<void> {
		const runId = deps.incrementActiveAuthRun();
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		route.inputValue = "";
		deps.refreshView();

		try {
			const session = await deps.authService.startNotionOAuthSession(
				clientId,
				clientSecret,
			);
			if (!isAuthRouteActive(route, runId)) {
				await session.cancel();
				return;
			}

			deps.setActiveBrowserAuthSession(session);
			route.stage = "waiting-callback";
			route.authUrl = session.authorizationUrl;
			route.browserOpened = session.browserOpened;
			route.browserError = session.browserError ?? null;
			route.selectedIndex = 0;
			deps.refreshView();

			const tokenResult = await session.complete(GOOGLE_AUTH_TIMEOUT_MS);
			deps.setActiveBrowserAuthSession(null);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}

			route.stage = "validating";
			deps.refreshView();

			await deps.authService.validateNotionOAuthAccessToken(
				deps.paths,
				tokenResult.accessToken,
			);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}

			const saved = await deps.persistDraftMutation(
				(draft) =>
					stageNotionOAuthConnection(
						draft,
						clientId,
						clientSecret,
						tokenResult.refreshToken,
						{
							workspaceId: tokenResult.workspaceId,
							workspaceName: tokenResult.workspaceName,
							botId: tokenResult.botId,
							ownerUserId: tokenResult.ownerUserId,
							ownerUserName: tokenResult.ownerUserName,
						},
					),
				"Failed to save Notion OAuth credentials.",
			);
			if (!saved || !isAuthRouteActive(route, runId)) {
				route.stage = "error";
				route.error =
					deps.ui.notice?.kind === "error"
						? deps.ui.notice.text
						: "Failed to save Notion OAuth credentials.";
				deps.refreshView();
				return;
			}

			route.stage = "success";
			route.error = null;
			route.selectedIndex = 0;
			setNotice(deps.ui, {
				kind: "success",
				text: "Notion OAuth account connected.",
			});
			deps.refreshView();
		} catch (error) {
			deps.setActiveBrowserAuthSession(null);
			if (!isAuthRouteActive(route, runId)) {
				return;
			}
			route.stage = "error";
			route.error =
				error instanceof Error
					? error.message
					: "Unknown Notion OAuth connection failure.";
			route.selectedIndex = 0;
			setNotice(deps.ui, {
				kind: "error",
				text: route.error,
			});
			deps.refreshView();
		}
	}

	function isAuthRouteActive(
		route: ConnectorAuthRoute,
		runId: number,
	): boolean {
		return (
			runId === deps.getActiveAuthRun() && getCurrentRoute(deps.ui) === route
		);
	}
}
