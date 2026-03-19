import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
	Connector,
	ConnectorPlugin,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	HealthCheck,
	IntegrationConfig,
	SourceSnapshot,
} from "@syncdown/core";
import {
	DEFAULT_APPLE_NOTES_CONNECTION_ID,
	defineConnectorPlugin,
} from "@syncdown/core";

export interface AppleNotesNote {
	id: string;
	title: string;
	body: string;
	account: string;
	folderPath: string[];
	createdAt?: string;
	updatedAt?: string;
	locked?: boolean;
}

export interface AppleNotesWarning {
	noteId?: string;
	message: string;
}

export interface AppleNotesScanResult {
	notes: AppleNotesNote[];
	warnings: AppleNotesWarning[];
}

export interface AppleNotesAdapter {
	validateAccess(): Promise<void>;
	listNotes(): Promise<AppleNotesScanResult>;
}

export interface AppleNotesScriptRunner {
	run(script: string): Promise<string>;
}

export interface CreateAppleNotesConnectorOptions {
	adapter?: AppleNotesAdapter;
	platform?: NodeJS.Platform;
}

interface AppleNotesScriptPayload {
	notes?: Array<{
		id?: string;
		title?: string;
		body?: string;
		account?: string;
		folderPath?: string[];
		createdAt?: string | null;
		updatedAt?: string | null;
		locked?: boolean;
	}>;
	warnings?: Array<{
		noteId?: string;
		message?: string;
	}>;
}

const APPLE_NOTES_SNAPSHOT_SCHEMA_VERSION = "1";
const APPLE_NOTES_ACCESS_ERROR =
	"Apple Notes access is unavailable. On macOS, allow syncdown or the current terminal to control Notes and try again.";

class AppleNotesAdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppleNotesAdapterError";
	}
}

class OsaScriptRunner implements AppleNotesScriptRunner {
	async run(script: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn("osascript", ["-l", "JavaScript", "-e", script], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => {
				reject(new AppleNotesAdapterError(error.message));
			});
			child.on("close", (code) => {
				if (code === 0) {
					resolve(stdout.trim());
					return;
				}

				reject(
					new AppleNotesAdapterError(
						stderr.trim() || `osascript exited with code ${code ?? 1}`,
					),
				);
			});
		});
	}
}

function buildAccessProbeScript(): string {
	return `
const Notes = Application("Notes");
Notes.includeStandardAdditions = true;
JSON.stringify({ accountCount: Notes.accounts().length });
`.trim();
}

function buildListNotesScript(): string {
	return `
const Notes = Application("Notes");
Notes.includeStandardAdditions = true;

function toIso(value) {
  try {
    if (!value) {
      return null;
    }
    return new Date(value).toISOString();
  } catch (error) {
    return null;
  }
}

function getBody(note) {
  try {
    const plain = note.plaintext();
    if (typeof plain === "string" && plain.length > 0) {
      return plain;
    }
  } catch (error) {}

  try {
    const body = note.body();
    return typeof body === "string" ? body : "";
  } catch (error) {
    return "";
  }
}

function visitFolder(accountName, folder, parentPath, notes, warnings) {
  const folderName = folder.name();
  const folderPath = parentPath.concat([folderName]);

  for (const note of folder.notes()) {
    try {
      notes.push({
        id: String(note.id()),
        title: String(note.name() || "Untitled"),
        body: getBody(note),
        account: String(accountName || "Unknown Account"),
        folderPath,
        createdAt: toIso(note.creationDate()),
        updatedAt: toIso(note.modificationDate()),
        locked: Boolean(note.passwordProtected ? note.passwordProtected() : false),
      });
    } catch (error) {
      warnings.push({
        noteId: (() => {
          try {
            return String(note.id());
          } catch (_error) {
            return undefined;
          }
        })(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const childFolder of folder.folders()) {
    visitFolder(accountName, childFolder, folderPath, notes, warnings);
  }
}

const notes = [];
const warnings = [];

for (const account of Notes.accounts()) {
  const accountName = String(account.name() || "Unknown Account");
  for (const folder of account.folders()) {
    visitFolder(accountName, folder, [], notes, warnings);
  }
}

JSON.stringify({ notes, warnings });
`.trim();
}

function normalizeAppleNotesBody(value: string): string {
	const withoutHtml = value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");

	return withoutHtml
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function normalizeSegment(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function toSourceId(rawId: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(rawId)
		.digest("hex")
		.slice(0, 16);
}

function toSourceHash(note: AppleNotesNote): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
				title: note.title,
				body: note.body,
				account: note.account,
				folderPath: note.folderPath,
				createdAt: note.createdAt,
				updatedAt: note.updatedAt,
				locked: note.locked,
			}),
		)
		.digest("hex");
}

