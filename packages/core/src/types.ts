export const EXIT_CODES = {
	OK: 0,
	GENERAL_ERROR: 1,
	CONFIG_ERROR: 2,
	LOCKED: 3,
	VALIDATION_ERROR: 4,
	SYNC_ERROR: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type SyncIntervalPreset = "5m" | "15m" | "1h" | "6h" | "24h";
export type ProviderId = "google" | "notion";
export type ConnectorId = string;
export type ConnectionKind = string;

export interface BaseSetupMethodDescriptor {
	connectionId?: string;
	connectionKind?: ConnectionKind;
	label?: string;
}

export interface ProviderOAuthSetupMethodDescriptor
	extends BaseSetupMethodDescriptor {
	kind: "provider-oauth";
	providerId: ProviderId;
	requiredScopes: readonly string[];
}

export interface TokenSetupMethodDescriptor extends BaseSetupMethodDescriptor {
	kind: "token";
	secretName?(connectionId: string): string;
}

export interface LocalSetupMethodDescriptor extends BaseSetupMethodDescriptor {
	kind: "local";
}

export type ConnectorConfigFieldType =
	| "boolean"
	| "string"
	| "number"
	| "enum"
	| "string-array"
	| "async-multi-select"
	| "interval";

export interface ConnectorConfigOption {
	value: string;
	label: string;
	description?: string;
}

export interface ConnectorOptionLoaderContext {
	config: SyncdownConfig;
	integration: IntegrationConfig;
	connection: ConnectionConfig;
	io: AppIo;
	paths: AppPaths;
	secrets: SecretsStore;
	resolvedAuth: ResolvedConnectionAuth | null;
}

export type ConnectorOptionLoader = (
	context: ConnectorOptionLoaderContext,
) => Promise<ConnectorConfigOption[]>;

export interface ConnectorConfigFieldDescriptor {
	id: string;
	label: string;
	type: ConnectorConfigFieldType;
	description?: string;
	options?: readonly ConnectorConfigOption[];
	loadOptions?: ConnectorOptionLoader;
}

export type SetupMethodDescriptor =
	| ProviderOAuthSetupMethodDescriptor
	| TokenSetupMethodDescriptor
	| LocalSetupMethodDescriptor;

export interface OAuthAppConfig {
	id: string;
	providerId: ProviderId;
	label: string;
}

export interface BaseConnectionConfig {
	id: string;
	kind: ConnectionKind;
	label: string;
}

export interface GoogleAccountConnectionConfig extends BaseConnectionConfig {
	kind: "google-account";
	oauthAppId: string;
	accountEmail?: string;
}

export interface NotionTokenConnectionConfig extends BaseConnectionConfig {
	kind: "notion-token";
	workspaceName?: string;
}

export interface NotionOAuthConnectionConfig extends BaseConnectionConfig {
	kind: "notion-oauth-account";
	oauthAppId: string;
	workspaceId?: string;
	workspaceName?: string;
	botId?: string;
	ownerUserId?: string;
	ownerUserName?: string;
}

export interface AppleNotesLocalConnectionConfig extends BaseConnectionConfig {
	kind: "apple-notes-local";
}

export interface GenericConnectionConfig extends BaseConnectionConfig {
	metadata?: Record<string, unknown>;
}

export type ConnectionConfig =
	| GoogleAccountConnectionConfig
	| NotionTokenConnectionConfig
	| NotionOAuthConnectionConfig
	| AppleNotesLocalConnectionConfig;

export type GmailSyncFilter = "primary" | "primary-important";

export interface GmailIntegrationSettings {
	fetchConcurrency?: number;
	syncFilter?: GmailSyncFilter;
}

export interface CalendarIntegrationSettings {
	selectedCalendarIds: string[];
}

export type NotionIntegrationSettings = Record<string, never>;
export type AppleNotesIntegrationSettings = Record<string, never>;

export interface BaseIntegrationConfig<TConnectorId extends string, TSettings> {
	id: string;
	connectorId: TConnectorId;
	connectionId: string;
	label: string;
	enabled: boolean;
	interval: SyncIntervalPreset;
	config: TSettings;
}

export type NotionIntegrationConfig = BaseIntegrationConfig<
	"notion",
	NotionIntegrationSettings
>;
export type GmailIntegrationConfig = BaseIntegrationConfig<
	"gmail",
	GmailIntegrationSettings
>;
export type CalendarIntegrationConfig = BaseIntegrationConfig<
	"google-calendar",
	CalendarIntegrationSettings
>;
export type AppleNotesIntegrationConfig = BaseIntegrationConfig<
	"apple-notes",
	AppleNotesIntegrationSettings
>;
export interface GenericIntegrationConfig
	extends BaseIntegrationConfig<string, Record<string, unknown>> {}

export type IntegrationConfig =
	| NotionIntegrationConfig
	| GmailIntegrationConfig
	| CalendarIntegrationConfig
	| AppleNotesIntegrationConfig;

export interface SyncdownConfig {
	outputDir?: string;
	oauthApps: OAuthAppConfig[];
	connections: ConnectionConfig[];
	integrations: IntegrationConfig[];
}

export interface AppPaths {
	configDir: string;
	dataDir: string;
	configPath: string;
	statePath: string;
	secretsPath: string;
	masterKeyPath: string;
	lockPath: string;
}

export interface AppIo {
	write(line: string): void;
	error(line: string): void;
}

export interface HealthCheck {
	status: "ok" | "warn" | "error";
	message: string;
}

export interface DocumentPathHint {
	kind: "page" | "database" | "message" | "calendar-event" | "note";
	databaseName?: string;
	gmailAccountEmail?: string;
	calendarName?: string;
	appleNotesAccount?: string;
	appleNotesFolder?: string;
	appleNotesFolderPath?: string[];
}

export interface SourceMetadata extends Record<string, unknown> {
	sourceUrl?: string;
	createdAt?: string;
	updatedAt?: string;
	archived?: boolean;
	notionParentType?: "page" | "database" | "workspace";
	notionDatabase?: string;
	notionProperties?: Record<string, unknown>;
	gmailThreadId?: string;
	gmailLabelIds?: string[];
	gmailAccountEmail?: string;
	gmailFrom?: string;
	gmailTo?: string[];
	gmailCc?: string[];
	gmailSnippet?: string;
	calendarId?: string;
	calendarName?: string;
	calendarEventId?: string;
	calendarEventStatus?: string;
	calendarStartAt?: string;
	calendarEndAt?: string;
	calendarAllDay?: boolean;
	calendarLocation?: string;
	calendarOrganizer?: string;
	calendarAttendees?: string[];
	calendarRecurrence?: string[];
	appleNotesNoteId?: string;
	appleNotesFolder?: string;
	appleNotesFolderPath?: string[];
}

export interface SourceSnapshot {
	integrationId: string;
	connectorId: string;
	sourceId: string;
	entityType: string;
	title: string;
	slug: string;
	pathHint: DocumentPathHint;
	metadata: SourceMetadata;
	bodyMd: string;
	sourceHash: string;
	snapshotSchemaVersion: string;
}

export interface RenderedDocument {
	sourceId: string;
	title: string;
	relativePath: string;
	contents: string;
	sourceHash: string;
}

export interface SourceRecord {
	integrationId: string;
	connectorId: string;
	sourceId: string;
	entityType: string;
	relativePath: string;
	sourceHash: string;
	renderVersion: string;
	snapshotHash: string;
	sourceUpdatedAt?: string;
	lastRenderedAt?: string;
}

export interface StoredSourceSnapshot {
	integrationId: string;
	connectorId: string;
	sourceId: string;
	snapshotHash: string;
	snapshotSchemaVersion: string;
	payload: SourceSnapshot;
}

export interface GoogleResolvedAuth {
	kind: "google-oauth";
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	requiredScopes: readonly string[];
}

export interface NotionResolvedAuth {
	kind: "notion-token";
	token: string;
}

export interface GenericTokenResolvedAuth {
	kind: "token";
	token: string;
	connectionKind: ConnectionKind;
}

export interface NotionOAuthResolvedAuth {
	kind: "notion-oauth";
	accessToken: string;
	workspaceId?: string;
	workspaceName?: string;
	botId?: string;
	ownerUserId?: string;
	ownerUserName?: string;
}

export type ResolvedConnectionAuth =
	| GoogleResolvedAuth
	| GenericTokenResolvedAuth
	| NotionResolvedAuth
	| NotionOAuthResolvedAuth;

export interface ConnectorSyncRequest {
	config: SyncdownConfig;
	integration: IntegrationConfig;
	connection: ConnectionConfig;
	io: AppIo;
	paths: AppPaths;
	since: string | null;
	renderVersion: string;
	secrets: SecretsStore;
	state: StateStore;
	resolvedAuth: ResolvedConnectionAuth | null;
	throwIfCancelled(): void;
	persistSource(source: SourceSnapshot): Promise<void>;
	deleteSource(sourceId: string): Promise<void>;
	resetIntegrationState(): Promise<void>;
	setProgress(progress: IntegrationRuntimeProgress | null): void;
}

export interface ConnectorSyncResult {
	nextCursor: string | null;
}

export interface Connector {
	id: ConnectorId;
	label: string;
	setupMethods: readonly SetupMethodDescriptor[];
	validate(request: ConnectorSyncRequest): Promise<HealthCheck>;
	sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult>;
}

export interface ConnectorRenderHooks {
	version: string;
	buildRelativePath?(source: SourceSnapshot): string;
	extendFrontmatter?(source: SourceSnapshot): Map<string, unknown>;
}

export interface ConnectorCliAliasContext {
	config: SyncdownConfig;
	io: AppIo;
	paths: AppPaths;
	secrets: SecretsStore;
}

export interface ConnectorCliAlias {
	key: string;
	secret?: boolean;
	setValue(
		context: ConnectorCliAliasContext,
		rawValue: string,
	): Promise<string>;
	unsetValue?(context: ConnectorCliAliasContext): Promise<string>;
}

export interface ConnectorManifest {
	id: ConnectorId;
	label: string;
	setupMethods: readonly SetupMethodDescriptor[];
	supportedPlatforms?: readonly NodeJS.Platform[];
	configFields?: readonly ConnectorConfigFieldDescriptor[];
	cliAliases?: readonly ConnectorCliAlias[];
}

export interface ConnectorPlugin extends Connector {
	manifest: ConnectorManifest;
	render: ConnectorRenderHooks;
	seedOAuthApps?(): OAuthAppConfig[];
	seedConnections?(): ConnectionConfig[];
	seedIntegrations?(): IntegrationConfig[];
	normalizeConnection?(entry: Partial<ConnectionConfig>): ConnectionConfig[];
	normalizeIntegration?(entry: Partial<IntegrationConfig>): IntegrationConfig[];
}

export interface MarkdownRenderer {
	getVersion(plugin: ConnectorPlugin): string;
	render(source: SourceSnapshot, plugin: ConnectorPlugin): RenderedDocument;
}

export interface SinkWriteRequest {
	outputDir: string;
	document: RenderedDocument;
}

export interface SinkWriteResult {
	absolutePath: string;
	action: "created" | "updated" | "unchanged";
}

export interface DocumentSink {
	write(request: SinkWriteRequest): Promise<SinkWriteResult>;
	delete(outputDir: string, relativePath: string): Promise<void>;
}

export interface StateStore {
	getCursor(integrationId: string): Promise<string | null>;
	setCursor(integrationId: string, cursor: string | null): Promise<void>;
	getLastSyncAt(integrationId: string): Promise<string | null>;
	setLastSyncAt(integrationId: string, value: string): Promise<void>;
	resetIntegration(integrationId: string): Promise<SourceRecord[]>;
	getSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<SourceRecord | null>;
	listSourceRecords(integrationId: string): Promise<SourceRecord[]>;
	upsertSourceRecord(record: SourceRecord): Promise<void>;
	deleteSourceRecord(integrationId: string, sourceId: string): Promise<void>;
	getSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<StoredSourceSnapshot | null>;
	upsertSourceSnapshot(snapshot: StoredSourceSnapshot): Promise<void>;
	deleteSourceSnapshot(integrationId: string, sourceId: string): Promise<void>;
	describe(): Promise<string[]>;
	dispose?(): Promise<void>;
}

export interface SecretsStore {
	hasSecret(name: string, paths: AppPaths): Promise<boolean>;
	getSecret(name: string, paths: AppPaths): Promise<string | null>;
	setSecret(name: string, value: string, paths: AppPaths): Promise<void>;
	deleteSecret(name: string, paths: AppPaths): Promise<void>;
	describe(paths: AppPaths): string;
}

export interface ConnectorDefinitionSummary {
	id: ConnectorId;
	label: string;
	setupMethods: readonly SetupMethodDescriptor[];
}

export interface ConnectionSummary {
	id: string;
	kind: ConnectionKind;
	label: string;
}

export interface IntegrationSummary {
	id: string;
	connectorId: ConnectorId;
	connectionId: string;
	label: string;
	setupMethods: readonly SetupMethodDescriptor[];
	enabled: boolean;
	interval: SyncIntervalPreset;
	lastSyncAt: string | null;
}

export interface AppSnapshot {
	paths: AppPaths;
	config: SyncdownConfig;
	connectors: ConnectorDefinitionSummary[];
	connections: ConnectionSummary[];
	integrations: IntegrationSummary[];
}

export interface RunOptions {
	watch?: boolean;
	watchInterval?: SyncIntervalPreset;
	target?: SyncRunTarget;
	resetState?: boolean;
}

export interface RunNowOptions {
	resetState?: boolean;
}

export type SyncRunTarget =
	| { kind: "all" }
	| { kind: "connector"; connectorId: ConnectorId }
	| { kind: "integration"; integrationId: string };

export type WatchStrategy =
	| { kind: "global"; interval: SyncIntervalPreset }
	| { kind: "per-integration" };

export type SyncLogLevel = "info" | "error";

export interface SyncLogEntry {
	timestamp: string;
	level: SyncLogLevel;
	message: string;
	connectorId?: string;
	integrationId?: string;
	integrationLabel?: string;
}

export type IntegrationRuntimeStatus = "idle" | "running" | "success" | "error";

export interface IntegrationRuntimeProgress {
	mode: "determinate" | "indeterminate";
	phase: string;
	detail: string | null;
	completed: number | null;
	total: number | null;
	unit: "pages" | "messages" | "items" | "events";
}

export interface IntegrationRuntimeSnapshot {
	id: string;
	connectorId: ConnectorId;
	connectionId: string;
	label: string;
	enabled: boolean;
	interval: SyncIntervalPreset;
	status: IntegrationRuntimeStatus;
	running: boolean;
	queuedImmediateRun: boolean;
	lastStartedAt: string | null;
	lastFinishedAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
	lastDocumentsWritten: number;
	nextRunAt: string | null;
	progress: IntegrationRuntimeProgress | null;
}

export type SyncRuntimeStatus = "idle" | "running" | "watching";

export interface SyncRuntimeSnapshot {
	status: SyncRuntimeStatus;
	watch: {
		active: boolean;
		strategy: WatchStrategy | null;
		startedAt: string | null;
	};
	lastRunTarget: SyncRunTarget | null;
	lastRunStartedAt: string | null;
	lastRunFinishedAt: string | null;
	lastRunExitCode: ExitCode | null;
	lastRunError: string | null;
	integrations: IntegrationRuntimeSnapshot[];
	logs: SyncLogEntry[];
}

export interface SyncRuntimeEvent {
	type: "snapshot";
	snapshot: SyncRuntimeSnapshot;
}

export interface UpdateStatus {
	currentVersion: string;
	latestVersion: string | null;
	hasUpdate: boolean;
	canSelfUpdate: boolean;
	reason: string | null;
	checkedAt: string;
}

export interface ApplyUpdateResult {
	applied: boolean;
	version: string | null;
	message: string;
}

export interface SelfUpdater {
	getCurrentVersion(): string;
	supportsSelfUpdate(): boolean;
	checkForUpdate(): Promise<UpdateStatus>;
	applyUpdate(): Promise<ApplyUpdateResult>;
}

export interface SyncSession {
	getSnapshot(): SyncRuntimeSnapshot;
	subscribe(listener: (event: SyncRuntimeEvent) => void): () => void;
	runNow(target: SyncRunTarget, options?: RunNowOptions): Promise<void>;
	startWatch(strategy: WatchStrategy): Promise<void>;
	stopWatch(): Promise<void>;
	cancelActiveRun(): Promise<void>;
	dispose(): Promise<void>;
}

export interface SyncdownServices {
	plugins?: ConnectorPlugin[];
	connectors?: Connector[];
	renderer: MarkdownRenderer;
	sink: DocumentSink;
	state: StateStore;
	secrets: SecretsStore;
}

export interface SyncdownApp {
	inspect(): Promise<AppSnapshot>;
	openSession(io?: AppIo): Promise<SyncSession>;
	run(io?: AppIo, options?: RunOptions): Promise<number>;
	reset(io?: AppIo): Promise<number>;
	listConnectors(io?: AppIo): Promise<number>;
	doctor(io?: AppIo): Promise<number>;
}
