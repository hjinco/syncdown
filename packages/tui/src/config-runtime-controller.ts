import type { AppPaths, SyncRuntimeSnapshot } from "@syncdown/core";
import { EXIT_CODES } from "@syncdown/core";
import type { ConfigTuiRequest } from "./index.js";
import type { DraftState } from "./state.js";
import { collectDiagnostics, getDraftIntegration } from "./state.js";
import type {
	ConfigUiState,
	SyncDashboardRoute,
	UpdateRoute,
} from "./view-state.js";
import {
	createConfirmResetRoute,
	createDiagnosticsRoute,
	getCurrentRoute,
	popRoute,
	pushRoute,
	setNotice,
} from "./view-state.js";

function isSyncSnapshotBusy(snapshot: SyncRuntimeSnapshot): boolean {
	return (
		snapshot.watch.active ||
		snapshot.integrations.some(
			(integration) => integration.running || integration.queuedImmediateRun,
		)
	);
}

interface ConfigRuntimeControllerDeps {
	ui: ConfigUiState;
	draft: DraftState;
	paths: AppPaths;
	request: ConfigTuiRequest;
	updater: {
		applyUpdate(): Promise<{ message: string }>;
	};
	refreshView(): void;
	runUpdateCheck(showNoticeOnFailure: boolean): Promise<void>;
	finish(code: number): void;
	cancelAuthFlow(): Promise<void>;
}