function toSourceSnapshot(
	request: ConnectorSyncRequest,
	note: AppleNotesNote,
): SourceSnapshot {
	const account = normalizeSegment(note.account, "unknown-account");
	const folderPath =
		note.folderPath.length > 0
			? note.folderPath.map((segment) => normalizeSegment(segment, "root"))
			: ["root"];
	const folder = folderPath.at(-1) ?? "root";
	const title = normalizeSegment(note.title, "Untitled");
	const sourceId = toSourceId(note.id);

	return {
		integrationId: request.integration.id,
		connectorId: "apple-notes",
		sourceId,
		entityType: "note",
		title,
		slug: "",
		pathHint: {
			kind: "note",
			appleNotesAccount: account,
			appleNotesFolder: folder,
			appleNotesFolderPath: folderPath,
		},
		metadata: {
			createdAt: note.createdAt,
			updatedAt: note.updatedAt,
			appleNotesNoteId: note.id,
			appleNotesFolder: folder,
			appleNotesFolderPath: folderPath,
		},
		bodyMd: normalizeAppleNotesBody(note.body),
		sourceHash: toSourceHash(note),
		snapshotSchemaVersion: APPLE_NOTES_SNAPSHOT_SCHEMA_VERSION,
	};
}

function parsePayload(raw: string): AppleNotesScanResult {
	const parsed = JSON.parse(raw) as AppleNotesScriptPayload;

	return {
		notes:
			parsed.notes?.flatMap((note): AppleNotesNote[] => {
				if (!note?.id) {
					return [];
				}

				return [
					{
						id: note.id,
						title: note.title?.trim() || "Untitled",
						body: typeof note.body === "string" ? note.body : "",
						account: note.account?.trim() || "unknown-account",
						folderPath: Array.isArray(note.folderPath)
							? note.folderPath.filter(
									(value): value is string =>
										typeof value === "string" && value.trim().length > 0,
								)
							: [],
						createdAt: note.createdAt ?? undefined,
						updatedAt: note.updatedAt ?? undefined,
						locked: note.locked ?? undefined,
					},
				];
			}) ?? [],
		warnings:
			parsed.warnings?.flatMap((warning): AppleNotesWarning[] => {
				if (!warning?.message) {
					return [];
				}

				return [
					{
						noteId: warning.noteId,
						message: warning.message,
					},
				];
			}) ?? [],
	};
}

class MacAppleNotesAdapter implements AppleNotesAdapter {
	constructor(
		private readonly runner: AppleNotesScriptRunner = new OsaScriptRunner(),
	) {}

	private mapError(error: unknown): AppleNotesAdapterError {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("Not authorized") ||
			message.includes("authorization") ||
			message.includes("Application isn’t running")
		) {
			return new AppleNotesAdapterError(APPLE_NOTES_ACCESS_ERROR);
		}

		return new AppleNotesAdapterError(message);
	}

	async validateAccess(): Promise<void> {
		try {
			await this.runner.run(buildAccessProbeScript());
		} catch (error) {
			throw this.mapError(error);
		}
	}

	async listNotes(): Promise<AppleNotesScanResult> {
		try {
			return parsePayload(await this.runner.run(buildListNotesScript()));
		} catch (error) {
			throw this.mapError(error);
		}
	}
}

class AppleNotesConnector implements Connector {
	readonly id = "apple-notes";
	readonly label = "Apple Notes";
	readonly setupMethods = [
		{
			kind: "local",
			connectionId: DEFAULT_APPLE_NOTES_CONNECTION_ID,
			connectionKind: "apple-notes-local",
			label: "Local Access",
		},
	] as const;

