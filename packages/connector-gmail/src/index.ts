import type {
	Connector,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	GmailSyncFilter,
	GoogleAccessTokenProvider,
	GoogleOAuthCredentials,
	HealthCheck,
	SourceSnapshot,
} from "@syncdown/core";
import {
	assertGoogleGrantedScopes,
	createGoogleAccessTokenProvider,
} from "@syncdown/core";

const HISTORY_ID_INVALID_REASON = "invalid_history_id";
const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/";
export const GMAIL_REQUIRED_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
] as const;

type GmailCredentials = GoogleOAuthCredentials;
type StoredGmailCursor = { historyId: string; syncFilter: GmailSyncFilter };

export interface GmailHeader {
	name?: string | null;
	value?: string | null;
}

export interface GmailBody {
	data?: string | null;
}

export interface GmailPart {
	mimeType?: string | null;
	filename?: string | null;
	body?: GmailBody | null;
	headers?: GmailHeader[] | null;
	parts?: GmailPart[] | null;
}

export interface GmailMessage {
	id: string;
	threadId?: string | null;
	historyId?: string | null;
	internalDate?: string | null;
	labelIds?: string[] | null;
	snippet?: string | null;
	payload?: GmailPart | null;
}

export interface GmailHistoryRecord {
	messages?: Array<Pick<GmailMessage, "id">> | null;
	messagesAdded?: Array<{ message?: Pick<GmailMessage, "id"> | null }> | null;
	messagesDeleted?: Array<{ message?: Pick<GmailMessage, "id"> | null }> | null;
	labelsAdded?: Array<{ message?: Pick<GmailMessage, "id"> | null }> | null;
	labelsRemoved?: Array<{ message?: Pick<GmailMessage, "id"> | null }> | null;
}

export interface GmailHistoryResult {
	history: GmailHistoryRecord[];
	invalidCursor?: boolean;
}

export interface GmailProfile {
	historyId: string | null;
	emailAddress?: string;
}

export interface GmailAdapter {
	validate(credentials: GmailCredentials): Promise<void>;
	getProfile(credentials: GmailCredentials): Promise<GmailProfile>;
	iterateInboxMessageIds?(
		credentials: GmailCredentials,
		syncFilter: GmailSyncFilter,
	): AsyncIterable<string>;
	listInboxMessageIds(
		credentials: GmailCredentials,
		syncFilter: GmailSyncFilter,
	): Promise<string[]>;
	listHistory(
		credentials: GmailCredentials,
		startHistoryId: string,
	): Promise<GmailHistoryResult>;
	getMessage(
		credentials: GmailCredentials,
		messageId: string,
	): Promise<GmailMessage | null>;
}

interface GmailProfileResponse {
	historyId?: string | null;
	emailAddress?: string | null;
}

interface GmailListMessagesResponse {
	messages?: Array<{ id?: string | null }> | null;
	nextPageToken?: string | null;
}

interface GmailListHistoryResponse {
	history?: GmailHistoryRecord[] | null;
	nextPageToken?: string | null;
}

interface GmailApiErrorResponse {
	error?: {
		code?: number;
		message?: string;
		errors?: Array<{ reason?: string; message?: string }>;
	};
}

class GmailApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly reasons: string[] = [],
	) {
		super(message);
		this.name = "GmailApiError";
	}
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
	const text = await response.text();
	if (!text) {
		return null;
	}

	return JSON.parse(text) as T;
}

class OfficialGmailAdapter implements GmailAdapter {
	constructor(
		private readonly accessTokenProvider: GoogleAccessTokenProvider = createGoogleAccessTokenProvider(),
	) {}

	private async getAccessToken(credentials: GmailCredentials): Promise<string> {
		return this.accessTokenProvider.getAccessToken(credentials);
	}

