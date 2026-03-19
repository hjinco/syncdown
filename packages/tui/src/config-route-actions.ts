import type {
	GmailSyncFilter,
	SyncIntervalPreset,
	SyncRuntimeSnapshot,
} from "@syncdown/core";
import type {
	ConnectorTarget,
	DraftState,
	OutputPresetAction,
} from "./state.js";
import {
	buildOutputPresetPaths,
	getDraftSelectedGoogleCalendarIds,
	hasAnyStoredCredentials,
	isDraftConnectorEnabled,
	setConnectorEnabled,
	setGmailSyncFilter,
	setSelectedGoogleCalendarIds,
	setSyncInterval,
	stageConnectorDisconnect,
	stageProviderDisconnect,
	stageStoredCredentialDisconnect,
} from "./state.js";
import type {
	ConfigUiState,
	ConfirmDisconnectRoute,
	ConnectorDetailsRoute,
	ConnectorsRoute,
	GmailFilterRoute,
	GoogleCalendarSelectionRoute,
	HomeRoute,
	IntervalRoute,
	OutputRoute,
	ScheduleRoute,
} from "./view-state.js";
import {
	createConfirmDisconnectRoute,
	createConnectorAuthRoute,
	createConnectorDetailsRoute,
	createGmailFilterRoute,
	createGoogleCalendarSelectionRoute,
	createIntervalRoute,
	createOutputCustomRoute,
	createSyncDashboardRoute,
	createUpdateRoute,
	popRoute,
	pushRoute,
	setNotice,
} from "./view-state.js";

type ManagedConnectorTarget = Exclude<ConnectorTarget, "notion">;

interface ConfigRouteActionsDeps {
	ui: ConfigUiState;
	draft: DraftState;
	getSyncSnapshot(): SyncRuntimeSnapshot;
	refreshView(): void;
	ensureGoogleScopesForConnector(
		connector: "gmail" | "google-calendar",
	): Promise<boolean>;
	persistDraftMutation(
		mutate: (draft: DraftState) => void,
		failureFallback: string,
	): Promise<boolean>;
	persistOutputDirectory(outputDir: string): Promise<boolean>;
	refreshGoogleCalendarSelection(
		route: GoogleCalendarSelectionRoute,
	): Promise<void>;
}

