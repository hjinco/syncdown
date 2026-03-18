import * as OpenTui from "@opentui/core";
import type {
	AppPaths,
	GmailSyncFilter,
	SyncIntervalPreset,
	SyncRuntimeEvent,
	SyncRuntimeSnapshot,
	UpdateStatus,
} from "@syncdown/core";
import {
	collectGoogleProviderScopes,
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	EXIT_CODES,
	getGoogleConnectionSecretNames,
	getGoogleOAuthAppSecretNames,
	validateManagedOutputDirectory,
} from "@syncdown/core";
import type {
	BrowserOpenResult,
	GoogleAuthCredentials,
	GoogleAuthSession,
	NotionOAuthSession,
	TuiAuthService,
} from "./auth.js";
import { createTuiAuthService } from "./auth.js";
import type { ConfigTuiRequest } from "./index.js";
import type { DraftState, OutputPresetAction } from "./state.js";
import {
	buildOutputPresetPaths,
	cloneDraftState,
	collectDiagnostics,
	getDraftIntegration,
	getDraftSelectedGoogleCalendarIds,
	hasAnyStoredCredentials,
	isDraftConnectorEnabled,
	normalizeOutputPath,
	saveDraft,
	setConnectorEnabled,
	setGmailSyncFilter,
	setOutputDirectory,
	setSelectedGoogleCalendarIds,
	setSyncInterval,
	stageConnectorDisconnect,
	stageGoogleConnection,
	stageNotionConnection,
	stageNotionOAuthConnection,
	stageProviderDisconnect,
	stageStoredCredentialDisconnect,
	syncDraftState,
} from "./state.js";
import type {
	ConfigUiState,
	ConnectorAuthRoute,
	GoogleCalendarSelectionRoute,
	HomeRoute,
	SyncDashboardRoute,
	UpdateRoute,
} from "./view-state.js";
import {
	clampRouteSelection,
	createConfigUiState,
	createConfirmDisconnectRoute,
	createConfirmResetRoute,
	createConnectorAuthRoute,
	createConnectorDetailsRoute,
	createDiagnosticsRoute,
	createGmailFilterRoute,
	createGoogleCalendarSelectionRoute,
	createIntervalRoute,
	createOutputCustomRoute,
	createSyncDashboardRoute,
	createUpdateRoute,
	getBreadcrumb,
	getConnectorAuthDocsUrl,
	getCurrentAuthField,
	getCurrentRoute,
	getInputProps,
	getKeyHint,
	getRouteBody,
	getRouteOptions,
	isInputRoute,
	popRoute,
	pushRoute,
	setNotice,
} from "./view-state.js";

const SECRET_MASK = "•";
const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_VISIBLE_SELECT_ITEMS = 5;
const NOTICE_HEIGHT = 3;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const SOURCE_UPDATE_REASON = "Self-update unavailable in source/dev run.";

interface CliRoot {
	flexDirection: string;
	padding: number;
	rowGap: number;
	add(child: unknown): void;
}

interface CliKeypressEvent {
	name: string;
	ctrl: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

interface CliPasteEvent {
	text: string;
	preventDefault(): void;
	stopPropagation(): void;
}

interface CliKeyInput {
	on(eventName: "keypress", handler: (event: CliKeypressEvent) => void): void;
	on(eventName: "paste", handler: (event: CliPasteEvent) => void): void;
}

interface CliRenderer {
	root: CliRoot;
	width: number;
	keyInput: CliKeyInput;
	start(): void;
	destroy(): void;
	requestRender(): void;
}

interface BoxRenderableLike {
	add(child: unknown): void;
}

interface TextRenderableLike {
	height: number;
	content: string;
	visible: boolean;
}

interface SelectRenderableLike {
	height: number;
	options: unknown[];
	selectedIndex: number;
	showDescription: boolean;
	visible: boolean;
	on(eventName: string, handler: () => void): void;
	getSelectedIndex(): number;
	focus(): void;
}

interface InputRenderableLike {
	visible: boolean;
	value: string;
	placeholder: string;
	textColor: string;
	focusedTextColor: string;
	backgroundColor: string;
	focusedBackgroundColor: string;
	on(eventName: string, handler: (value: string) => void): void;
	focus(): void;
}

type BoxRenderableCtor = new (
	renderer: CliRenderer,
	options: Record<string, unknown>,
) => BoxRenderableLike;
type TextRenderableCtor = new (
	renderer: CliRenderer,
	options: Record<string, unknown>,
) => TextRenderableLike;
type SelectRenderableCtor = new (
	renderer: CliRenderer,
	options: Record<string, unknown>,
) => SelectRenderableLike;
type InputRenderableCtor = new (
	renderer: CliRenderer,
	options: Record<string, unknown>,
) => InputRenderableLike;

const {
	BoxRenderable,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
} = OpenTui as unknown as {
	BoxRenderable: BoxRenderableCtor;
	createCliRenderer(options: Record<string, unknown>): Promise<CliRenderer>;
	InputRenderable: InputRenderableCtor;
	InputRenderableEvents: { INPUT: string };
	SelectRenderable: SelectRenderableCtor;
	SelectRenderableEvents: { ITEM_SELECTED: string; SELECTION_CHANGED: string };
	TextRenderable: TextRenderableCtor;
};

interface ConfigTuiAppOptions {
	renderer: CliRenderer;
	request: ConfigTuiRequest;
	paths: AppPaths;
	draft: DraftState;
	authService: TuiAuthService;
}

function createNoopUpdater(): NonNullable<ConfigTuiRequest["updater"]> {
	return {
		getCurrentVersion() {
			return "0.1.0";
		},
		supportsSelfUpdate() {
			return false;
		},
		checkForUpdate() {
			return new Promise<UpdateStatus>(() => {});
		},
		async applyUpdate() {
			throw new Error(SOURCE_UPDATE_REASON);
		},
	};
}

function isSyncSnapshotBusy(snapshot: SyncRuntimeSnapshot): boolean {
	return (
		snapshot.watch.active ||
		snapshot.integrations.some(
			(integration) => integration.running || integration.queuedImmediateRun,
		)
	);
}

export class ConfigTuiApp {
	private readonly renderer: CliRenderer;
	private readonly request: ConfigTuiRequest;
	private readonly updater: NonNullable<ConfigTuiRequest["updater"]>;
	private readonly paths: AppPaths;
	private readonly draft: DraftState;
	private readonly authService: TuiAuthService;
	private readonly ui: ConfigUiState;
	private readonly headerBreadcrumb: TextRenderableLike;
	private readonly headerDivider: TextRenderableLike;
	private readonly bodyText: TextRenderableLike;
	private readonly pageNotice: TextRenderableLike;
	private readonly select: SelectRenderableLike;
	private readonly input: InputRenderableLike;
	private readonly inputMask: TextRenderableLike;
	private readonly footerText: TextRenderableLike;
	private exitResolver: ((code: number) => void) | null = null;
	private exiting = false;
	private syncingView = false;
	private activeAuthRun = 0;
	private activeBrowserAuthSession:
		| GoogleAuthSession
		| NotionOAuthSession
		| null = null;
	private readonly syncUnsubscribe: () => void;
	private readonly updateCheckTimer: ReturnType<typeof setInterval> | null;