	private async request<T>(
		credentials: GmailCredentials,
		path: string,
		params: Record<string, string | number | undefined> = {},
	): Promise<T> {
		const url = new URL(path, GMAIL_API_BASE_URL);
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
		const payload = await parseJsonResponse<T & GmailApiErrorResponse>(
			response,
		);
		if (!response.ok) {
			const errorPayload = payload as GmailApiErrorResponse | null;
			const reasons =
				errorPayload?.error?.errors
					?.map((entry) => entry.reason)
					.filter((value): value is string => Boolean(value)) ?? [];
			throw new GmailApiError(
				response.status,
				errorPayload?.error?.message ??
					`Gmail API request failed: HTTP ${response.status}`,
				reasons,
			);
		}

		return (payload ?? {}) as T;
	}

	async validate(credentials: GmailCredentials): Promise<void> {
		await this.getProfile(credentials);
	}

	async getProfile(credentials: GmailCredentials): Promise<GmailProfile> {
		const response = await this.request<GmailProfileResponse>(
			credentials,
			"users/me/profile",
		);
		return {
			historyId: response.historyId ?? null,
			emailAddress: response.emailAddress?.trim() || undefined,
		};
	}

	async *iterateInboxMessageIds(
		credentials: GmailCredentials,
		syncFilter: GmailSyncFilter,
	): AsyncIterable<string> {
		let pageToken: string | undefined;

		do {
			const response = await this.request<GmailListMessagesResponse>(
				credentials,
				"users/me/messages",
				{
					labelIds: "INBOX",
					q: toSearchQuery(syncFilter),
					maxResults: 500,
					pageToken,
				},
			);

			for (const message of response.messages ?? []) {
				if (message.id) {
					yield message.id;
				}
			}

			pageToken = response.nextPageToken ?? undefined;
		} while (pageToken);
	}

	async listInboxMessageIds(
		credentials: GmailCredentials,
		syncFilter: GmailSyncFilter,
	): Promise<string[]> {
		const ids: string[] = [];
		for await (const id of this.iterateInboxMessageIds(
			credentials,
			syncFilter,
		)) {
			ids.push(id);
		}
		return ids;
	}

	async listHistory(
		credentials: GmailCredentials,
		startHistoryId: string,
	): Promise<GmailHistoryResult> {
		const history: GmailHistoryRecord[] = [];
		let pageToken: string | undefined;

		try {
			do {
				const response = await this.request<GmailListHistoryResponse>(
					credentials,
					"users/me/history",
					{
						startHistoryId,
						pageToken,
						maxResults: 500,
					},
				);

				history.push(...(response.history ?? []));
				pageToken = response.nextPageToken ?? undefined;
			} while (pageToken);
		} catch (error) {
			if (
				error instanceof GmailApiError &&
				(error.status === 404 ||
					error.reasons.includes(HISTORY_ID_INVALID_REASON))
			) {
				return { history: [], invalidCursor: true };
			}

			throw error;
		}

		return { history };
	}

	async getMessage(
		credentials: GmailCredentials,
		messageId: string,
	): Promise<GmailMessage | null> {
		try {
			const response = await this.request<GmailMessage>(
				credentials,
				`users/me/messages/${messageId}`,
				{
					format: "full",
				},
			);

			if (!response.id) {
				return null;
			}

			return response;
		} catch (error) {
			if (error instanceof GmailApiError && error.status === 404) {
				return null;
			}
			throw error;
		}
	}
}

function toBase64Padding(value: string): string {
	const remainder = value.length % 4;
	if (remainder === 0) {
		return value;
	}

	return `${value}${"=".repeat(4 - remainder)}`;
}