export function createConfigRouteActions(deps: ConfigRouteActionsDeps) {
	async function openGoogleCalendarSelectionRoute(
		selectedCalendarIds: string[],
	): Promise<void> {
		const calendarRoute =
			createGoogleCalendarSelectionRoute(selectedCalendarIds);
		pushRoute(deps.ui, calendarRoute);
		deps.refreshView();
		await deps.refreshGoogleCalendarSelection(calendarRoute);
	}

	async function enableConnector(
		connector: ManagedConnectorTarget,
		failureMessage: string,
		successMessage: string,
	): Promise<void> {
		const saved = await deps.persistDraftMutation(
			(draft) => setConnectorEnabled(draft, connector, true),
			failureMessage,
		);
		if (saved) {
			setNotice(deps.ui, {
				kind: "success",
				text: successMessage,
			});
		}
	}

	async function handleEnableConnectorSelection(
		connector: ConnectorTarget,
	): Promise<void> {
		if (connector === "gmail") {
			const hasScopes = await deps.ensureGoogleScopesForConnector("gmail");
			if (!hasScopes) {
				return;
			}

			await enableConnector(
				connector,
				`Failed to enable ${getConnectorLabel(connector)}.`,
				`${getConnectorLabel(connector)} enabled.`,
			);
			return;
		}

		if (connector === "google-calendar") {
			const hasScopes =
				await deps.ensureGoogleScopesForConnector("google-calendar");
			if (!hasScopes) {
				return;
			}

			if (getDraftSelectedGoogleCalendarIds(deps.draft).length === 0) {
				await openGoogleCalendarSelectionRoute([]);
				return;
			}

			await enableConnector(
				connector,
				`Failed to enable ${getConnectorLabel(connector)}.`,
				`${getConnectorLabel(connector)} enabled.`,
			);
			return;
		}

		if (connector === "apple-notes") {
			await enableConnector(
				connector,
				`Failed to enable ${getConnectorLabel(connector)}.`,
				`${getConnectorLabel(connector)} enabled.`,
			);
		}
	}

	return {
		handleHomeSelection(route: HomeRoute, selection: unknown): void {
			if (selection === "sync") {
				pushRoute(deps.ui, createSyncDashboardRoute(deps.getSyncSnapshot()));
			} else if (selection === "connectors") {
				pushRoute(deps.ui, { id: "connectors", selectedIndex: 0 });
			} else if (selection === "output") {
				pushRoute(deps.ui, { id: "output", selectedIndex: 0 });
			} else if (selection === "schedule") {
				pushRoute(deps.ui, { id: "schedule", selectedIndex: 0 });
			} else if (selection === "advanced") {
				pushRoute(deps.ui, { id: "advanced", selectedIndex: 0 });
			} else if (selection === "update") {
				pushRoute(deps.ui, createUpdateRoute(route));
			}

			deps.refreshView();
		},

		handleConnectorsSelection(
			_route: ConnectorsRoute,
			selection: unknown,
		): void {
			if (isConnectorTarget(selection)) {
				pushRoute(deps.ui, createConnectorDetailsRoute(selection));
			}

			deps.refreshView();
		},

		async handleConnectorDetailsSelection(
			route: ConnectorDetailsRoute,
			selection: unknown,
		): Promise<void> {
			if (selection === "connectToken" && route.connector === "notion") {
				pushRoute(
					deps.ui,
					createConnectorAuthRoute(route.connector, "notion-token"),
				);
				deps.refreshView();
				return;
			}

			if (selection === "connectOAuth" && route.connector === "notion") {
				pushRoute(
					deps.ui,
					createConnectorAuthRoute(route.connector, "notion-oauth"),
				);
				deps.refreshView();
				return;
			}

			if (selection === "connect") {
				pushRoute(
					deps.ui,
					createConnectorAuthRoute(route.connector, "google-oauth"),
				);
				deps.refreshView();
				return;
			}

			if (selection === "gmailFilter" && route.connector === "gmail") {
				pushRoute(deps.ui, createGmailFilterRoute());
				deps.refreshView();
				return;
			}

			if (
				selection === "googleCalendarSelection" &&
				route.connector === "google-calendar"
			) {
				await openGoogleCalendarSelectionRoute(
					getDraftSelectedGoogleCalendarIds(deps.draft),
				);
				return;
			}

			if (selection === "enable") {
				await handleEnableConnectorSelection(route.connector);
				deps.refreshView();
				return;
			}

			if (selection === "disable") {
				pushRoute(
					deps.ui,
					createConfirmDisconnectRoute(route.connector, "connector"),
				);
				deps.refreshView();
				return;
			}

			if (
				selection === "disconnectProvider" &&
				(route.connector === "gmail" || route.connector === "google-calendar")
			) {
				pushRoute(
					deps.ui,
					createConfirmDisconnectRoute(route.connector, "provider", "google"),
				);
				deps.refreshView();
				return;
			}

			if (selection === "disconnect") {
				if (
					!hasAnyStoredCredentials(deps.draft, route.connector) &&
					!isDraftConnectorEnabled(deps.draft, route.connector)
				) {
					setNotice(deps.ui, {
						kind: "error",
						text: "Connector is already disconnected.",
					});
					deps.refreshView();
					return;
				}

				pushRoute(
					deps.ui,
					createConfirmDisconnectRoute(route.connector, "connector"),
				);
				deps.refreshView();
				return;
			}

			deps.refreshView();
		},

		async handleConfirmDisconnectSelection(
			route: ConfirmDisconnectRoute,
			selection: unknown,
		): Promise<void> {
			if (selection === "cancel") {
				popRoute(deps.ui);
				deps.refreshView();
				return;
			}

			const saved = await deps.persistDraftMutation(
				(draft) => {
					if (route.mode === "provider") {
						stageProviderDisconnect(draft, route.provider ?? "google");
						return;
					}

					if (route.connector === "notion") {
						stageStoredCredentialDisconnect(draft, route.connector);
						return;
					}

					stageConnectorDisconnect(draft, route.connector);
				},
				`Failed to disconnect ${getDisconnectLabel(route)}.`,
			);
			if (!saved) {
				return;
			}

			popRoute(deps.ui);
			setNotice(deps.ui, {
				kind: "success",
				text: getDisconnectSuccessText(route),
			});
			deps.refreshView();
		},

		async handleOutputSelection(
			_route: OutputRoute,
			selection: unknown,
		): Promise<void> {
			if (selection === "custom") {
				pushRoute(deps.ui, createOutputCustomRoute(deps.draft));
				deps.refreshView();
				return;
			}

			const preset = selection as
				| Exclude<OutputPresetAction, "custom">
				| undefined;
			if (!preset) {
				return;
			}

			const presetPaths = buildOutputPresetPaths();
			const saved = await deps.persistOutputDirectory(presetPaths[preset]);
			if (saved) {
				setNotice(deps.ui, {
					kind: "success",
					text: "Output directory saved.",
				});
				deps.refreshView();
			}
		},

		handleScheduleSelection(_route: ScheduleRoute, selection: unknown): void {
			if (isConnectorTarget(selection)) {
				pushRoute(deps.ui, createIntervalRoute(selection));
			}

			deps.refreshView();
		},

		async handleIntervalSelection(
			route: IntervalRoute,
			selection: unknown,
		): Promise<void> {
			const interval = selection as SyncIntervalPreset | undefined;
			if (!interval) {
				return;
			}

			const connectorLabel = getConnectorLabel(route.connector);
			const saved = await deps.persistDraftMutation(
				(draft) => setSyncInterval(draft, route.connector, interval),
				`Failed to save the ${connectorLabel} interval.`,
			);
			if (!saved) {
				return;
			}

			popRoute(deps.ui);
			setNotice(deps.ui, {
				kind: "success",
				text: `${connectorLabel} interval saved.`,
			});
			deps.refreshView();
		},

		async handleGmailFilterSelection(
			_route: GmailFilterRoute,
			selection: unknown,
		): Promise<void> {
			const syncFilter = selection as GmailSyncFilter | undefined;
			if (!syncFilter) {
				return;
			}

			const saved = await deps.persistDraftMutation(
				(draft) => setGmailSyncFilter(draft, syncFilter),
				"Failed to save the Gmail inbox filter.",
			);
			if (!saved) {
				return;
			}

			popRoute(deps.ui);
			setNotice(deps.ui, {
				kind: "success",
				text: "Gmail inbox filter saved. Run Gmail again to apply the new scope.",
			});
			deps.refreshView();
		},

		async handleGoogleCalendarSelection(
			route: GoogleCalendarSelectionRoute,
			selection: unknown,
		): Promise<void> {
			if (selection === "refresh") {
				await deps.refreshGoogleCalendarSelection(route);
				return;
			}

			if (selection === "save") {
				const selectedCalendarIds = [...route.selectedCalendarIds];
				const saved = await deps.persistDraftMutation(
					(draft) => setSelectedGoogleCalendarIds(draft, selectedCalendarIds),
					"Failed to save selected Google calendars.",
				);
				if (!saved) {
					return;
				}

				popRoute(deps.ui);
				setNotice(deps.ui, {
					kind: "success",
					text: "Google Calendar selection saved.",
				});
				deps.refreshView();
				return;
			}

			if (
				selection &&
				typeof selection === "object" &&
				"kind" in selection &&
				(selection as { kind?: string }).kind === "toggleCalendar"
			) {
				const calendarId = (selection as unknown as { calendarId: string })
					.calendarId;
				route.selectedCalendarIds = route.selectedCalendarIds.includes(
					calendarId,
				)
					? route.selectedCalendarIds.filter((id) => id !== calendarId)
					: [...route.selectedCalendarIds, calendarId];
				deps.refreshView();
			}
		},
	};
}