	constructor(
		private readonly adapter: AppleNotesAdapter,
		private readonly platform: NodeJS.Platform,
	) {}

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return {
				status: "warn",
				message: "integration disabled",
			};
		}

		if (this.platform !== "darwin") {
			return {
				status: "error",
				message: "Apple Notes sync is only supported on macOS",
			};
		}

		try {
			await this.adapter.validateAccess();
			return {
				status: "ok",
				message: "local Apple Notes access available",
			};
		} catch (error) {
			return {
				status: "error",
				message:
					error instanceof Error ? error.message : APPLE_NOTES_ACCESS_ERROR,
			};
		}
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		if (this.platform !== "darwin") {
			throw new Error("Apple Notes sync is only supported on macOS");
		}

		const { notes, warnings } = await this.adapter.listNotes();
		const seenSourceIds = new Set<string>();
		request.setProgress({
			mode: "determinate",
			phase: "syncing",
			detail: "Scanning Apple Notes",
			completed: 0,
			total: notes.length,
			unit: "items",
		});

		for (const warning of warnings) {
			request.io.write(
				warning.noteId
					? `Skipped Apple Notes item ${warning.noteId}: ${warning.message}`
					: `Skipped Apple Notes item: ${warning.message}`,
			);
		}

		for (const [index, note] of notes.entries()) {
			request.throwIfCancelled();
			if (note.locked) {
				request.io.write(`Skipped locked Apple Note ${note.id}`);
				continue;
			}

			const snapshot = toSourceSnapshot(request, note);
			seenSourceIds.add(snapshot.sourceId);
			await request.persistSource(snapshot);
			request.setProgress({
				mode: "determinate",
				phase: "syncing",
				detail: snapshot.title,
				completed: index + 1,
				total: notes.length,
				unit: "items",
			});
		}

		for (const record of await request.state.listSourceRecords(
			request.integration.id,
		)) {
			if (!seenSourceIds.has(record.sourceId)) {
				await request.deleteSource(record.sourceId);
			}
		}

		request.setProgress(null);
		return { nextCursor: null };
	}
}

export function createAppleNotesAdapter(): AppleNotesAdapter {
	return new MacAppleNotesAdapter();
}

function normalizeAppleNotesConnection(
	entry: Partial<{ id: string; kind: string; label: string }>,
) {
	if (
		entry.kind !== "apple-notes-local" ||
		typeof entry.id !== "string" ||
		typeof entry.label !== "string"
	) {
		return [];
	}

	return [
		{
			id: entry.id,
			kind: "apple-notes-local" as const,
			label: entry.label,
		},
	];
}

function normalizeAppleNotesIntegration(entry: Partial<IntegrationConfig>) {
	if (
		entry.connectorId !== "apple-notes" ||
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
			connectorId: "apple-notes" as const,
			connectionId: entry.connectionId,
			label: entry.label,
			enabled: entry.enabled,
			interval: entry.interval,
			config: {},
		},
	];
}

export function createAppleNotesConnectorPlugin(
	options: CreateAppleNotesConnectorOptions = {},
): ConnectorPlugin {
	const runtime = new AppleNotesConnector(
		options.adapter ?? createAppleNotesAdapter(),
		options.platform ?? process.platform,
	);

	const setupMethods = [
		{
			kind: "local" as const,
			connectionId: DEFAULT_APPLE_NOTES_CONNECTION_ID,
			connectionKind: "apple-notes-local",
			label: "Local Access",
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
			supportedPlatforms: ["darwin"],
			cliAliases: [
				{
					key: "appleNotes.enabled",
					async setValue(context, rawValue) {
						if (rawValue !== "true" && rawValue !== "false") {
							throw new Error("appleNotes.enabled must be `true` or `false`.");
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "apple-notes",
						);
						if (!integration) {
							throw new Error("Missing default Apple Notes integration.");
						}
						integration.enabled = rawValue === "true";
						return `Set appleNotes.enabled=${integration.enabled}`;
					},
				},
				{
					key: "appleNotes.interval",
					async setValue(context, rawValue) {
						if (
							rawValue !== "5m" &&
							rawValue !== "15m" &&
							rawValue !== "1h" &&
							rawValue !== "6h" &&
							rawValue !== "24h"
						) {
							throw new Error(
								"appleNotes.interval must be one of: 5m, 15m, 1h, 6h, 24h",
							);
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "apple-notes",
						);
						if (!integration) {
							throw new Error("Missing default Apple Notes integration.");
						}
						integration.interval = rawValue;
						return `Set appleNotes.interval=${integration.interval}`;
					},
				},
			],
		},
		render: {
			version: "1",
		},
		seedConnections() {
			return [
				{
					id: DEFAULT_APPLE_NOTES_CONNECTION_ID,
					kind: "apple-notes-local",
					label: "Default Apple Notes Connection",
				},
			];
		},
		seedIntegrations() {
			return [
				{
					id: randomUUID(),
					connectorId: "apple-notes",
					connectionId: DEFAULT_APPLE_NOTES_CONNECTION_ID,
					label: "Apple Notes",
					enabled: false,
					interval: "1h",
					config: {},
				},
			];
		},
		normalizeConnection: normalizeAppleNotesConnection,
		normalizeIntegration: normalizeAppleNotesIntegration,
	});
}

export function createAppleNotesConnector(
	options: CreateAppleNotesConnectorOptions = {},
): Connector {
	return createAppleNotesConnectorPlugin(options);
}

export { APPLE_NOTES_ACCESS_ERROR, APPLE_NOTES_SNAPSHOT_SCHEMA_VERSION };