export function createConfigRuntimeController(
	deps: ConfigRuntimeControllerDeps,
) {
	return {
		async handleAdvancedSelection(selection: unknown): Promise<void> {
			if (selection === "diagnostics") {
				pushRoute(deps.ui, createDiagnosticsRoute(deps.paths, deps.draft));
				deps.refreshView();
				await this.refreshDiagnostics();
				return;
			}

			if (selection !== "resetAppData") {
				return;
			}

			const snapshot = deps.request.session.getSnapshot();
			if (isSyncSnapshotBusy(snapshot)) {
				setNotice(deps.ui, {
					kind: "error",
					text: "Stop the current sync before resetting app data.",
				});
				deps.refreshView();
				return;
			}

			pushRoute(deps.ui, createConfirmResetRoute());
			deps.refreshView();
		},

		async handleConfirmResetSelection(selection: unknown): Promise<void> {
			if (selection === "cancel") {
				popRoute(deps.ui);
				deps.refreshView();
				return;
			}

			if (selection !== "reset") {
				return;
			}

			const snapshot = deps.request.session.getSnapshot();
			if (isSyncSnapshotBusy(snapshot)) {
				setNotice(deps.ui, {
					kind: "error",
					text: "Stop the current sync before resetting app data.",
				});
				popRoute(deps.ui);
				deps.refreshView();
				return;
			}

			const writes: string[] = [];
			const errors: string[] = [];
			await deps.request.session.dispose();
			const exitCode = await deps.request.app.reset({
				write(line) {
					writes.push(line);
				},
				error(line) {
					errors.push(line);
				},
			});

			if (exitCode !== EXIT_CODES.OK) {
				deps.finish(exitCode);
				for (const line of errors.length > 0
					? errors
					: ["Failed to reset app data."]) {
					deps.request.io.error(line);
				}
				return;
			}

			deps.finish(EXIT_CODES.OK);
			for (const line of writes) {
				deps.request.io.write(line);
			}
		},

		async handleDiagnosticsSelection(selection: unknown): Promise<void> {
			if (selection === "refresh") {
				await this.refreshDiagnostics();
			}
		},

		async activateUpdateSelection(
			route: UpdateRoute,
			selection: unknown,
		): Promise<void> {
			if (route.installBusy) {
				return;
			}

			if (selection === "checkNow") {
				await deps.runUpdateCheck(true);
				return;
			}

			if (selection !== "installUpdate") {
				return;
			}

			route.installBusy = true;
			setNotice(deps.ui, null);
			deps.refreshView();

			try {
				const result = await deps.updater.applyUpdate();
				setNotice(deps.ui, {
					kind: "success",
					text: result.message,
				});
			} catch (error) {
				setNotice(deps.ui, {
					kind: "error",
					text:
						error instanceof Error ? error.message : "Unknown update failure.",
				});
			} finally {
				route.installBusy = false;
				deps.refreshView();
			}
		},

		async activateSyncDashboardSelection(
			route: SyncDashboardRoute,
			selection: unknown,
		): Promise<void> {
			if (route.busy) {
				if (selection === "cancelActiveRun" && !route.cancelPending) {
					route.cancelPending = true;
					setNotice(deps.ui, {
						kind: "success",
						text: "Cancelling sync...",
					});
					deps.refreshView();
					void deps.request.session.cancelActiveRun().catch((error) => {
						route.cancelPending = false;
						setNotice(deps.ui, {
							kind: "error",
							text:
								error instanceof Error
									? error.message
									: "Unknown sync action failure.",
						});
						deps.refreshView();
					});
				}
				return;
			}

			if (
				isSyncSnapshotBusy(route.snapshot) &&
				selection !== "cancelActiveRun"
			) {
				setNotice(deps.ui, {
					kind: "error",
					text: "Stop the current sync before using other actions.",
				});
				deps.refreshView();
				return;
			}

			if (selection === "clearLog") {
				route.clearedAfter =
					route.snapshot.logs.at(-1)?.timestamp ?? route.clearedAfter;
				deps.refreshView();
				return;
			}

			if (selection === "toggleDetailedLogs") {
				route.showDetailedLogs = !route.showDetailedLogs;
				deps.refreshView();
				return;
			}

			route.busy = true;
			route.cancelPending = false;
			setNotice(deps.ui, null);
			deps.refreshView();

			try {
				if (selection === "cancelActiveRun") {
					if (route.snapshot.watch.active) {
						await deps.request.session.cancelActiveRun();
						await deps.request.session.stopWatch();
						setNotice(deps.ui, {
							kind: "success",
							text: "Sync stopped.",
						});
					} else {
						await deps.request.session.cancelActiveRun();
						setNotice(deps.ui, {
							kind: "success",
							text: "Sync cancelled.",
						});
					}
				} else if (selection === "startWatch") {
					await deps.request.session.startWatch({ kind: "per-integration" });
					setNotice(deps.ui, {
						kind: "success",
						text: "Watch started.",
					});
				} else if (selection === "stopWatch") {
					await deps.request.session.stopWatch();
					setNotice(deps.ui, {
						kind: "success",
						text: "Watch stopped.",
					});
				} else if (selection === "runAll") {
					await deps.request.session.runNow({ kind: "all" });
					setSyncRunNotice("Run completed.");
				} else if (selection === "runAllReset") {
					await deps.request.session.runNow(
						{ kind: "all" },
						{ resetState: true },
					);
					setSyncRunNotice("Full resync completed.");
				} else if (selection === "runNotion") {
					await deps.request.session.runNow({
						kind: "integration",
						integrationId: getDraftIntegration(deps.draft, "notion").id,
					});
					setSyncRunNotice("Notion run completed.");
				} else if (selection === "runNotionReset") {
					await deps.request.session.runNow(
						{
							kind: "integration",
							integrationId: getDraftIntegration(deps.draft, "notion").id,
						},
						{ resetState: true },
					);
					setSyncRunNotice("Notion full resync completed.");
				} else if (selection === "runGmail") {
					await deps.request.session.runNow({
						kind: "integration",
						integrationId: getDraftIntegration(deps.draft, "gmail").id,
					});
					setSyncRunNotice("Gmail run completed.");
				} else if (selection === "runGmailReset") {
					await deps.request.session.runNow(
						{
							kind: "integration",
							integrationId: getDraftIntegration(deps.draft, "gmail").id,
						},
						{ resetState: true },
					);
					setSyncRunNotice("Gmail full resync completed.");
				} else if (selection === "runGoogleCalendar") {
					await deps.request.session.runNow({
						kind: "integration",
						integrationId: getDraftIntegration(deps.draft, "google-calendar")
							.id,
					});
					setSyncRunNotice("Google Calendar run completed.");
				} else if (selection === "runGoogleCalendarReset") {
					await deps.request.session.runNow(
						{
							kind: "integration",
							integrationId: getDraftIntegration(deps.draft, "google-calendar")
								.id,
						},
						{ resetState: true },
					);
					setSyncRunNotice("Google Calendar full resync completed.");
				} else if (selection === "runAppleNotes") {
					await deps.request.session.runNow({
						kind: "integration",
						integrationId: getDraftIntegration(deps.draft, "apple-notes").id,
					});
					setSyncRunNotice("Apple Notes run completed.");
				} else if (selection === "runAppleNotesReset") {
					await deps.request.session.runNow(
						{
							kind: "integration",
							integrationId: getDraftIntegration(deps.draft, "apple-notes").id,
						},
						{ resetState: true },
					);
					setSyncRunNotice("Apple Notes full resync completed.");
				}
			} catch (error) {
				setNotice(deps.ui, {
					kind: "error",
					text:
						error instanceof Error
							? error.message
							: "Unknown sync action failure.",
				});
			} finally {
				route.busy = false;
				route.cancelPending = false;
				route.snapshot = deps.request.session.getSnapshot();
				deps.refreshView();
			}
		},

		async refreshDiagnostics(): Promise<void> {
			const route = getCurrentRoute(deps.ui);
			if (route.id !== "diagnostics") {
				return;
			}

			route.loading = true;
			setNotice(deps.ui, null);
			deps.refreshView();

			try {
				const diagnostics = await collectDiagnostics(
					deps.request.app,
					deps.request.io,
					deps.paths,
					deps.draft,
				);
				if (getCurrentRoute(deps.ui) !== route) {
					return;
				}

				route.loading = false;
				route.title = diagnostics.title;
				route.body = diagnostics.body;
				deps.refreshView();
			} catch (error) {
				if (getCurrentRoute(deps.ui) !== route) {
					return;
				}

				route.loading = false;
				setNotice(deps.ui, {
					kind: "error",
					text:
						error instanceof Error
							? error.message
							: "Unknown diagnostics failure.",
				});
				deps.refreshView();
			}
		},

		async handleBack(): Promise<void> {
			const route = getCurrentRoute(deps.ui);
			if (route.id === "home") {
				return;
			}

			if (
				route.id === "syncDashboard" &&
				(route.busy || isSyncSnapshotBusy(route.snapshot))
			) {
				setNotice(deps.ui, {
					kind: "error",
					text: "Stop the current sync before leaving the sync dashboard.",
				});
				deps.refreshView();
				return;
			}

			if (route.id === "connectorAuth") {
				await deps.cancelAuthFlow();
				return;
			}

			popRoute(deps.ui);
			deps.refreshView();
		},
	};

	function setSyncRunNotice(successText: string): void {
		const snapshot = deps.request.session.getSnapshot();
		if (snapshot.lastRunError === "Sync cancelled by user.") {
			setNotice(deps.ui, {
				kind: "success",
				text: "Sync cancelled.",
			});
			return;
		}

		if (snapshot.lastRunExitCode === EXIT_CODES.OK) {
			setNotice(deps.ui, {
				kind: "success",
				text: successText,
			});
			return;
		}

		setNotice(deps.ui, {
			kind: "error",
			text:
				snapshot.lastRunError ??
				`Sync failed with exit code ${snapshot.lastRunExitCode ?? "unknown"}.`,
		});
	}
}