	constructor(options: ConfigTuiAppOptions) {
		this.renderer = options.renderer;
		this.request = options.request;
		this.updater = options.request.updater ?? createNoopUpdater();
		this.paths = options.paths;
		this.draft = options.draft;
		this.authService = options.authService;
		const supportsSelfUpdate = this.updater.supportsSelfUpdate();
		this.ui = createConfigUiState(
			this.paths,
			this.draft,
			this.updater.getCurrentVersion(),
			supportsSelfUpdate,
			supportsSelfUpdate ? null : SOURCE_UPDATE_REASON,
			options.request.docsBaseUrl ?? null,
		);

		this.renderer.root.flexDirection = "column";
		this.renderer.root.padding = 1;
		this.renderer.root.rowGap = 1;

		this.headerBreadcrumb = new TextRenderable(this.renderer, {
			height: 1,
			content: "",
		});
		this.headerDivider = new TextRenderable(this.renderer, {
			height: 1,
			content: "─".repeat(200),
		});

		const contentBox = new BoxRenderable(this.renderer, {
			width: "100%",
			flexGrow: 1,
			flexDirection: "column",
			justifyContent: "flex-end",
			padding: 1,
			rowGap: 1,
		});
		this.bodyText = new TextRenderable(this.renderer, {
			wrapMode: "word",
			content: "",
		});
		const controlsBox = new BoxRenderable(this.renderer, {
			width: "100%",
			flexDirection: "column",
			rowGap: 1,
		});
		this.select = new SelectRenderable(this.renderer, {
			height: MAX_VISIBLE_SELECT_ITEMS * 2,
			options: [],
			selectedIndex: 0,
			showDescription: true,
			focusable: true,
		});
		this.input = new InputRenderable(this.renderer, {
			height: 1,
			value: "",
			placeholder: "",
			focusable: true,
			visible: false,
			onSubmit: () => {
				void this.submitInput();
			},
		});
		this.inputMask = new TextRenderable(this.renderer, {
			height: 1,
			content: "",
			visible: false,
		});
		this.pageNotice = new TextRenderable(this.renderer, {
			height: 0,
			wrapMode: "word",
			content: "",
			visible: false,
		});
		contentBox.add(this.bodyText);
		controlsBox.add(this.pageNotice);
		controlsBox.add(this.select);
		controlsBox.add(this.input);
		controlsBox.add(this.inputMask);

		this.footerText = new TextRenderable(this.renderer, {
			height: 1,
			wrapMode: "word",
			content: "",
		});

		this.renderer.root.add(this.headerBreadcrumb);
		this.renderer.root.add(this.headerDivider);
		this.renderer.root.add(contentBox);
		this.renderer.root.add(controlsBox);
		this.renderer.root.add(this.footerText);

		this.syncUnsubscribe = this.request.session.subscribe((event) => {
			this.handleSyncRuntimeEvent(event);
		});

		this.wireEvents();
		this.refreshView();
		this.startUpdateChecks();
		this.updateCheckTimer = setInterval(() => {
			void this.runUpdateCheck(true);
		}, UPDATE_CHECK_INTERVAL_MS);
		this.updateCheckTimer.unref?.();
	}

	static async create(
		request: ConfigTuiRequest,
		paths: AppPaths,
		draft: DraftState,
		renderer?: CliRenderer,
		authService = createTuiAuthService(),
	): Promise<ConfigTuiApp> {
		const resolvedRenderer =
			renderer ??
			(await createCliRenderer({
				useAlternateScreen: true,
				useConsole: false,
				exitOnCtrlC: false,
				useMouse: false,
			}));

		return new ConfigTuiApp({
			renderer: resolvedRenderer,
			request,
			paths,
			draft,
			authService,
		});
	}

	async run(): Promise<number> {
		this.renderer.start();
		return new Promise<number>((resolve) => {
			this.exitResolver = resolve;
		});
	}

	destroy(): void {
		this.syncUnsubscribe();
		if (this.updateCheckTimer) {
			clearInterval(this.updateCheckTimer);
		}
		this.renderer.destroy();
	}

	private wireEvents(): void {
		this.select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
			if (this.syncingView) {
				return;
			}
			const route = getCurrentRoute(this.ui);
			route.selectedIndex = this.select.getSelectedIndex();
			this.refreshView();
		});

