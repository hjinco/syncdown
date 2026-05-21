import { randomUUID } from "node:crypto";

import type {
	Connector,
	ConnectorPlugin,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	ContactsIntegrationConfig,
	GoogleAccessTokenProvider,
	GoogleOAuthCredentials,
	HealthCheck,
	IntegrationConfig,
	SourceSnapshot,
} from "@syncdown/core";
import {
	assertGoogleGrantedScopes,
	createGoogleAccessTokenProvider,
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	defineConnectorPlugin,
	stableStringify,
} from "@syncdown/core";

const GOOGLE_PEOPLE_API_BASE_URL = "https://people.googleapis.com/v1/";

export const GOOGLE_CONTACTS_REQUIRED_SCOPES = [
	"https://www.googleapis.com/auth/contacts.readonly",
] as const;

const PERSON_FIELDS = [
	"names",
	"nicknames",
	"emailAddresses",
	"phoneNumbers",
	"addresses",
	"organizations",
	"birthdays",
	"urls",
	"memberships",
	"biographies",
	"userDefined",
	"events",
	"imClients",
	"relations",
	"metadata",
].join(",");

const CURSOR_VERSION = 1;

type ContactsCredentials = GoogleOAuthCredentials;

interface GooglePersonName {
	displayName?: string;
	displayNameLastFirst?: string;
	unstructuredName?: string;
	familyName?: string;
	givenName?: string;
	middleName?: string;
	honorificPrefix?: string;
	honorificSuffix?: string;
}

interface GooglePersonField<T> {
	metadata?: { primary?: boolean; source?: { type?: string; id?: string } };
	type?: string;
	formattedType?: string;
	value?: T;
}

interface GoogleEmailAddress extends GooglePersonField<string> {
	displayName?: string;
}

interface GooglePhoneNumber extends GooglePersonField<string> {
	canonicalForm?: string;
}

interface GoogleAddress {
	metadata?: { primary?: boolean };
	type?: string;
	formattedValue?: string;
	streetAddress?: string;
	extendedAddress?: string;
	city?: string;
	region?: string;
	postalCode?: string;
	country?: string;
	countryCode?: string;
}

interface GoogleOrganization {
	metadata?: { primary?: boolean };
	type?: string;
	name?: string;
	title?: string;
	department?: string;
	startDate?: { year?: number; month?: number; day?: number };
	endDate?: { year?: number; month?: number; day?: number };
	current?: boolean;
}

interface GoogleBirthday {
	date?: { year?: number; month?: number; day?: number };
	text?: string;
}

interface GoogleUrl extends GooglePersonField<string> {}

interface GoogleNickname {
	value?: string;
	type?: string;
}

interface GoogleMembership {
	contactGroupMembership?: {
		contactGroupId?: string;
		contactGroupResourceName?: string;
	};
}

interface GoogleBiography {
	value?: string;
	contentType?: "TEXT_PLAIN" | "TEXT_HTML";
}

interface GoogleUserDefined {
	key?: string;
	value?: string;
}

interface GoogleEvent {
	date?: { year?: number; month?: number; day?: number };
	type?: string;
	formattedType?: string;
}

interface GoogleImClient extends GooglePersonField<string> {
	protocol?: string;
	formattedProtocol?: string;
}

interface GoogleRelation {
	person?: string;
	type?: string;
	formattedType?: string;
}

interface GooglePersonMetadata {
	deleted?: boolean;
	sources?: Array<{
		type?: string;
		id?: string;
		etag?: string;
		updateTime?: string;
	}>;
}

export interface GooglePerson {
	resourceName?: string;
	etag?: string;
	metadata?: GooglePersonMetadata;
	names?: GooglePersonName[];
	nicknames?: GoogleNickname[];
	emailAddresses?: GoogleEmailAddress[];
	phoneNumbers?: GooglePhoneNumber[];
	addresses?: GoogleAddress[];
	organizations?: GoogleOrganization[];
	birthdays?: GoogleBirthday[];
	urls?: GoogleUrl[];
	memberships?: GoogleMembership[];
	biographies?: GoogleBiography[];
	userDefined?: GoogleUserDefined[];
	events?: GoogleEvent[];
	imClients?: GoogleImClient[];
	relations?: GoogleRelation[];
}