function isConnectorTarget(selection: unknown): selection is ConnectorTarget {
	return (
		selection === "notion" ||
		selection === "gmail" ||
		selection === "google-calendar" ||
		selection === "apple-notes"
	);
}

function getConnectorLabel(connector: ConnectorTarget): string {
	switch (connector) {
		case "notion":
			return "Notion";
		case "gmail":
			return "Gmail";
		case "google-calendar":
			return "Google Calendar";
		case "apple-notes":
			return "Apple Notes";
		default: {
			const exhaustiveConnector: never = connector;
			return exhaustiveConnector;
		}
	}
}

function getProviderDisconnectLabel(provider: "google" | "notion"): string {
	return provider === "notion" ? "Notion OAuth account" : "Google account";
}

function getDisconnectLabel(route: ConfirmDisconnectRoute): string {
	if (route.mode === "provider") {
		return getProviderDisconnectLabel(route.provider ?? "google");
	}

	return getConnectorLabel(route.connector);
}

function getDisconnectSuccessText(route: ConfirmDisconnectRoute): string {
	if (route.mode === "provider") {
		return `${getProviderDisconnectLabel(route.provider ?? "google")} disconnected.`;
	}

	if (route.connector === "notion") {
		return "Notion disconnected.";
	}

	return `${getConnectorLabel(route.connector)} disabled.`;
}