		this.select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
			void this.activateCurrentSelection();
		});

		this.input.on(InputRenderableEvents.INPUT, (value: string) => {
			if (this.syncingView) {
				return;
			}
			const route = getCurrentRoute(this.ui);
			if (route.id === "outputCustom") {
				route.value = value;
				route.error = null;
			} else if (
				route.id === "connectorAuth" &&
				route.stage === "collect-input"
			) {
				route.inputValue = value;
				route.error = null;
			}
			if (this.ui.notice?.kind === "error") {
				setNotice(this.ui, null);
			}
			this.refreshView();
			this.renderer.requestRender();
		});

		this.renderer.keyInput.on("keypress", (key) => {
			if (this.exiting) {
				return;
			}

			if (this.handleGlobalKey(key.name, key.ctrl)) {
				key.preventDefault();
				key.stopPropagation();
			}
		});

		this.renderer.keyInput.on("paste", (event) => {
			const route = getCurrentRoute(this.ui);
			if (!isInputRoute(route)) {
				return;
			}

			const pasted = `${event.text}`.replace(/[\n\r]/g, "");
			if (route.id === "outputCustom") {
				route.value = `${route.value}${pasted}`;
			} else {
				route.inputValue = `${route.inputValue}${pasted}`;
			}

			event.preventDefault();
			event.stopPropagation();
			this.refreshView();
			this.renderer.requestRender();
		});
	}

	private handleGlobalKey(name: string, ctrl: boolean): boolean {
		if (ctrl && name === "c") {
			void this.exitApp();
			return true;
		}

		if (
			(name === "enter" || name === "return") &&
			isInputRoute(getCurrentRoute(this.ui))
		) {
			void this.submitInput();
			return true;
		}

		if (name === "q") {
			void this.exitApp();
			return true;
		}

		if (
			name === "escape" ||
			(name === "left" && !isInputRoute(getCurrentRoute(this.ui)))
		) {
			void this.handleBack();
			return true;
		}

		if (name === "r" && getCurrentRoute(this.ui).id === "diagnostics") {
			void this.refreshDiagnostics();
			return true;
		}

		return false;
	}

	private handleSyncRuntimeEvent(event: SyncRuntimeEvent): void {
		if (event.type !== "snapshot") {
			return;
		}

		let updated = false;
		for (const route of this.ui.routes) {
			if (route.id === "syncDashboard") {
				route.snapshot = event.snapshot;
				updated = true;
			}
		}

		if (updated) {
			this.refreshView();
		}
	}

	private getHomeRoute(): HomeRoute {
		const homeRoute = this.ui.routes[0];
		if (!homeRoute || homeRoute.id !== "home") {
			throw new Error("Missing home route");
		}
		return homeRoute;
	}

	private forEachUpdateRoute(visitor: (route: UpdateRoute) => void): void {
		for (const route of this.ui.routes) {
			if (route.id === "update") {
				visitor(route);
			}
		}
	}

	private setUpdateCheckState(checking: boolean): void {
		const home = this.getHomeRoute();
		home.updateChecking = checking;
		this.forEachUpdateRoute((route) => {
			route.checking = checking;
		});
	}

	private applyUpdateStatus(status: UpdateStatus): void {
		const home = this.getHomeRoute();
		home.currentVersion = status.currentVersion;
		home.updateStatus = status;
		home.updateError = null;
		home.updateChecking = false;
		home.supportsSelfUpdate = status.canSelfUpdate;
		home.supportReason = status.reason;

		this.forEachUpdateRoute((route) => {
			route.currentVersion = status.currentVersion;
			route.status = status;
			route.error = null;
			route.checking = false;
			route.supportsSelfUpdate = status.canSelfUpdate;
			route.supportReason = status.reason;
		});
	}

	private applyUpdateError(message: string): void {
		const home = this.getHomeRoute();
		home.updateError = message;
		home.updateChecking = false;

		this.forEachUpdateRoute((route) => {
			route.error = message;
			route.checking = false;
		});
	}

	private startUpdateChecks(): void {
		this.setUpdateCheckState(true);
		this.refreshView();
		void this.runUpdateCheck(true);
	}

	private async runUpdateCheck(showNoticeOnFailure: boolean): Promise<void> {
		this.setUpdateCheckState(true);
		this.refreshView();

		try {
			const status = await this.updater.checkForUpdate();
			this.applyUpdateStatus(status);
			this.refreshView();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Update check failed.";
			this.applyUpdateError(message);
			if (showNoticeOnFailure) {
				setNotice(this.ui, {
					kind: "error",
					text: message,
				});
			}
			this.refreshView();
		}
	}

	private refreshView(): void {
		const route = getCurrentRoute(this.ui);
		clampRouteSelection(route, this.draft, this.ui.docsBaseUrl);

		const body = getRouteBody(
			route,
			this.paths,
			this.draft,
			Math.max(48, this.renderer.width - 6),
			this.ui.docsBaseUrl,
		);
		const options = getRouteOptions(route, this.draft, this.ui.docsBaseUrl);
		const inputProps = getInputProps(route);
		const compactSelect = route.id === "syncDashboard";

		this.syncingView = true;
		try {
			this.headerBreadcrumb.content = getBreadcrumb(this.ui);
			this.bodyText.content = body;
			this.pageNotice.content = this.ui.notice?.text ?? "";
			this.footerText.content = getKeyHint(route);

			this.select.showDescription = !compactSelect;
			this.select.options = options;
			this.select.selectedIndex = route.selectedIndex;
			this.select.visible = options.length > 0;
			const linesPerOption = this.select.showDescription ? 2 : 1;
			this.select.height = Math.max(
				1,
				Math.min(options.length, MAX_VISIBLE_SELECT_ITEMS) * linesPerOption,
			);

			const hasNotice = Boolean(this.ui.notice?.text);
			this.pageNotice.visible = hasNotice;
			this.pageNotice.height = hasNotice ? NOTICE_HEIGHT : 0;

			if (inputProps) {
				this.input.visible = true;
				this.input.value = inputProps.value;
				this.input.placeholder = inputProps.placeholder;
				this.input.textColor = inputProps.secret ? "#1b1b1b" : "#f4f4f4";
				this.input.focusedTextColor = inputProps.secret ? "#1b1b1b" : "#f4f4f4";
				this.input.backgroundColor = "#1b1b1b";
				this.input.focusedBackgroundColor = "#1b1b1b";
				this.inputMask.visible =
					inputProps.secret && inputProps.value.length > 0;
				this.inputMask.content = inputProps.secret
					? SECRET_MASK.repeat(inputProps.value.length)
					: "";
			} else {
				this.input.visible = false;
				this.inputMask.visible = false;
				this.inputMask.content = "";
			}
		} finally {
			this.syncingView = false;
		}

		this.focusCurrentControl();
		this.renderer.requestRender();
	}

	private focusCurrentControl(): void {
		const route = getCurrentRoute(this.ui);
		if (isInputRoute(route)) {
			this.input.focus();
			return;
		}

		this.select.focus();
	}

	private async activateCurrentSelection(): Promise<void> {
		const route = getCurrentRoute(this.ui);
		const option = getRouteOptions(route, this.draft, this.ui.docsBaseUrl)[
			route.selectedIndex
		];
		const selection = option?.value;

		if (route.id === "home") {
			if (selection === "sync") {
				pushRoute(
					this.ui,
					createSyncDashboardRoute(this.request.session.getSnapshot()),
				);
			} else if (selection === "connectors") {
				pushRoute(this.ui, { id: "connectors", selectedIndex: 0 });
			} else if (selection === "output") {
				pushRoute(this.ui, { id: "output", selectedIndex: 0 });
			} else if (selection === "schedule") {
				pushRoute(this.ui, { id: "schedule", selectedIndex: 0 });
			} else if (selection === "advanced") {
				pushRoute(this.ui, { id: "advanced", selectedIndex: 0 });
			} else if (selection === "update") {
				pushRoute(this.ui, createUpdateRoute(this.getHomeRoute()));
			}
			this.refreshView();
			return;
		}

		if (route.id === "syncDashboard") {
			await this.activateSyncDashboardSelection(route, selection);
			return;
		}

		if (route.id === "connectors") {
			if (
				selection === "notion" ||
				selection === "gmail" ||
				selection === "google-calendar"
			) {
				pushRoute(this.ui, createConnectorDetailsRoute(selection));
			}
			this.refreshView();
			return;
		}

		if (route.id === "connectorDetails") {
			if (selection === "connectToken" && route.connector === "notion") {
				pushRoute(
					this.ui,
					createConnectorAuthRoute(route.connector, "notion-token"),
				);
			} else if (selection === "connectOAuth" && route.connector === "notion") {
				pushRoute(
					this.ui,
					createConnectorAuthRoute(route.connector, "notion-oauth"),
				);
			} else if (selection === "connect") {
				pushRoute(
					this.ui,
					createConnectorAuthRoute(route.connector, "google-oauth"),
				);
			} else if (selection === "gmailFilter" && route.connector === "gmail") {
				pushRoute(this.ui, createGmailFilterRoute());
			} else if (
				selection === "googleCalendarSelection" &&
				route.connector === "google-calendar"
			) {
				const calendarRoute = createGoogleCalendarSelectionRoute(
					getDraftSelectedGoogleCalendarIds(this.draft),
				);
				pushRoute(this.ui, calendarRoute);
				this.refreshView();
				await this.refreshGoogleCalendarSelection(calendarRoute);
			} else if (selection === "enable" && route.connector === "gmail") {
				const hasScopes = await this.ensureGoogleScopesForConnector("gmail");
				if (!hasScopes) {
					return;
				}

				const saved = await this.persistDraftMutation(
					(draft) => setConnectorEnabled(draft, "gmail", true),
					"Failed to enable Gmail.",
				);
				if (saved) {
					setNotice(this.ui, {
						kind: "success",
						text: "Gmail enabled.",
					});
				}
			} else if (
				selection === "enable" &&
				route.connector === "google-calendar"
			) {
				const hasScopes =
					await this.ensureGoogleScopesForConnector("google-calendar");
				if (!hasScopes) {
					return;
				}

				if (getDraftSelectedGoogleCalendarIds(this.draft).length === 0) {
					const calendarRoute = createGoogleCalendarSelectionRoute([]);
					pushRoute(this.ui, calendarRoute);
					this.refreshView();
					await this.refreshGoogleCalendarSelection(calendarRoute);
					return;
				}

				const saved = await this.persistDraftMutation(
					(draft) => setConnectorEnabled(draft, "google-calendar", true),
					"Failed to enable Google Calendar.",
				);
				if (saved) {
					setNotice(this.ui, {
						kind: "success",
						text: "Google Calendar enabled.",
					});
				}
			} else if (selection === "disable") {
				pushRoute(
					this.ui,
					createConfirmDisconnectRoute(route.connector, "connector"),
				);
			} else if (
				selection === "disconnectProvider" &&
				(route.connector === "gmail" || route.connector === "google-calendar")
			) {
				pushRoute(
					this.ui,
					createConfirmDisconnectRoute(route.connector, "provider", "google"),
				);
			} else if (selection === "disconnect") {
				if (
					!hasAnyStoredCredentials(this.draft, route.connector) &&
					!isDraftConnectorEnabled(this.draft, route.connector)
				) {
					setNotice(this.ui, {
						kind: "error",
						text: "Connector is already disconnected.",
					});
					this.refreshView();
					return;
				}
				pushRoute(
					this.ui,
					createConfirmDisconnectRoute(route.connector, "connector"),
				);
			}
			this.refreshView();
			return;
		}

		if (route.id === "connectorAuth") {
			await this.activateAuthSelection(route, selection);
			return;
		}

		if (route.id === "confirmDisconnect") {
			if (selection === "cancel") {
				popRoute(this.ui);
				this.refreshView();
				return;
			}

			const connector = route.connector;
			const disconnectLabel =
				route.mode === "provider"
					? route.provider === "notion"
						? "Notion OAuth account"
						: "Google account"
					: connector === "notion"
						? "Notion"
						: connector === "gmail"
							? "Gmail"
							: "Google Calendar";
			const saved = await this.persistDraftMutation((draft) => {
				if (route.mode === "provider") {
					stageProviderDisconnect(draft, route.provider ?? "google");
					return;
				}

				if (connector === "notion") {
					stageStoredCredentialDisconnect(draft, connector);
					return;
				}

				stageConnectorDisconnect(draft, connector);
			}, `Failed to disconnect ${disconnectLabel}.`);
			if (saved) {
				popRoute(this.ui);
				setNotice(this.ui, {
					kind: "success",
					text:
						route.mode === "provider"
							? route.provider === "notion"
								? "Notion OAuth account disconnected."
								: "Google account disconnected."
							: connector === "notion"
								? "Notion disconnected."
								: connector === "gmail"
									? "Gmail disabled."
									: "Google Calendar disabled.",
				});
				this.refreshView();
			}
			return;
		}

		if (route.id === "output") {
			if (selection === "custom") {
				pushRoute(this.ui, createOutputCustomRoute(this.draft));
				this.refreshView();
				return;
			}

			const preset = selection as
				| Exclude<OutputPresetAction, "custom">
				| undefined;
			if (!preset) {
				return;
			}

			const presetPaths = buildOutputPresetPaths();
			const saved = await this.persistOutputDirectory(presetPaths[preset]);
			if (saved) {
				setNotice(this.ui, {
					kind: "success",
					text: "Output directory saved.",
				});
				this.refreshView();
			}
			return;
		}

		if (route.id === "schedule") {
			if (
				selection === "notion" ||
				selection === "gmail" ||
				selection === "google-calendar"
			) {
				pushRoute(this.ui, createIntervalRoute(selection));
			}
			this.refreshView();
			return;
		}

		if (route.id === "interval") {
			const interval = selection as SyncIntervalPreset | undefined;
			if (!interval) {
				return;
			}

			const connector = route.connector;
			const saved = await this.persistDraftMutation(
				(draft) => setSyncInterval(draft, connector, interval),
				`Failed to save the ${connector === "notion" ? "Notion" : connector === "gmail" ? "Gmail" : "Google Calendar"} interval.`,
			);
			if (saved) {
				popRoute(this.ui);
				setNotice(this.ui, {
					kind: "success",
					text: `${connector === "notion" ? "Notion" : connector === "gmail" ? "Gmail" : "Google Calendar"} interval saved.`,
				});
				this.refreshView();
			}
			return;
		}

		if (route.id === "gmailFilter") {
			const syncFilter = selection as GmailSyncFilter | undefined;
			if (!syncFilter) {
				return;
			}

			const saved = await this.persistDraftMutation(
				(draft) => setGmailSyncFilter(draft, syncFilter),
				"Failed to save the Gmail inbox filter.",
			);
			if (saved) {
				popRoute(this.ui);
				setNotice(this.ui, {
					kind: "success",
					text: "Gmail inbox filter saved. Run Gmail again to apply the new scope.",
				});
				this.refreshView();
			}
			return;
		}

		if (route.id === "googleCalendarSelection") {
			if (selection === "refresh") {
				await this.refreshGoogleCalendarSelection(route);
				return;
			}

			if (selection === "save") {
				const selectedCalendarIds = [...route.selectedCalendarIds];
				const saved = await this.persistDraftMutation(
					(draft) => setSelectedGoogleCalendarIds(draft, selectedCalendarIds),
					"Failed to save selected Google calendars.",
				);
				if (saved) {
					popRoute(this.ui);
					setNotice(this.ui, {
						kind: "success",
						text: "Google Calendar selection saved.",
					});
					this.refreshView();
				}
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
				this.refreshView();
			}
			return;
		}

		if (route.id === "advanced") {
			if (selection === "diagnostics") {
				pushRoute(this.ui, createDiagnosticsRoute(this.paths, this.draft));
				this.refreshView();
				await this.refreshDiagnostics();
			} else if (selection === "resetAppData") {
				if (isSyncSnapshotBusy(this.request.session.getSnapshot())) {
					setNotice(this.ui, {
						kind: "error",
						text: "Stop the current sync before resetting app data.",
					});
					this.refreshView();
					return;
				}

				pushRoute(this.ui, createConfirmResetRoute());
				this.refreshView();
			}
			return;
		}

		if (route.id === "confirmReset") {
			if (selection === "cancel") {
				popRoute(this.ui);
				this.refreshView();
				return;
			}

			if (selection !== "reset") {
				return;
			}

			if (isSyncSnapshotBusy(this.request.session.getSnapshot())) {
				setNotice(this.ui, {
					kind: "error",
					text: "Stop the current sync before resetting app data.",
				});
				popRoute(this.ui);
				this.refreshView();
				return;
			}

			const writes: string[] = [];
			const errors: string[] = [];
			await this.request.session.dispose();
			const exitCode = await this.request.app.reset({
				write(line) {
					writes.push(line);
				},
				error(line) {
					errors.push(line);
				},
			});

			if (exitCode !== EXIT_CODES.OK) {
				this.finish(exitCode);
				for (const line of errors.length > 0
					? errors
					: ["Failed to reset app data."]) {
					this.request.io.error(line);
				}
				return;
			}

			this.finish(EXIT_CODES.OK);
			for (const line of writes) {
				this.request.io.write(line);
			}
			return;
		}

		if (route.id === "update") {
			await this.activateUpdateSelection(route, selection);
			return;
		}

		if (route.id === "diagnostics") {
			if (selection === "refresh") {
				await this.refreshDiagnostics();
			}
		}
	}

	private async activateUpdateSelection(
		route: UpdateRoute,
		selection: unknown,
	): Promise<void> {
		if (route.installBusy) {
			return;
		}

		if (selection === "checkNow") {
			await this.runUpdateCheck(true);
			return;
		}

		if (selection !== "installUpdate") {
			return;
		}

		route.installBusy = true;
		setNotice(this.ui, null);
		this.refreshView();

		try {
			const result = await this.updater.applyUpdate();
			setNotice(this.ui, {
				kind: "success",
				text: result.message,
			});
		} catch (error) {
			setNotice(this.ui, {
				kind: "error",
				text:
					error instanceof Error ? error.message : "Unknown update failure.",
			});
		} finally {
			route.installBusy = false;
			this.refreshView();
		}
	}

	private async activateSyncDashboardSelection(
		route: SyncDashboardRoute,
		selection: unknown,
	): Promise<void> {
		if (route.busy) {
			if (selection === "cancelActiveRun" && !route.cancelPending) {
				route.cancelPending = true;
				setNotice(this.ui, {
					kind: "success",
					text: "Cancelling sync...",
				});
				this.refreshView();
				void this.request.session.cancelActiveRun().catch((error) => {
					route.cancelPending = false;
					setNotice(this.ui, {
						kind: "error",
						text:
							error instanceof Error
								? error.message
								: "Unknown sync action failure.",
					});
					this.refreshView();
				});
			}
			return;
		}

		const hasActiveSync =
			route.snapshot.watch.active ||
			route.snapshot.integrations.some(
				(integration) => integration.running || integration.queuedImmediateRun,
			);
		if (hasActiveSync && selection !== "cancelActiveRun") {
			setNotice(this.ui, {
				kind: "error",
				text: "Stop the current sync before using other actions.",
			});
			this.refreshView();
			return;
		}

		if (selection === "clearLog") {
			route.clearedAfter =
				route.snapshot.logs.at(-1)?.timestamp ?? route.clearedAfter;
			this.refreshView();
			return;
		}

		if (selection === "toggleDetailedLogs") {
			route.showDetailedLogs = !route.showDetailedLogs;
			this.refreshView();
			return;
		}

		route.busy = true;
		route.cancelPending = false;
		setNotice(this.ui, null);
		this.refreshView();

		try {
			if (selection === "cancelActiveRun") {
				if (route.snapshot.watch.active) {
					await this.request.session.cancelActiveRun();
					await this.request.session.stopWatch();
					setNotice(this.ui, {
						kind: "success",
						text: "Sync stopped.",
					});
				} else {
					await this.request.session.cancelActiveRun();
					setNotice(this.ui, {
						kind: "success",
						text: "Sync cancelled.",
					});
				}
			} else if (selection === "startWatch") {
				await this.request.session.startWatch({ kind: "per-integration" });
				setNotice(this.ui, {
					kind: "success",
					text: "Watch started.",
				});
			} else if (selection === "stopWatch") {
				await this.request.session.stopWatch();
				setNotice(this.ui, {
					kind: "success",
					text: "Watch stopped.",
				});
			} else if (selection === "runAll") {
				await this.request.session.runNow({ kind: "all" });
				this.setSyncRunNotice("Run completed.");
			} else if (selection === "runAllReset") {
				await this.request.session.runNow(
					{ kind: "all" },
					{ resetState: true },
				);
				this.setSyncRunNotice("Full resync completed.");
			} else if (selection === "runNotion") {
				await this.request.session.runNow({
					kind: "integration",
					integrationId: getDraftIntegration(this.draft, "notion").id,
				});
				this.setSyncRunNotice("Notion run completed.");
			} else if (selection === "runNotionReset") {
				await this.request.session.runNow(
					{
						kind: "integration",
						integrationId: getDraftIntegration(this.draft, "notion").id,
					},
					{ resetState: true },
				);
				this.setSyncRunNotice("Notion full resync completed.");
			} else if (selection === "runGmail") {
				await this.request.session.runNow({
					kind: "integration",
					integrationId: getDraftIntegration(this.draft, "gmail").id,
				});
				this.setSyncRunNotice("Gmail run completed.");
			} else if (selection === "runGmailReset") {
				await this.request.session.runNow(
					{
						kind: "integration",
						integrationId: getDraftIntegration(this.draft, "gmail").id,
					},
					{ resetState: true },
				);
				this.setSyncRunNotice("Gmail full resync completed.");
			} else if (selection === "runGoogleCalendar") {
				await this.request.session.runNow({
					kind: "integration",
					integrationId: getDraftIntegration(this.draft, "google-calendar").id,
				});
				this.setSyncRunNotice("Google Calendar run completed.");
			} else if (selection === "runGoogleCalendarReset") {
				await this.request.session.runNow(
					{
						kind: "integration",
						integrationId: getDraftIntegration(this.draft, "google-calendar")
							.id,
					},
					{ resetState: true },
				);
				this.setSyncRunNotice("Google Calendar full resync completed.");
			}
		} catch (error) {
			setNotice(this.ui, {
				kind: "error",
				text:
					error instanceof Error
						? error.message
						: "Unknown sync action failure.",
			});
		} finally {
			route.busy = false;
			route.cancelPending = false;
			route.snapshot = this.request.session.getSnapshot();
			this.refreshView();
		}
	}

	private setSyncRunNotice(successText: string): void {
		const snapshot = this.request.session.getSnapshot();
		if (snapshot.lastRunError === "Sync cancelled by user.") {
			setNotice(this.ui, {
				kind: "success",
				text: "Sync cancelled.",
			});
			return;
		}

		if (snapshot.lastRunExitCode === EXIT_CODES.OK) {
			setNotice(this.ui, {
				kind: "success",
				text: successText,
			});
			return;
		}

		setNotice(this.ui, {
			kind: "error",
			text:
				snapshot.lastRunError ??
				`Sync failed with exit code ${snapshot.lastRunExitCode ?? "unknown"}.`,
		});
	}

	private async activateAuthSelection(
		route: ConnectorAuthRoute,
		selection: unknown,
	): Promise<void> {
		if (route.stage === "intro") {
			if (selection === "cancel") {
				popRoute(this.ui);
				this.refreshView();
				return;
			}

			if (selection === "openDocs") {
				const docsUrl = getConnectorAuthDocsUrl(route, this.ui.docsBaseUrl);
				if (!docsUrl) {
					setNotice(this.ui, {
						kind: "error",
						text: "Docs link is unavailable for this auth flow.",
					});
					this.refreshView();
					return;
				}

				const browserResult = await this.authService.openUrl(docsUrl);
				setNotice(
					this.ui,
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
				this.refreshView();
				return;
			}

			if (route.authMethod === "notion-token") {
				await this.startNotionSetup(route);
			} else if (route.authMethod === "notion-oauth") {
				await this.openOAuthSetupPage(route, () =>
					this.authService.openNotionOAuthSetup(),
				);
			} else {
				await this.openOAuthSetupPage(route, () =>
					this.authService.openGoogleOAuthSetup(),
				);
			}
			return;
		}

		if (route.stage === "success") {
			const message =
				this.ui.notice?.kind === "success"
					? this.ui.notice.text
					: `${route.connector} connected.`;
			popRoute(this.ui);
			setNotice(this.ui, {
				kind: "success",
				text: message,
			});
			this.refreshView();
			return;
		}

		if (selection === "cancel") {
			await this.cancelAuthFlow();
			return;
		}

		if (route.stage === "error" && selection === "retry") {
			await this.retryAuthFlow(route);
		}
	}

	private async submitInput(): Promise<void> {
		const route = getCurrentRoute(this.ui);

		if (route.id === "outputCustom") {
			const value = route.value.trim();
			if (!value) {
				route.error = "Output directory is required.";
				setNotice(this.ui, {
					kind: "error",
					text: route.error,
				});
				this.refreshView();
				return;
			}

			const saved = await this.persistOutputDirectory(value, route);
			if (saved) {
				popRoute(this.ui);
				setNotice(this.ui, {
					kind: "success",
					text: "Output directory saved.",
				});
				this.refreshView();
			}
			return;
		}

		if (route.id !== "connectorAuth" || route.stage !== "collect-input") {
			return;
		}

		const field = getCurrentAuthField(route);
		const value = route.inputValue.trim();
		if (!value) {
			route.error = `${field.label} is required.`;
			setNotice(this.ui, {
				kind: "error",
				text: route.error,
			});
			this.refreshView();
			return;
		}

		route.values[field.key] = value;
		route.error = null;
		setNotice(this.ui, null);

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
			this.refreshView();
			return;
		}

		if (route.authMethod === "notion-token") {
			await this.validateNotionToken(route, value);
			return;
		}

		if (route.authMethod === "notion-oauth") {
			const clientId = route.values.notionOauthClientId ?? "";
			const clientSecret = value;
			await this.runNotionOAuthConnectFlow(route, clientId, clientSecret);
			return;
		}

		const clientId = route.values.googleClientId ?? "";
		const clientSecret = value;
		await this.runGoogleConnectFlow(route, clientId, clientSecret);
	}

	private async startNotionSetup(route: ConnectorAuthRoute): Promise<void> {
		const runId = ++this.activeAuthRun;
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		this.refreshView();

		const browserResult = await this.authService.openNotionSetup();
		if (!this.isAuthRouteActive(route, runId)) {
			return;
		}

		route.browserOpened = browserResult.opened;
		route.browserError = browserResult.error ?? null;
		route.stage = "collect-input";
		route.fieldIndex = 0;
		route.inputValue = route.values.notionToken ?? "";
		route.error = null;
		this.refreshView();
	}

	private async openOAuthSetupPage(
		route: ConnectorAuthRoute,
		openSetupPage: () => Promise<BrowserOpenResult>,
	): Promise<void> {
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		this.refreshView();

		const browserResult = await openSetupPage();
		if (getCurrentRoute(this.ui) !== route) {
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
		this.refreshView();
	}

	private async validateNotionToken(
		route: ConnectorAuthRoute,
		token: string,
	): Promise<void> {
		const runId = ++this.activeAuthRun;
		route.stage = "validating";
		route.error = null;
		route.selectedIndex = 0;
		this.refreshView();

		try {
			await this.authService.validateNotionToken(this.paths, token);
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}

			const saved = await this.persistDraftMutation(
				(draft) => stageNotionConnection(draft, token),
				"Failed to save Notion credentials.",
			);
			if (!saved || !this.isAuthRouteActive(route, runId)) {
				route.stage = "collect-input";
				route.error =
					this.ui.notice?.kind === "error"
						? this.ui.notice.text
						: "Failed to save Notion credentials.";
				this.refreshView();
				return;
			}

			route.stage = "success";
			route.error = null;
			route.selectedIndex = 0;
			setNotice(this.ui, {
				kind: "success",
				text: "Notion connected.",
			});
			this.refreshView();
		} catch (error) {
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}
			route.stage = "collect-input";
			route.error =
				error instanceof Error
					? error.message
					: "Unknown Notion validation failure.";
			setNotice(this.ui, {
				kind: "error",
				text: route.error,
			});
			this.refreshView();
		}
	}

	private async getRequiredGoogleScopes(
		connectorId: "gmail" | "google-calendar",
	): Promise<string[]> {
		const snapshot = await this.request.app.inspect();
		const integrations = snapshot.integrations.map((integration) => ({
			...integration,
			enabled:
				integration.connectorId === "notion"
					? isDraftConnectorEnabled(this.draft, "notion")
					: integration.connectorId === "gmail"
						? isDraftConnectorEnabled(this.draft, "gmail")
						: integration.connectorId === "google-calendar"
							? isDraftConnectorEnabled(this.draft, "google-calendar")
							: integration.enabled,
		}));
		return collectGoogleProviderScopes(integrations, {
			includeIds: [
				snapshot.integrations.find(
					(integration) => integration.connectorId === connectorId,
				)?.id ?? getDraftIntegration(this.draft, connectorId).id,
			],
		});
	}

	private async getCurrentGoogleOAuthAppCredentials(): Promise<{
		clientId: string;
		clientSecret: string;
	} | null> {
		const clientId =
			this.draft.googleClientId.action === "set"
				? this.draft.googleClientId.value
				: this.draft.googleClientId.action === "delete"
					? null
					: await this.request.secrets.getSecret(
							getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID)
								.clientId,
							this.paths,
						);
		const clientSecret =
			this.draft.googleClientSecret.action === "set"
				? this.draft.googleClientSecret.value
				: this.draft.googleClientSecret.action === "delete"
					? null
					: await this.request.secrets.getSecret(
							getGoogleOAuthAppSecretNames(DEFAULT_GOOGLE_OAUTH_APP_ID)
								.clientSecret,
							this.paths,
						);
		if (!clientId || !clientSecret) {
			return null;
		}

		return {
			clientId,
			clientSecret,
		};
	}

	private async getCurrentGoogleCredentials(): Promise<GoogleAuthCredentials | null> {
		const oauthAppCredentials =
			await this.getCurrentGoogleOAuthAppCredentials();
		const refreshToken =
			this.draft.googleRefreshToken.action === "set"
				? this.draft.googleRefreshToken.value
				: this.draft.googleRefreshToken.action === "delete"
					? null
					: await this.request.secrets.getSecret(
							getGoogleConnectionSecretNames(DEFAULT_GOOGLE_CONNECTION_ID)
								.refreshToken,
							this.paths,
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

	private async ensureGoogleScopesForConnector(
		connector: "gmail" | "google-calendar",
	): Promise<boolean> {
		const credentials = await this.getCurrentGoogleCredentials();
		const requiredScopes = await this.getRequiredGoogleScopes(connector);
		if (credentials) {
			try {
				await this.authService.validateGoogleCredentials(
					this.paths,
					credentials,
					requiredScopes,
				);
				return true;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Google account is missing required scopes.";
				setNotice(this.ui, {
					kind: "error",
					text: message,
				});
			}
		} else {
			setNotice(this.ui, {
				kind: "error",
				text: "Google account setup is incomplete. Reconnect to continue.",
			});
		}

		const authRoute = createConnectorAuthRoute(connector, "google-oauth");
		pushRoute(this.ui, authRoute);
		const oauthAppCredentials =
			await this.getCurrentGoogleOAuthAppCredentials();
		if (oauthAppCredentials) {
			authRoute.values.googleClientId = oauthAppCredentials.clientId;
			authRoute.values.googleClientSecret = oauthAppCredentials.clientSecret;
			await this.runGoogleConnectFlow(
				authRoute,
				oauthAppCredentials.clientId,
				oauthAppCredentials.clientSecret,
			);
			if (
				getCurrentRoute(this.ui) !== authRoute ||
				authRoute.stage !== "success"
			) {
				return false;
			}

			popRoute(this.ui);
			this.refreshView();
			return true;
		}

		await this.openOAuthSetupPage(authRoute, () =>
			this.authService.openGoogleOAuthSetup(),
		);
		return false;
	}

	private async refreshGoogleCalendarSelection(
		route: GoogleCalendarSelectionRoute,
	): Promise<void> {
		route.loading = true;
		route.error = null;
		this.refreshView();

		try {
			const credentials = await this.getCurrentGoogleCredentials();
			if (!credentials) {
				throw new Error("Connect a Google account before selecting calendars.");
			}

			if (!this.authService.listGoogleCalendars) {
				throw new Error("Google calendar listing is unavailable.");
			}
			const calendars = await this.authService.listGoogleCalendars(credentials);
			route.calendars = calendars;
			route.selectedCalendarIds = route.selectedCalendarIds.filter((id) =>
				calendars.some((calendar) => calendar.id === id),
			);
			route.loading = false;
			route.error = null;
			this.refreshView();
		} catch (error) {
			route.loading = false;
			route.error =
				error instanceof Error
					? error.message
					: "Failed to load Google calendars.";
			this.refreshView();
		}
	}

	private async runGoogleConnectFlow(
		route: ConnectorAuthRoute,
		clientId: string,
		clientSecret: string,
	): Promise<void> {
		const runId = ++this.activeAuthRun;
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		route.inputValue = "";
		this.refreshView();

		try {
			const requiredScopes = await this.getRequiredGoogleScopes(
				route.connector === "google-calendar" ? "google-calendar" : "gmail",
			);
			const session = await this.authService.startGoogleSession(
				clientId,
				clientSecret,
				requiredScopes,
			);
			if (!this.isAuthRouteActive(route, runId)) {
				await session.cancel();
				return;
			}

			this.activeBrowserAuthSession = session;
			route.stage = "waiting-callback";
			route.authUrl = session.authorizationUrl;
			route.browserOpened = session.browserOpened;
			route.browserError = session.browserError ?? null;
			route.selectedIndex = 0;
			this.refreshView();

			const tokenResult = await session.complete(GOOGLE_AUTH_TIMEOUT_MS);
			this.activeBrowserAuthSession = null;
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}

			route.stage = "validating";
			this.refreshView();

			const credentials: GoogleAuthCredentials = {
				clientId,
				clientSecret,
				refreshToken: tokenResult.refreshToken,
			};
			await this.authService.validateGoogleCredentials(
				this.paths,
				credentials,
				requiredScopes,
			);
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}

			const saved = await this.persistDraftMutation(
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
			if (!saved || !this.isAuthRouteActive(route, runId)) {
				route.stage = "error";
				route.error =
					this.ui.notice?.kind === "error"
						? this.ui.notice.text
						: "Failed to save Google account credentials.";
				this.refreshView();
				return;
			}

			route.stage = "success";
			route.error = null;
			route.selectedIndex = 0;
			setNotice(this.ui, {
				kind: "success",
				text: "Google account connected.",
			});
			this.refreshView();
		} catch (error) {
			this.activeBrowserAuthSession = null;
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}
			route.stage = "error";
			route.error =
				error instanceof Error
					? error.message
					: "Unknown Google connection failure.";
			route.selectedIndex = 0;
			setNotice(this.ui, {
				kind: "error",
				text: route.error,
			});
			this.refreshView();
		}
	}

	private async runNotionOAuthConnectFlow(
		route: ConnectorAuthRoute,
		clientId: string,
		clientSecret: string,
	): Promise<void> {
		const runId = ++this.activeAuthRun;
		route.stage = "opening-browser";
		route.error = null;
		route.selectedIndex = 0;
		route.inputValue = "";
		this.refreshView();

		try {
			const session = await this.authService.startNotionOAuthSession(
				clientId,
				clientSecret,
			);
			if (!this.isAuthRouteActive(route, runId)) {
				await session.cancel();
				return;
			}

			this.activeBrowserAuthSession = session;
			route.stage = "waiting-callback";
			route.authUrl = session.authorizationUrl;
			route.browserOpened = session.browserOpened;
			route.browserError = session.browserError ?? null;
			route.selectedIndex = 0;
			this.refreshView();

			const tokenResult = await session.complete(GOOGLE_AUTH_TIMEOUT_MS);
			this.activeBrowserAuthSession = null;
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}

			route.stage = "validating";
			this.refreshView();

			await this.authService.validateNotionOAuthAccessToken(
				this.paths,
				tokenResult.accessToken,
			);
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}

			const saved = await this.persistDraftMutation(
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
			if (!saved || !this.isAuthRouteActive(route, runId)) {
				route.stage = "error";
				route.error =
					this.ui.notice?.kind === "error"
						? this.ui.notice.text
						: "Failed to save Notion OAuth credentials.";
				this.refreshView();
				return;
			}

			route.stage = "success";
			route.error = null;
			route.selectedIndex = 0;
			setNotice(this.ui, {
				kind: "success",
				text: "Notion OAuth account connected.",
			});
			this.refreshView();
		} catch (error) {
			this.activeBrowserAuthSession = null;
			if (!this.isAuthRouteActive(route, runId)) {
				return;
			}
			route.stage = "error";
			route.error =
				error instanceof Error
					? error.message
					: "Unknown Notion OAuth connection failure.";
			route.selectedIndex = 0;
			setNotice(this.ui, {
				kind: "error",
				text: route.error,
			});
			this.refreshView();
		}
	}

	private async retryAuthFlow(route: ConnectorAuthRoute): Promise<void> {
		route.error = null;
		route.authUrl = undefined;
		route.browserOpened = undefined;
		route.browserError = null;
		route.selectedIndex = 0;
		setNotice(this.ui, null);

		if (route.authMethod === "notion-token") {
			route.stage = "intro";
			this.refreshView();
			return;
		}

		route.stage = "collect-input";
		route.fieldIndex = 0;
		route.inputValue =
			route.authMethod === "notion-oauth"
				? (route.values.notionOauthClientId ?? "")
				: (route.values.googleClientId ?? "");
		this.refreshView();
	}

	private async cancelAuthFlow(): Promise<void> {
		this.activeAuthRun += 1;
		const session = this.activeBrowserAuthSession;
		this.activeBrowserAuthSession = null;
		if (session) {
			await session.cancel().catch(() => {});
		}

		popRoute(this.ui);
		this.refreshView();
	}

	private isAuthRouteActive(route: ConnectorAuthRoute, runId: number): boolean {
		return runId === this.activeAuthRun && getCurrentRoute(this.ui) === route;
	}

	private async refreshDiagnostics(): Promise<void> {
		const route = getCurrentRoute(this.ui);
		if (route.id !== "diagnostics") {
			return;
		}

		route.loading = true;
		setNotice(this.ui, null);
		this.refreshView();

		try {
			const diagnostics = await collectDiagnostics(
				this.request.app,
				this.request.io,
				this.paths,
				this.draft,
			);
			if (getCurrentRoute(this.ui) !== route) {
				return;
			}

			route.loading = false;
			route.title = diagnostics.title;
			route.body = diagnostics.body;
			this.refreshView();
		} catch (error) {
			if (getCurrentRoute(this.ui) !== route) {
				return;
			}

			route.loading = false;
			setNotice(this.ui, {
				kind: "error",
				text:
					error instanceof Error
						? error.message
						: "Unknown diagnostics failure.",
			});
			this.refreshView();
		}
	}

	private async persistOutputDirectory(
		outputDir: string,
		route?: { error: string | null },
	): Promise<boolean> {
		const normalizedOutputDir = normalizeOutputPath(outputDir);
		const validationError =
			await this.validateOutputDirectory(normalizedOutputDir);
		if (validationError) {
			if (route) {
				route.error = validationError;
			}
			setNotice(this.ui, {
				kind: "error",
				text: validationError,
			});
			this.refreshView();
			return false;
		}

		if (route) {
			route.error = null;
		}

		return this.persistDraftMutation(
			(draft) => setOutputDirectory(draft, normalizedOutputDir),
			"Failed to save output directory.",
		);
	}

	private async validateOutputDirectory(
		outputDir: string,
	): Promise<string | null> {
		return validateManagedOutputDirectory(outputDir);
	}

	private async persistDraftMutation(
		mutate: (draft: DraftState) => void,
		failureFallback: string,
	): Promise<boolean> {
		const next = cloneDraftState(this.draft);
		mutate(next);

		try {
			await saveDraft(this.paths, this.request.secrets, next);
			syncDraftState(this.draft, next);
			return true;
		} catch (error) {
			setNotice(this.ui, {
				kind: "error",
				text: error instanceof Error ? error.message : failureFallback,
			});
			this.refreshView();
			return false;
		}
	}

	private async handleBack(): Promise<void> {
		const route = getCurrentRoute(this.ui);
		if (route.id === "home") {
			return;
		}

		if (
			route.id === "syncDashboard" &&
			(route.busy ||
				route.snapshot.watch.active ||
				route.snapshot.integrations.some(
					(integration) =>
						integration.running || integration.queuedImmediateRun,
				))
		) {
			setNotice(this.ui, {
				kind: "error",
				text: "Stop the current sync before leaving the sync dashboard.",
			});
			this.refreshView();
			return;
		}

		if (route.id === "connectorAuth") {
			await this.cancelAuthFlow();
			return;
		}

		popRoute(this.ui);
		this.refreshView();
	}

	private async exitApp(): Promise<void> {
		if (this.activeBrowserAuthSession) {
			await this.activeBrowserAuthSession.cancel().catch(() => {});
			this.activeBrowserAuthSession = null;
		}
		await this.request.session.dispose();
		this.finish(EXIT_CODES.OK);
	}

	private finish(code: number): void {
		if (this.exiting) {
			return;
		}

		this.exiting = true;
		this.renderer.destroy();
		this.exitResolver?.(code);
	}
}