export interface GoogleContactsPage {
	connections: GooglePerson[];
	nextPageToken?: string | null;
	nextSyncToken?: string | null;
	invalidSyncToken?: boolean;
}

export interface GoogleContactGroup {
	resourceName: string;
	name: string;
	groupType?: string;
	formattedName?: string;
}

export interface GoogleContactsAdapter {
	listConnections(
		credentials: ContactsCredentials,
		options: { pageToken?: string; syncToken?: string },
	): Promise<GoogleContactsPage>;
	listContactGroups(
		credentials: ContactsCredentials,
	): Promise<GoogleContactGroup[]>;
	getOwnerEmail(credentials: ContactsCredentials): Promise<string | null>;
}

interface PeopleApiConnectionsResponse {
	connections?: GooglePerson[];
	nextPageToken?: string | null;
	nextSyncToken?: string | null;
	totalPeople?: number;
	error?: {
		code?: number;
		message?: string;
		errors?: Array<{ reason?: string; message?: string }>;
	};
}

interface PeopleApiContactGroupsResponse {
	contactGroups?: Array<{
		resourceName?: string;
		name?: string;
		formattedName?: string;
		groupType?: string;
	}>;
}

interface PeopleApiSelfResponse {
	emailAddresses?: Array<{
		value?: string;
		metadata?: { primary?: boolean; source?: { type?: string } };
	}>;
}

class GoogleContactsApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly reasons: string[] = [],
	) {
		super(message);
		this.name = "GoogleContactsApiError";
	}
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
	const text = await response.text();
	if (!text) {
		return null;
	}
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new GoogleContactsApiError(
			response.status,
			`Google People API response was not valid JSON: ${reason}`,
		);
	}
}

class OfficialGoogleContactsAdapter implements GoogleContactsAdapter {
	constructor(
		private readonly accessTokenProvider: GoogleAccessTokenProvider = createGoogleAccessTokenProvider(),
	) {}

	private async getAccessToken(
		credentials: ContactsCredentials,
	): Promise<string> {
		return this.accessTokenProvider.getAccessToken(credentials);
	}

	private async request<T>(
		credentials: ContactsCredentials,
		path: string,
		params: Record<string, string | number | boolean | undefined> = {},
	): Promise<T> {
		const url = new URL(path, GOOGLE_PEOPLE_API_BASE_URL);
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) {
				continue;
			}
			url.searchParams.set(key, String(value));
		}

		const response = await fetch(url, {
			headers: {
				authorization: `Bearer ${await this.getAccessToken(credentials)}`,
				accept: "application/json",
			},
		});
		const payload = await parseJsonResponse<T & PeopleApiConnectionsResponse>(
			response,
		);
		if (!response.ok) {
			const errorPayload = payload as PeopleApiConnectionsResponse | null;
			const reasons =
				errorPayload?.error?.errors
					?.map((entry) => entry.reason)
					.filter((value): value is string => Boolean(value)) ?? [];
			throw new GoogleContactsApiError(
				response.status,
				errorPayload?.error?.message ??
					`Google People API request failed: HTTP ${response.status}`,
				reasons,
			);
		}

		return (payload ?? {}) as T;
	}

	async listConnections(
		credentials: ContactsCredentials,
		options: { pageToken?: string; syncToken?: string },
	): Promise<GoogleContactsPage> {
		try {
			const response = await this.request<PeopleApiConnectionsResponse>(
				credentials,
				"people/me/connections",
				{
					personFields: PERSON_FIELDS,
					pageSize: 1000,
					pageToken: options.pageToken,
					syncToken: options.syncToken,
					requestSyncToken: true,
				},
			);

			return {
				connections: response.connections ?? [],
				nextPageToken: response.nextPageToken ?? undefined,
				nextSyncToken: response.nextSyncToken ?? undefined,
			};
		} catch (error) {
			if (
				error instanceof GoogleContactsApiError &&
				(error.status === 410 || error.reasons.includes("EXPIRED_SYNC_TOKEN"))
			) {
				return { connections: [], invalidSyncToken: true };
			}
			throw error;
		}
	}

	async listContactGroups(
		credentials: ContactsCredentials,
	): Promise<GoogleContactGroup[]> {
		const response = await this.request<PeopleApiContactGroupsResponse>(
			credentials,
			"contactGroups",
			{ pageSize: 200 },
		);
		const groups: GoogleContactGroup[] = [];
		for (const entry of response.contactGroups ?? []) {
			if (!entry.resourceName || !entry.name) {
				continue;
			}
			groups.push({
				resourceName: entry.resourceName,
				name: entry.formattedName ?? entry.name,
				groupType: entry.groupType,
			});
		}
		return groups;
	}

	async getOwnerEmail(
		credentials: ContactsCredentials,
	): Promise<string | null> {
		const response = await this.request<PeopleApiSelfResponse>(
			credentials,
			"people/me",
			{ personFields: "emailAddresses" },
		);
		const emails = response.emailAddresses ?? [];
		const primary = emails.find(
			(entry) =>
				entry.metadata?.primary &&
				entry.metadata?.source?.type === "ACCOUNT" &&
				typeof entry.value === "string",
		);
		const fallback = emails.find((entry) => typeof entry.value === "string");
		return primary?.value ?? fallback?.value ?? null;
	}
}