function decodeBody(data: string | null | undefined): string {
	if (!data) {
		return "";
	}

	return Buffer.from(
		toBase64Padding(data.replace(/-/g, "+").replace(/_/g, "/")),
		"base64",
	).toString("utf8");
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\r\n/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function flattenParts(root: GmailPart | null | undefined): GmailPart[] {
	if (!root) {
		return [];
	}

	return [root, ...(root.parts ?? []).flatMap((part) => flattenParts(part))];
}

function isAttachment(part: GmailPart): boolean {
	return Boolean(part.filename && part.filename.trim().length > 0);
}

function extractMessageBody(message: GmailMessage): string {
	const parts = flattenParts(message.payload);
	const plainPart = parts.find(
		(part) => part.mimeType === "text/plain" && !isAttachment(part),
	);
	if (plainPart?.body?.data) {
		return decodeBody(plainPart.body.data).trim();
	}

	const htmlPart = parts.find(
		(part) => part.mimeType === "text/html" && !isAttachment(part),
	);
	if (htmlPart?.body?.data) {
		return stripHtml(decodeBody(htmlPart.body.data));
	}

	if (message.payload?.body?.data) {
		return decodeBody(message.payload.body.data).trim();
	}

	return "";
}

function getHeaderValue(
	message: GmailMessage,
	headerName: string,
): string | undefined {
	const headers = message.payload?.headers ?? [];
	const match = headers.find(
		(header) => header.name?.toLowerCase() === headerName.toLowerCase(),
	);
	const value = match?.value?.trim();
	return value ? value : undefined;
}

function splitAddressHeader(value: string | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}

	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);

	return items.length > 0 ? items : undefined;
}

function toIsoDate(value: string | null | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const numeric = Number(value);
	if (Number.isFinite(numeric)) {
		return new Date(numeric).toISOString();
	}

	const parsed = Date.parse(value);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString();
	}

	return undefined;
}

function computeSourceHash(
	snapshot: Omit<SourceSnapshot, "sourceHash">,
): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
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

function toSourceSnapshot(
	integrationId: string,
	message: GmailMessage,
	accountEmail?: string,
): SourceSnapshot {
	const subject = getHeaderValue(message, "Subject") ?? "(no subject)";
	const createdAt =
		toIsoDate(message.internalDate) ??
		toIsoDate(getHeaderValue(message, "Date"));
	const metadata = {
		sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
		createdAt,
		updatedAt: createdAt,
		gmailThreadId: message.threadId ?? undefined,
		gmailLabelIds: message.labelIds ?? undefined,
		gmailAccountEmail: accountEmail,
		gmailFrom: getHeaderValue(message, "From"),
		gmailTo: splitAddressHeader(getHeaderValue(message, "To")),
		gmailCc: splitAddressHeader(getHeaderValue(message, "Cc")),
		gmailSnippet: message.snippet ?? undefined,
	};

	const snapshotBase: Omit<SourceSnapshot, "sourceHash"> = {
		integrationId,
		connectorId: "gmail",
		sourceId: message.id,
		entityType: "message",
		title: subject,
		slug: "",
		pathHint: { kind: "message", gmailAccountEmail: accountEmail },
		metadata,
		bodyMd: extractMessageBody(message),
		snapshotSchemaVersion: "1",
	};

	return {
		...snapshotBase,
		sourceHash: computeSourceHash(snapshotBase),
	};
}

async function getCredentials(
	request: ConnectorSyncRequest,
): Promise<GmailCredentials> {
	if (request.resolvedAuth?.kind !== "google-oauth") {
		throw new Error("Missing Google credentials in encrypted store");
	}

	return {
		clientId: request.resolvedAuth.clientId,
		clientSecret: request.resolvedAuth.clientSecret,
		refreshToken: request.resolvedAuth.refreshToken,
	};
}

async function hasCompleteCredentials(
	request: ConnectorSyncRequest,
): Promise<boolean> {
	return request.resolvedAuth?.kind === "google-oauth";
}

function resolveAccountEmail(
	request: ConnectorSyncRequest,
	profile?: GmailProfile,
): string | undefined {
	const profileEmail = profile?.emailAddress?.trim();
	if (profileEmail) {
		return profileEmail;
	}

	if (request.connection.kind === "google-account") {
		return request.connection.accountEmail?.trim() || undefined;
	}

	return undefined;
}

function collectChangedMessageIds(history: GmailHistoryRecord[]): string[] {
	const ids = new Set<string>();

	for (const entry of history) {
		for (const message of entry.messages ?? []) {
			if (message.id) {
				ids.add(message.id);
			}
		}

		for (const collection of [
			entry.messagesAdded,
			entry.messagesDeleted,
			entry.labelsAdded,
			entry.labelsRemoved,
		]) {
			for (const item of collection ?? []) {
				if (item.message?.id) {
					ids.add(item.message.id);
				}
			}
		}
	}

	return [...ids];
}

