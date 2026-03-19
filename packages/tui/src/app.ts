import * as OpenTui from "@opentui/core";
import type { AppPaths, SyncRuntimeEvent, UpdateStatus } from "@syncdown/core";
import { EXIT_CODES, validateManagedOutputDirectory } from "@syncdown/core";
import type {
	GoogleAuthSession,
	NotionOAuthSession,
	TuiAuthService,
} from "./auth.js";
import { createTuiAuthService } from "./auth.js";
import { createConfigAuthController } from "./config-auth-controller.js";
import { createConfigRouteActions } from "./config-route-actions.js";
import { createConfigRuntimeController } from "./config-runtime-controller.js";
import type { ConfigTuiRequest } from "./index.js";
import type { DraftState } from "./state.js";
import {
	cloneDraftState,
	normalizeOutputPath,
	saveDraft,
	setOutputDirectory,
	syncDraftState,
} from "./state.js";
import type {
	ConfigUiState,
	ConnectorAuthRoute,
	HomeRoute,
	SyncDashboardRoute,
	UpdateRoute,
} from "./view-state.js";
import {
	clampRouteSelection,
	createConfigUiState,
	getBreadcrumb,
	getCurrentRoute,
	getInputProps,
	getKeyHint,
	getRouteBody,
	getRouteOptions,
	isInputRoute,
	popRoute,
	setNotice,
} from "./view-state.js";

const SECRET_MASK = "•";
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

export class ConfigTuiApp {
	private readonly renderer: CliRenderer;
	private readonly request: ConfigTuiRequest;
	private readonly updater: NonNullable<ConfigTuiRequest["updater"]>;
	private readonly paths: AppPaths;
	private readonly draft: DraftState;
	private readonly authService: TuiAuthService;
	private readonly ui: ConfigUiState;
	private readonly authController: ReturnType<
		typeof createConfigAuthController
	>;
	private readonly routeActions: ReturnType<typeof createConfigRouteActions>;
	private readonly runtimeController: ReturnType<
		typeof createConfigRuntimeController
	>;
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
		this.authController = createConfigAuthController({
			ui: this.ui,
			draft: this.draft,
			paths: this.paths,
			authService: this.authService,
			refreshView: () => this.refreshView(),
			persistDraftMutation: (mutate, failureFallback) =>
				this.persistDraftMutation(mutate, failureFallback),
			inspectApp: () => this.request.app.inspect(),
			getSecret: (name) => this.request.secrets.getSecret(name, this.paths),
			getActiveAuthRun: () => this.activeAuthRun,
			incrementActiveAuthRun: () => ++this.activeAuthRun,
			getActiveBrowserAuthSession: () => this.activeBrowserAuthSession,
			setActiveBrowserAuthSession: (session) => {
				this.activeBrowserAuthSession = session;
			},
		});
		this.runtimeController = createConfigRuntimeController({
			ui: this.ui,
			draft: this.draft,
			paths: this.paths,
			request: this.request,
			updater: this.updater,
			refreshView: () => this.refreshView(),
			runUpdateCheck: (showNoticeOnFailure) =>
				this.runUpdateCheck(showNoticeOnFailure),
			finish: (code) => this.finish(code),
			cancelAuthFlow: () => this.authController.cancelAuthFlow(),
		});
		this.routeActions = createConfigRouteActions({
			ui: this.ui,
			draft: this.draft,
			getSyncSnapshot: () => this.request.session.getSnapshot(),
			refreshView: () => this.refreshView(),
			ensureGoogleScopesForConnector: (connector) =>
				this.authController.ensureGoogleScopesForConnector(connector),
			persistDraftMutation: (mutate, failureFallback) =>
				this.persistDraftMutation(mutate, failureFallback),
			persistOutputDirectory: (outputDir) =>
				this.persistOutputDirectory(outputDir),
			refreshGoogleCalendarSelection: (route) =>
				this.authController.refreshGoogleCalendarSelection(route),
		});

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

		switch (route.id) {
			case "home":
				this.routeActions.handleHomeSelection(route, selection);
				return;
			case "syncDashboard":
				await this.activateSyncDashboardSelection(route, selection);
				return;
			case "connectors":
				this.routeActions.handleConnectorsSelection(route, selection);
				return;
			case "connectorDetails":
				await this.routeActions.handleConnectorDetailsSelection(
					route,
					selection,
				);
				return;
			case "connectorAuth":
				await this.activateAuthSelection(route, selection);
				return;
			case "confirmDisconnect":
				await this.routeActions.handleConfirmDisconnectSelection(
					route,
					selection,
				);
				return;
			case "output":
				await this.routeActions.handleOutputSelection(route, selection);
				return;
			case "outputCustom":
				return;
			case "schedule":
				this.routeActions.handleScheduleSelection(route, selection);
				return;
			case "interval":
				await this.routeActions.handleIntervalSelection(route, selection);
				return;
			case "gmailFilter":
				await this.routeActions.handleGmailFilterSelection(route, selection);
				return;
			case "googleCalendarSelection":
				await this.routeActions.handleGoogleCalendarSelection(route, selection);
				return;
			case "advanced":
				await this.runtimeController.handleAdvancedSelection(selection);
				return;
			case "confirmReset":
				await this.runtimeController.handleConfirmResetSelection(selection);
				return;
			case "update":
				await this.runtimeController.activateUpdateSelection(route, selection);
				return;
			case "diagnostics":
				await this.runtimeController.handleDiagnosticsSelection(selection);
				return;
			default: {
				const exhaustiveRoute: never = route;
				return exhaustiveRoute;
			}
		}
	}

	private async activateSyncDashboardSelection(
		route: SyncDashboardRoute,
		selection: unknown,
	): Promise<void> {
		await this.runtimeController.activateSyncDashboardSelection(
			route,
			selection,
		);
	}

	private async activateAuthSelection(
		route: ConnectorAuthRoute,
		selection: unknown,
	): Promise<void> {
		await this.authController.activateAuthSelection(route, selection);
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
		await this.authController.submitConnectorAuthInput(route);
	}

	private async retryAuthFlow(route: ConnectorAuthRoute): Promise<void> {
		await this.authController.retryAuthFlow(route);
	}

	private async cancelAuthFlow(): Promise<void> {
		await this.authController.cancelAuthFlow();
	}

	private async refreshDiagnostics(): Promise<void> {
		await this.runtimeController.refreshDiagnostics();
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
		await this.runtimeController.handleBack();
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