export function createGoogleContactsAdapter(): GoogleContactsAdapter {
	return new OfficialGoogleContactsAdapter();
}

function slugifySegment(input: string): string {
	return (
		input
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "untitled"
	);
}

function computeSourceHash(
	snapshot: Omit<SourceSnapshot, "sourceHash">,
): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			stableStringify({
				connectorId: snapshot.connectorId,
				sourceId: snapshot.sourceId,
				title: snapshot.title,
				entityType: snapshot.entityType,
				pathHint: snapshot.pathHint,
				metadata: snapshot.metadata,
				bodyMd: snapshot.bodyMd,
			}),
		)
		.digest("hex");
}

function formatDateParts(date: {
	year?: number;
	month?: number;
	day?: number;
}): string | null {
	const { year, month, day } = date;
	if (year && month && day) {
		return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
	}
	if (month && day) {
		return `--${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
	}
	if (year) {
		return String(year);
	}
	return null;
}

function pickDisplayName(person: GooglePerson): string {
	const name = person.names?.[0];
	const candidate =
		name?.displayName?.trim() ||
		name?.unstructuredName?.trim() ||
		[name?.givenName, name?.familyName].filter(Boolean).join(" ").trim() ||
		person.emailAddresses?.find((entry) => entry.value)?.value?.trim() ||
		person.phoneNumbers?.find((entry) => entry.value)?.value?.trim() ||
		person.organizations?.find((entry) => entry.name)?.name?.trim();
	return candidate || "(unnamed contact)";
}

function collectEmails(person: GooglePerson): string[] {
	return (person.emailAddresses ?? [])
		.map((entry) => entry.value?.trim())
		.filter((value): value is string => Boolean(value));
}

function collectPhones(person: GooglePerson): string[] {
	return (person.phoneNumbers ?? [])
		.map((entry) => entry.canonicalForm?.trim() || entry.value?.trim())
		.filter((value): value is string => Boolean(value));
}

function collectOrganizations(person: GooglePerson): string[] {
	return (person.organizations ?? [])
		.map((entry) => entry.name?.trim())
		.filter((value): value is string => Boolean(value));
}

function collectTitles(person: GooglePerson): string[] {
	return (person.organizations ?? [])
		.map((entry) => entry.title?.trim())
		.filter((value): value is string => Boolean(value));
}

function collectAddresses(person: GooglePerson): string[] {
	return (person.addresses ?? [])
		.map(
			(entry) =>
				entry.formattedValue?.trim() ||
				[
					entry.streetAddress,
					entry.city,
					entry.region,
					entry.postalCode,
					entry.country,
				]
					.filter(Boolean)
					.join(", "),
		)
		.filter((value): value is string => Boolean(value));
}

function collectUrls(person: GooglePerson): string[] {
	return (person.urls ?? [])
		.map((entry) => entry.value?.trim())
		.filter((value): value is string => Boolean(value));
}

function collectGroups(
	person: GooglePerson,
	groupMap: Map<string, string>,
): string[] {
	const labels = new Set<string>();
	for (const membership of person.memberships ?? []) {
		const resourceName =
			membership.contactGroupMembership?.contactGroupResourceName;
		if (!resourceName) {
			continue;
		}
		labels.add(groupMap.get(resourceName) ?? resourceName);
	}
	return [...labels];
}

function pickBirthday(person: GooglePerson): string | undefined {
	for (const entry of person.birthdays ?? []) {
		if (entry.date) {
			const formatted = formatDateParts(entry.date);
			if (formatted) {
				return formatted;
			}
		}
		if (entry.text) {
			return entry.text;
		}
	}
	return undefined;
}

function pickUpdatedAt(person: GooglePerson): string | undefined {
	for (const source of person.metadata?.sources ?? []) {
		if (source.updateTime) {
			return source.updateTime;
		}
	}
	return undefined;
}

function buildContactBody(person: GooglePerson, groups: string[]): string {
	const sections: string[] = [];

	const emails = collectEmails(person);
	if (emails.length > 0) {
		sections.push(
			["## Emails", ...emails.map((entry) => `- ${entry}`)].join("\n"),
		);
	}

	const phones = collectPhones(person);
	if (phones.length > 0) {
		sections.push(
			["## Phones", ...phones.map((entry) => `- ${entry}`)].join("\n"),
		);
	}

	const orgs = person.organizations ?? [];
	if (orgs.length > 0) {
		const lines = orgs
			.map((entry) =>
				[entry.title, entry.name, entry.department].filter(Boolean).join(" — "),
			)
			.filter(Boolean);
		if (lines.length > 0) {
			sections.push(
				["## Organizations", ...lines.map((entry) => `- ${entry}`)].join("\n"),
			);
		}
	}

	const addresses = collectAddresses(person);
	if (addresses.length > 0) {
		sections.push(
			["## Addresses", ...addresses.map((entry) => `- ${entry}`)].join("\n"),
		);
	}

	const urls = collectUrls(person);
	if (urls.length > 0) {
		sections.push(["## URLs", ...urls.map((entry) => `- ${entry}`)].join("\n"));
	}

	if (groups.length > 0) {
		sections.push(
			["## Groups", ...groups.map((entry) => `- ${entry}`)].join("\n"),
		);
	}

	const events = person.events ?? [];
	if (events.length > 0) {
		const lines = events
			.map((entry) => {
				const date = entry.date ? formatDateParts(entry.date) : null;
				const label = entry.formattedType ?? entry.type ?? "event";
				return date ? `${label}: ${date}` : label;
			})
			.filter(Boolean);
		if (lines.length > 0) {
			sections.push(
				["## Events", ...lines.map((entry) => `- ${entry}`)].join("\n"),
			);
		}
	}

	const userDefined = person.userDefined ?? [];
	if (userDefined.length > 0) {
		const lines = userDefined
			.map((entry) =>
				entry.key && entry.value ? `${entry.key}: ${entry.value}` : null,
			)
			.filter((value): value is string => Boolean(value));
		if (lines.length > 0) {
			sections.push(
				["## Custom", ...lines.map((entry) => `- ${entry}`)].join("\n"),
			);
		}
	}

	const notes = (person.biographies ?? [])
		.map((entry) => entry.value?.trim())
		.filter((value): value is string => Boolean(value));
	if (notes.length > 0) {
		sections.push(["## Notes", ...notes].join("\n\n"));
	}

	return sections.join("\n\n");
}

function toSourceSnapshot(
	integrationId: string,
	person: GooglePerson,
	accountEmail: string | null,
	groupMap: Map<string, string>,
): SourceSnapshot {
	const resourceName = person.resourceName;
	if (!resourceName) {
		throw new Error("Google People API contact missing resourceName");
	}

	const title = pickDisplayName(person);
	const emails = collectEmails(person);
	const phones = collectPhones(person);
	const organizations = collectOrganizations(person);
	const titles = collectTitles(person);
	const addresses = collectAddresses(person);
	const urls = collectUrls(person);
	const groups = collectGroups(person, groupMap);
	const birthday = pickBirthday(person);
	const updatedAt = pickUpdatedAt(person);

	const snapshotBase: Omit<SourceSnapshot, "sourceHash"> = {
		integrationId,
		connectorId: "google-contacts",
		sourceId: resourceName,
		entityType: "contact",
		title,
		slug: slugifySegment(title),
		pathHint: {
			kind: "contact",
			contactAccountEmail: accountEmail ?? undefined,
		},
		metadata: {
			updatedAt,
			contactResourceName: resourceName,
			contactAccountEmail: accountEmail ?? undefined,
			contactEmails: emails.length > 0 ? emails : undefined,
			contactPhones: phones.length > 0 ? phones : undefined,
			contactOrganizations:
				organizations.length > 0 ? organizations : undefined,
			contactTitles: titles.length > 0 ? titles : undefined,
			contactGroups: groups.length > 0 ? groups : undefined,
			contactBirthday: birthday,
			contactAddresses: addresses.length > 0 ? addresses : undefined,
			contactUrls: urls.length > 0 ? urls : undefined,
			contactSource: "person",
		},
		bodyMd: buildContactBody(person, groups),
		snapshotSchemaVersion: "1",
	};

	return {
		...snapshotBase,
		sourceHash: computeSourceHash(snapshotBase),
	};
}

interface StoredGoogleContactsCursor {
	version: 1;
	syncToken: string | null;
	accountEmail: string | null;
}

function decodeCursor(value: string | null): StoredGoogleContactsCursor {
	if (!value) {
		return { version: CURSOR_VERSION, syncToken: null, accountEmail: null };
	}
	try {
		const parsed = JSON.parse(value) as Partial<StoredGoogleContactsCursor>;
		if (parsed.version !== CURSOR_VERSION) {
			throw new Error("legacy");
		}
		return {
			version: CURSOR_VERSION,
			syncToken:
				typeof parsed.syncToken === "string" && parsed.syncToken.length > 0
					? parsed.syncToken
					: null,
			accountEmail:
				typeof parsed.accountEmail === "string" &&
				parsed.accountEmail.length > 0
					? parsed.accountEmail
					: null,
		};
	} catch {
		return { version: CURSOR_VERSION, syncToken: null, accountEmail: null };
	}
}

function encodeCursor(cursor: StoredGoogleContactsCursor): string {
	return JSON.stringify({
		version: CURSOR_VERSION,
		syncToken: cursor.syncToken,
		accountEmail: cursor.accountEmail,
	} satisfies StoredGoogleContactsCursor);
}

async function getCredentials(
	request: ConnectorSyncRequest,
): Promise<ContactsCredentials> {
	if (request.resolvedAuth?.kind !== "google-oauth") {
		throw new Error("Missing Google credentials in encrypted store");
	}
	return {
		clientId: request.resolvedAuth.clientId,
		clientSecret: request.resolvedAuth.clientSecret,
		refreshToken: request.resolvedAuth.refreshToken,
	};
}

function isPersonDeleted(person: GooglePerson): boolean {
	return person.metadata?.deleted === true;
}

async function fullSync(
	request: ConnectorSyncRequest,
	adapter: GoogleContactsAdapter,
	credentials: ContactsCredentials,
	accountEmail: string | null,
	groupMap: Map<string, string>,
): Promise<string | null> {
	let pageToken: string | undefined;
	let nextSyncToken: string | null = null;
	const seenSourceIds = new Set<string>();

	do {
		request.throwIfCancelled();
		const page = await adapter.listConnections(credentials, { pageToken });
		for (const person of page.connections) {
			request.throwIfCancelled();
			if (!person.resourceName) {
				continue;
			}
			seenSourceIds.add(person.resourceName);
			if (isPersonDeleted(person)) {
				await request.deleteSource(person.resourceName);
				continue;
			}
			await request.persistSource(
				toSourceSnapshot(
					request.integration.id,
					person,
					accountEmail,
					groupMap,
				),
			);
		}
		pageToken = page.nextPageToken ?? undefined;
		nextSyncToken = page.nextSyncToken ?? nextSyncToken;
	} while (pageToken);

	const existing = await request.state.listSourceRecords(
		request.integration.id,
	);
	for (const record of existing) {
		if (!seenSourceIds.has(record.sourceId)) {
			await request.deleteSource(record.sourceId);
		}
	}

	return nextSyncToken;
}

async function incrementalSync(
	request: ConnectorSyncRequest,
	adapter: GoogleContactsAdapter,
	credentials: ContactsCredentials,
	accountEmail: string | null,
	groupMap: Map<string, string>,
	syncToken: string,
): Promise<{ nextSyncToken: string | null; invalidSyncToken: boolean }> {
	let pageToken: string | undefined;
	let nextSyncToken: string | null = null;

	do {
		request.throwIfCancelled();
		const page = await adapter.listConnections(credentials, {
			pageToken,
			syncToken,
		});

		if (page.invalidSyncToken) {
			return { nextSyncToken: null, invalidSyncToken: true };
		}

		for (const person of page.connections) {
			request.throwIfCancelled();
			if (!person.resourceName) {
				continue;
			}
			if (isPersonDeleted(person)) {
				await request.deleteSource(person.resourceName);
				continue;
			}
			await request.persistSource(
				toSourceSnapshot(
					request.integration.id,
					person,
					accountEmail,
					groupMap,
				),
			);
		}

		pageToken = page.nextPageToken ?? undefined;
		nextSyncToken = page.nextSyncToken ?? nextSyncToken;
	} while (pageToken);

	return { nextSyncToken, invalidSyncToken: false };
}

export interface CreateGoogleContactsConnectorOptions {
	adapter?: GoogleContactsAdapter;
}

class GoogleContactsConnector implements Connector {
	readonly id = "google-contacts";
	readonly label = "Google Contacts";
	readonly setupMethods = [
		{
			kind: "provider-oauth",
			providerId: "google",
			requiredScopes: GOOGLE_CONTACTS_REQUIRED_SCOPES,
			connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
			connectionKind: "google-account",
			label: "Google OAuth",
		},
	] as const;

	constructor(private readonly adapter: GoogleContactsAdapter) {}

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return { status: "warn", message: "integration disabled" };
		}
		if (request.resolvedAuth?.kind !== "google-oauth") {
			return {
				status: "error",
				message: "credentials missing in encrypted store",
			};
		}
		try {
			const credentials = await getCredentials(request);
			await assertGoogleGrantedScopes(
				fetch,
				credentials,
				GOOGLE_CONTACTS_REQUIRED_SCOPES,
			);
			await this.adapter.getOwnerEmail(credentials);
			return { status: "ok", message: "credentials valid" };
		} catch (error) {
			return {
				status: "error",
				message:
					error instanceof Error ? error.message : "unknown validation error",
			};
		}
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		if (request.integration.connectorId !== "google-contacts") {
			throw new Error(
				`Invalid integration for Google Contacts connector: ${request.integration.connectorId}`,
			);
		}

		const credentials = await getCredentials(request);
		const previousCursor = decodeCursor(request.since);

		const accountEmail =
			(await this.adapter.getOwnerEmail(credentials).catch(() => null)) ??
			previousCursor.accountEmail;

		const groups = await this.adapter
			.listContactGroups(credentials)
			.catch(() => [] as GoogleContactGroup[]);
		const groupMap = new Map<string, string>(
			groups.map((group) => [group.resourceName, group.name]),
		);

		request.setProgress({
			mode: "indeterminate",
			phase: "Syncing Google Contacts",
			detail: accountEmail ?? null,
			completed: null,
			total: null,
			unit: "items",
		});

		let nextSyncToken: string | null = null;
		if (previousCursor.syncToken) {
			const delta = await incrementalSync(
				request,
				this.adapter,
				credentials,
				accountEmail,
				groupMap,
				previousCursor.syncToken,
			);
			if (delta.invalidSyncToken) {
				request.io.write(
					"Google Contacts sync token expired. Rebuilding from scratch.",
				);
				nextSyncToken = await fullSync(
					request,
					this.adapter,
					credentials,
					accountEmail,
					groupMap,
				);
			} else {
				nextSyncToken = delta.nextSyncToken;
			}
		} else {
			nextSyncToken = await fullSync(
				request,
				this.adapter,
				credentials,
				accountEmail,
				groupMap,
			);
		}

		request.setProgress(null);

		return {
			nextCursor: encodeCursor({
				version: CURSOR_VERSION,
				syncToken: nextSyncToken,
				accountEmail,
			}),
		};
	}
}

function normalizeGoogleContactsConnection(
	entry: Partial<{
		id: string;
		kind: string;
		label: string;
		oauthAppId?: string;
		accountEmail?: string;
	}>,
) {
	if (
		entry.kind !== "google-account" ||
		typeof entry.id !== "string" ||
		typeof entry.label !== "string" ||
		typeof entry.oauthAppId !== "string"
	) {
		return [];
	}
	return [
		{
			id: entry.id,
			kind: "google-account" as const,
			label: entry.label,
			oauthAppId: entry.oauthAppId,
			accountEmail:
				typeof entry.accountEmail === "string" ? entry.accountEmail : undefined,
		},
	];
}

function normalizeGoogleContactsIntegration(entry: Partial<IntegrationConfig>) {
	if (
		entry.connectorId !== "google-contacts" ||
		typeof entry.id !== "string" ||
		typeof entry.connectionId !== "string" ||
		typeof entry.label !== "string" ||
		typeof entry.enabled !== "boolean" ||
		(entry.interval !== "5m" &&
			entry.interval !== "15m" &&
			entry.interval !== "1h" &&
			entry.interval !== "6h" &&
			entry.interval !== "24h")
	) {
		return [];
	}
	return [
		{
			id: entry.id,
			connectorId: "google-contacts" as const,
			connectionId: entry.connectionId,
			label: entry.label,
			enabled: entry.enabled,
			interval: entry.interval,
			config: {} as ContactsIntegrationConfig["config"],
		},
	];
}

export function createGoogleContactsConnectorPlugin(
	options: CreateGoogleContactsConnectorOptions = {},
): ConnectorPlugin {
	const runtime = new GoogleContactsConnector(
		options.adapter ?? createGoogleContactsAdapter(),
	);
	const setupMethods = [
		{
			kind: "provider-oauth" as const,
			providerId: "google" as const,
			requiredScopes: [...GOOGLE_CONTACTS_REQUIRED_SCOPES],
			connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
			connectionKind: "google-account",
			label: "Google OAuth",
		},
	];

	return defineConnectorPlugin({
		id: runtime.id,
		label: runtime.label,
		setupMethods,
		validate: runtime.validate.bind(runtime),
		sync: runtime.sync.bind(runtime),
		manifest: {
			id: runtime.id,
			label: runtime.label,
			setupMethods,
			cliAliases: [
				{
					key: "googleContacts.enabled",
					async setValue(context, rawValue) {
						if (rawValue !== "true" && rawValue !== "false") {
							throw new Error(
								"googleContacts.enabled must be `true` or `false`.",
							);
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "google-contacts",
						);
						if (!integration) {
							throw new Error("Missing default Google Contacts integration.");
						}
						integration.enabled = rawValue === "true";
						return `Set googleContacts.enabled=${integration.enabled}`;
					},
				},
				{
					key: "googleContacts.interval",
					async setValue(context, rawValue) {
						if (
							rawValue !== "5m" &&
							rawValue !== "15m" &&
							rawValue !== "1h" &&
							rawValue !== "6h" &&
							rawValue !== "24h"
						) {
							throw new Error(
								"googleContacts.interval must be one of: 5m, 15m, 1h, 6h, 24h",
							);
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "google-contacts",
						);
						if (!integration) {
							throw new Error("Missing default Google Contacts integration.");
						}
						integration.interval = rawValue;
						return `Set googleContacts.interval=${integration.interval}`;
					},
				},
			],
		},
		render: {
			version: "1",
		},
		seedOAuthApps() {
			return [
				{
					id: DEFAULT_GOOGLE_OAUTH_APP_ID,
					providerId: "google",
					label: "Default Google OAuth App",
				},
			];
		},
		seedConnections() {
			return [
				{
					id: DEFAULT_GOOGLE_CONNECTION_ID,
					kind: "google-account",
					label: "Default Google Account",
					oauthAppId: DEFAULT_GOOGLE_OAUTH_APP_ID,
				},
			];
		},
		seedIntegrations() {
			return [
				{
					id: randomUUID(),
					connectorId: "google-contacts",
					connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
					label: "Google Contacts",
					enabled: false,
					interval: "1h",
					config: {},
				},
			];
		},
		normalizeConnection: normalizeGoogleContactsConnection,
		normalizeIntegration: normalizeGoogleContactsIntegration,
	});
}

export function createGoogleContactsConnector(
	options: CreateGoogleContactsConnectorOptions = {},
): Connector {
	return createGoogleContactsConnectorPlugin(options);
}