function getGmailSyncFilter(request: ConnectorSyncRequest): GmailSyncFilter {
	if (request.integration.connectorId !== "gmail") {
		throw new Error(
			`Invalid integration for Gmail connector: ${request.integration.connectorId}`,
		);
	}

	return request.integration.config.syncFilter === "primary-important"
		? "primary-important"
		: "primary";
}

function toSearchQuery(syncFilter: GmailSyncFilter): string {
	return syncFilter === "primary-important"
		? "category:primary label:important"
		: "category:primary";
}

function hasLabel(message: GmailMessage, label: string): boolean {
	return (message.labelIds ?? []).includes(label);
}

function isMessageEligible(
	message: GmailMessage,
	syncFilter: GmailSyncFilter,
): boolean {
	if (!hasLabel(message, "INBOX") || !hasLabel(message, "CATEGORY_PERSONAL")) {
		return false;
	}

	if (syncFilter === "primary-important" && !hasLabel(message, "IMPORTANT")) {
		return false;
	}

	return true;
}

function formatRemovalReason(syncFilter: GmailSyncFilter): string {
	return syncFilter === "primary-important"
		? "Gmail message removed from the active primary+important filter during sync"
		: "Gmail message removed from the active primary filter during sync";
}

function encodeCursor(
	historyId: string | null,
	syncFilter: GmailSyncFilter,
): string | null {
	if (!historyId) {
		return null;
	}

	return JSON.stringify({
		historyId,
		syncFilter,
	} satisfies StoredGmailCursor);
}

function decodeCursor(
	value: string | null,
	syncFilter: GmailSyncFilter,
): { historyId: string | null; resetReason: string | null } {
	if (!value) {
		return { historyId: null, resetReason: null };
	}

	try {
		const parsed = JSON.parse(value) as Partial<StoredGmailCursor>;
		if (typeof parsed.historyId !== "string") {
			return { historyId: null, resetReason: "legacy" };
		}

		if (
			parsed.syncFilter !== "primary" &&
			parsed.syncFilter !== "primary-important"
		) {
			return { historyId: null, resetReason: "legacy" };
		}

		if (parsed.syncFilter !== syncFilter) {
			return { historyId: null, resetReason: "filter-changed" };
		}

		return {
			historyId: parsed.historyId,
			resetReason: null,
		};
	} catch {
		return { historyId: null, resetReason: "legacy" };
	}
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

function toAsyncIterable<T>(
	values: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> {
	if (
		typeof (values as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
	) {
		return values as AsyncIterable<T>;
	}

	return (async function* () {
		yield* values as Iterable<T>;
	})();
}

function createAsyncIteratorReader<T>(
	values: AsyncIterable<T> | Iterable<T>,
): () => Promise<IteratorResult<T>> {
	const iterator = toAsyncIterable(values)[Symbol.asyncIterator]();
	let nextRequest = Promise.resolve();

	return async () => {
		const result = nextRequest.then(() => iterator.next());
		nextRequest = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
}

async function processWithConcurrency<T>(
	values: AsyncIterable<T> | Iterable<T>,
	concurrency: number,
	processor: (value: T) => Promise<void>,
	throwIfCancelled?: () => void,
): Promise<void> {
	const readNext = createAsyncIteratorReader(values);
	const normalizedConcurrency = Math.max(1, concurrency);
	let aborted = false;
	let firstError: unknown;

	const workers = Array.from({ length: normalizedConcurrency }, async () => {
		while (!aborted) {
			let next: IteratorResult<T>;

			try {
				next = await readNext();
			} catch (error) {
				aborted = true;
				firstError ??= error;
				return;
			}

			if (aborted || next.done) {
				return;
			}

			try {
				throwIfCancelled?.();
				await processor(next.value);
			} catch (error) {
				aborted = true;
				firstError ??= error;
				return;
			}
		}
	});

	await Promise.all(workers);

	if (firstError) {
		throw firstError;
	}
}

async function* iterateInboxMessageIds(
	adapter: GmailAdapter,
	credentials: GmailCredentials,
	syncFilter: GmailSyncFilter,
	throwIfCancelled?: () => void,
): AsyncIterable<string> {
	if (adapter.iterateInboxMessageIds) {
		for await (const id of adapter.iterateInboxMessageIds(
			credentials,
			syncFilter,
		)) {
			throwIfCancelled?.();
			yield id;
		}
		return;
	}

	for (const id of await adapter.listInboxMessageIds(credentials, syncFilter)) {
		throwIfCancelled?.();
		yield id;
	}
}

export interface CreateGmailConnectorOptions {
	adapter?: GmailAdapter;
}

class GmailConnector implements Connector {
	readonly id = "gmail";
	readonly label = "Gmail";
	readonly setupMethods = [
		{
			kind: "provider-oauth",
			providerId: "google",
			requiredScopes: GMAIL_REQUIRED_SCOPES,
		},
	] as const;
	private static readonly DEFAULT_FETCH_CONCURRENCY = 10;

	constructor(private readonly adapter: GmailAdapter) {}

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return {
				status: "warn",
				message: "integration disabled",
			};
		}

		if (!(await hasCompleteCredentials(request))) {
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
				GMAIL_REQUIRED_SCOPES,
			);
			await this.adapter.validate(credentials);
			return {
				status: "ok",
				message: "credentials valid",
			};
		} catch (error) {
			return {
				status: "error",
				message:
					error instanceof Error ? error.message : "unknown validation error",
			};
		}
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		if (request.integration.connectorId !== "gmail") {
			throw new Error(
				`Invalid integration for Gmail connector: ${request.integration.connectorId}`,
			);
		}

		request.throwIfCancelled();
		const credentials = await getCredentials(request);
		const syncFilter = getGmailSyncFilter(request);
		const profileBeforeRun = await this.adapter.getProfile(credentials);
		const historyIdBeforeRun = profileBeforeRun.historyId;
		const accountEmail = resolveAccountEmail(request, profileBeforeRun);
		const fetchConcurrency = normalizePositiveInteger(
			request.integration.config.fetchConcurrency,
			GmailConnector.DEFAULT_FETCH_CONCURRENCY,
		);
		const storedCursor = decodeCursor(request.since, syncFilter);
		let since = storedCursor.historyId;

		if (storedCursor.resetReason) {
			request.io.write(
				storedCursor.resetReason === "filter-changed"
					? "Gmail sync filter changed. Resetting integration state before the next scoped sync."
					: "Gmail legacy cursor detected. Resetting integration state before the next scoped sync.",
			);
			await request.resetIntegrationState();
			since = null;
		}

		let processedMessages = 0;
		const publishMailboxHistoryProgress = () => {
			request.setProgress({
				mode: "indeterminate",
				phase: "Checking mailbox history",
				detail: null,
				completed: null,
				total: null,
				unit: "messages",
			});
		};
		const publishInboxScanProgress = () => {
			request.setProgress({
				mode: "indeterminate",
				phase: "Scanning inbox",
				detail: `processed ${processedMessages} | concurrency ${fetchConcurrency}`,
				completed: null,
				total: null,
				unit: "messages",
			});
		};
		const publishIncrementalProgress = (total: number) => {
			request.setProgress({
				mode: "determinate",
				phase: "Fetching changed messages",
				detail: `processed ${processedMessages} of ${total} | concurrency ${fetchConcurrency}`,
				completed: processedMessages,
				total,
				unit: "messages",
			});
		};

		if (!since) {
			publishInboxScanProgress();
			request.io.write(
				`Gmail progress: streaming inbox scan concurrency=${fetchConcurrency}`,
			);
			await processWithConcurrency(
				iterateInboxMessageIds(this.adapter, credentials, syncFilter, () =>
					request.throwIfCancelled(),
				),
				fetchConcurrency,
				async (messageId) => {
					request.throwIfCancelled();
					const message = await this.adapter.getMessage(credentials, messageId);

					if (!message) {
						await request.deleteSource(messageId);
						processedMessages += 1;
						publishInboxScanProgress();
						request.io.write(`Gmail message deleted during sync: ${messageId}`);
						return;
					}

					if (!isMessageEligible(message, syncFilter)) {
						await request.deleteSource(messageId);
						processedMessages += 1;
						publishInboxScanProgress();
						request.io.write(
							`${formatRemovalReason(syncFilter)}: ${messageId}`,
						);
						return;
					}

					await request.persistSource(
						toSourceSnapshot(request.integration.id, message, accountEmail),
					);
					processedMessages += 1;
					publishInboxScanProgress();
				},
				() => request.throwIfCancelled(),
			);
		} else {
			request.throwIfCancelled();
			publishMailboxHistoryProgress();
			const historyResult = await this.adapter.listHistory(credentials, since);
			if (historyResult.invalidCursor) {
				processedMessages = 0;
				publishInboxScanProgress();
				request.io.write(
					"Gmail history cursor expired. Falling back to a full scoped rescan.",
				);
				request.io.write(
					`Gmail progress: streaming inbox scan concurrency=${fetchConcurrency}`,
				);
				await processWithConcurrency(
					iterateInboxMessageIds(this.adapter, credentials, syncFilter, () =>
						request.throwIfCancelled(),
					),
					fetchConcurrency,
					async (messageId) => {
						request.throwIfCancelled();
						const message = await this.adapter.getMessage(
							credentials,
							messageId,
						);

						if (!message) {
							await request.deleteSource(messageId);
							processedMessages += 1;
							publishInboxScanProgress();
							request.io.write(
								`Gmail message deleted during sync: ${messageId}`,
							);
							return;
						}

						if (!isMessageEligible(message, syncFilter)) {
							await request.deleteSource(messageId);
							processedMessages += 1;
							publishInboxScanProgress();
							request.io.write(
								`${formatRemovalReason(syncFilter)}: ${messageId}`,
							);
							return;
						}

						await request.persistSource(
							toSourceSnapshot(request.integration.id, message, accountEmail),
						);
						processedMessages += 1;
						publishInboxScanProgress();
					},
					() => request.throwIfCancelled(),
				);
			} else {
				const uniqueIds = [
					...new Set(collectChangedMessageIds(historyResult.history)),
				];
				processedMessages = 0;
				publishIncrementalProgress(uniqueIds.length);
				request.io.write(
					`Gmail progress: messages=${uniqueIds.length} concurrency=${fetchConcurrency}`,
				);
				await processWithConcurrency(
					uniqueIds,
					fetchConcurrency,
					async (messageId) => {
						request.throwIfCancelled();
						const message = await this.adapter.getMessage(
							credentials,
							messageId,
						);

						if (!message) {
							await request.deleteSource(messageId);
							processedMessages += 1;
							publishIncrementalProgress(uniqueIds.length);
							request.io.write(
								`Gmail message deleted during sync: ${messageId}`,
							);
							return;
						}

						if (!isMessageEligible(message, syncFilter)) {
							await request.deleteSource(messageId);
							processedMessages += 1;
							publishIncrementalProgress(uniqueIds.length);
							request.io.write(
								`${formatRemovalReason(syncFilter)}: ${messageId}`,
							);
							return;
						}

						await request.persistSource(
							toSourceSnapshot(request.integration.id, message, accountEmail),
						);
						processedMessages += 1;
						publishIncrementalProgress(uniqueIds.length);
					},
					() => request.throwIfCancelled(),
				);
			}
		}

		request.throwIfCancelled();
		const nextCursor =
			(await this.adapter.getProfile(credentials)).historyId ??
			historyIdBeforeRun;

		return {
			nextCursor: encodeCursor(nextCursor, syncFilter),
		};
	}
}

export function createGmailConnector(
	options: CreateGmailConnectorOptions = {},
): Connector {
	return new GmailConnector(options.adapter ?? new OfficialGmailAdapter());
}

export {
	extractMessageBody,
	type GmailCredentials,
	stripHtml,
	toSourceSnapshot,
};
