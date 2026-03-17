import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeConfig } from "./config.js";
import { createDefaultConfig, getDefaultIntegration } from "./config-model.js";
import type {
	AppIo,
	AppPaths,
	Connector,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	DocumentSink,
	MarkdownRenderer,
	RenderedDocument,
	SecretsStore,
	SinkWriteRequest,
	SinkWriteResult,
	SourceRecord,
	SourceSnapshot,
	StateStore,
	StoredSourceSnapshot,
	SyncdownConfig,
} from "./types.js";

export class MemoryStateStore implements StateStore {
	readonly cursors = new Map<string, string | null>();
	readonly lastSyncAt = new Map<string, string | null>();
	readonly sourceRecords = new Map<string, SourceRecord>();
	readonly sourceSnapshots = new Map<string, StoredSourceSnapshot>();

	async getCursor(integrationId: string): Promise<string | null> {
		return this.cursors.get(integrationId) ?? null;
	}

	async setCursor(integrationId: string, cursor: string | null): Promise<void> {
		this.cursors.set(integrationId, cursor);
	}

	async getLastSyncAt(integrationId: string): Promise<string | null> {
		return this.lastSyncAt.get(integrationId) ?? null;
	}

	async setLastSyncAt(integrationId: string, value: string): Promise<void> {
		this.lastSyncAt.set(integrationId, value);
	}

	async resetIntegration(integrationId: string): Promise<SourceRecord[]> {
		const deletedRecords = [...this.sourceRecords.values()].filter(
			(record) => record.integrationId === integrationId,
		);

		this.cursors.delete(integrationId);
		this.lastSyncAt.delete(integrationId);

		for (const record of deletedRecords) {
			this.sourceRecords.delete(`${record.integrationId}:${record.sourceId}`);
			this.sourceSnapshots.delete(`${record.integrationId}:${record.sourceId}`);
		}

		return deletedRecords;
	}

	async getSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<SourceRecord | null> {
		return this.sourceRecords.get(`${integrationId}:${sourceId}`) ?? null;
	}

	async listSourceRecords(integrationId: string): Promise<SourceRecord[]> {
		return [...this.sourceRecords.values()].filter(
			(record) => record.integrationId === integrationId,
		);
	}

	async upsertSourceRecord(record: SourceRecord): Promise<void> {
		this.sourceRecords.set(
			`${record.integrationId}:${record.sourceId}`,
			record,
		);
	}

	async deleteSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		this.sourceRecords.delete(`${integrationId}:${sourceId}`);
	}

	async getSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<StoredSourceSnapshot | null> {
		return this.sourceSnapshots.get(`${integrationId}:${sourceId}`) ?? null;
	}

	async upsertSourceSnapshot(snapshot: StoredSourceSnapshot): Promise<void> {
		this.sourceSnapshots.set(
			`${snapshot.integrationId}:${snapshot.sourceId}`,
			snapshot,
		);
	}

	async deleteSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		this.sourceSnapshots.delete(`${integrationId}:${sourceId}`);
	}

	async describe(): Promise<string[]> {
		return [];
	}
}

export class StaticSecretsStore implements SecretsStore {
	async hasSecret(): Promise<boolean> {
		return true;
	}

	async getSecret(): Promise<string | null> {
		return "secret-token";
	}

	async setSecret(): Promise<void> {}

	async deleteSecret(): Promise<void> {}

	describe(): string {
		return "memory";
	}
}

export class TestRenderer implements MarkdownRenderer {
	getVersion(connectorId: SourceSnapshot["connectorId"]): string {
		switch (connectorId) {
			case "notion":
				return "test-renderer-notion-v1";
			case "gmail":
				return "test-renderer-gmail-v1";
			case "google-calendar":
				return "test-renderer-google-calendar-v1";
			default:
				throw new Error(`Unsupported connector: ${connectorId}`);
		}
	}

	render(document: SourceSnapshot): RenderedDocument {
		const relativePath =
			document.pathHint.kind === "message"
				? `${document.connectorId}/primary/${document.sourceId}.md`
				: document.pathHint.kind === "calendar-event"
					? `${document.connectorId}/${document.pathHint.calendarName ?? "calendar"}/${document.sourceId}.md`
					: document.pathHint.kind === "database" &&
							document.pathHint.databaseName
						? `${document.connectorId}/databases/${document.pathHint.databaseName}/${document.sourceId}.md`
						: `${document.connectorId}/pages/${document.sourceId}.md`;

		return {
			sourceId: document.sourceId,
			title: document.title,
			relativePath,
			contents: `${document.title}\n${document.bodyMd}\n`,
			sourceHash: document.sourceHash,
		};
	}
}

export class TestSink implements DocumentSink {
	async write(request: SinkWriteRequest): Promise<SinkWriteResult> {
		const absolutePath = path.join(
			request.outputDir,
			request.document.relativePath,
		);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		let action: SinkWriteResult["action"] = "created";

		try {
			const current = await readFile(absolutePath, "utf8");
			action = current === request.document.contents ? "unchanged" : "updated";
		} catch {
			action = "created";
		}

		if (action !== "unchanged") {
			await writeFile(absolutePath, request.document.contents, "utf8");
		}

		return { absolutePath, action };
	}

	async delete(outputDir: string, relativePath: string): Promise<void> {
		await rm(path.join(outputDir, relativePath), { force: true });
	}
}

export function createSource(
	sourceId: string,
	title = sourceId,
): SourceSnapshot {
	return {
		integrationId: "test-integration-id",
		connectorId: "notion",
		sourceId,
		entityType: "page",
		title,
		slug: "",
		pathHint: { kind: "page" },
		metadata: {
			archived: false,
			updatedAt: `2026-03-16T00:00:00.${sourceId.slice(-1)}Z`,
		},
		bodyMd: `body-${sourceId}`,
		sourceHash: `hash-${sourceId}`,
		snapshotSchemaVersion: "1",
	};
}

export function createConnector(
	id: "notion" | "gmail" | "google-calendar",
	syncImpl?: (request: ConnectorSyncRequest) => Promise<ConnectorSyncResult>,
): Connector {
	return {
		id,
		label:
			id === "notion" ? "Notion" : id === "gmail" ? "Gmail" : "Google Calendar",
		setupMethods:
			id === "gmail"
				? [
						{
							kind: "provider-oauth",
							providerId: "google",
							requiredScopes: [
								"https://www.googleapis.com/auth/gmail.readonly",
							],
						},
					]
				: id === "google-calendar"
					? [
							{
								kind: "provider-oauth",
								providerId: "google",
								requiredScopes: [
									"https://www.googleapis.com/auth/calendar.readonly",
								],
							},
						]
					: [
							{
								kind: "token",
							},
							{
								kind: "provider-oauth",
								providerId: "notion",
								requiredScopes: [],
							},
						],
		async validate(): Promise<{ status: "ok"; message: string }> {
			return { status: "ok", message: "credentials valid" };
		},
		async sync(request: ConnectorSyncRequest) {
			if (syncImpl) {
				return syncImpl(request);
			}

			await request.persistSource({
				...createSource(`${id}-page`),
				integrationId: request.integration.id,
				connectorId: request.integration.connectorId,
			});
			return {
				nextCursor: `${id}-cursor`,
			};
		},
	};
}

export async function createTestPaths(): Promise<{
	cleanup: () => Promise<void>;
	config: SyncdownConfig;
	gmailIntegrationId: string;
	notionIntegrationId: string;
	paths: AppPaths;
}> {
	const root = await mkdtemp(
		path.join(resolveTempDirectory(), "syncdown-core-"),
	);
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.XDG_DATA_HOME = path.join(root, "data");

	const paths: AppPaths = {
		configDir: path.join(process.env.XDG_CONFIG_HOME, "syncdown"),
		dataDir: path.join(process.env.XDG_DATA_HOME, "syncdown"),
		configPath: path.join(
			process.env.XDG_CONFIG_HOME,
			"syncdown",
			"config.json",
		),
		statePath: path.join(process.env.XDG_DATA_HOME, "syncdown", "state.db"),
		secretsPath: path.join(
			process.env.XDG_DATA_HOME,
			"syncdown",
			"secrets.enc",
		),
		masterKeyPath: path.join(
			process.env.XDG_DATA_HOME,
			"syncdown",
			"master.key",
		),
		lockPath: path.join(process.env.XDG_DATA_HOME, "syncdown", "sync.lock"),
	};
	const config: SyncdownConfig = createDefaultConfig();
	config.outputDir = path.join(root, "output");
	getDefaultIntegration(config, "notion").enabled = true;
	const notionIntegrationId = getDefaultIntegration(config, "notion").id;
	const gmailIntegrationId = getDefaultIntegration(config, "gmail").id;

	await writeConfig(paths, config);
	return {
		async cleanup() {
			delete process.env.XDG_CONFIG_HOME;
			delete process.env.XDG_DATA_HOME;
			await rm(root, { recursive: true, force: true });
		},
		paths,
		config,
		gmailIntegrationId,
		notionIntegrationId,
	};
}

function resolveTempDirectory(): string {
	return (
		Bun.env.TMPDIR ??
		Bun.env.TMP ??
		Bun.env.TEMP ??
		(process.platform === "win32"
			? Bun.env.LOCALAPPDATA
				? path.join(Bun.env.LOCALAPPDATA, "Temp")
				: undefined
			: undefined) ??
		"/tmp"
	);
}

export function createIo(): AppIo {
	return {
		write() {},
		error() {},
	};
}

export function createIoCapture(): {
	io: AppIo;
	writes: string[];
	errors: string[];
} {
	const writes: string[] = [];
	const errors: string[] = [];

	return {
		io: {
			write(line) {
				writes.push(line);
			},
			error(line) {
				errors.push(line);
			},
		},
		writes,
		errors,
	};
}

export function createTestRuntime() {
	let now = new Date("2026-03-17T00:00:00.000Z");
	let nextIntervalHandle = 1;
	let onSleep: ((ms: number) => Promise<void> | void) | undefined;
	const sleepCalls: number[] = [];
	const intervals = new Map<
		number,
		{ handler: () => void | Promise<void>; ms: number; nextAt: number }
	>();
	const signalListeners = new Map<NodeJS.Signals, Set<() => void>>();

	async function advance(ms: number): Promise<void> {
		const target = now.getTime() + ms;

		while (true) {
			let nextHandle: number | null = null;
			let nextAt = Number.POSITIVE_INFINITY;

			for (const [handle, interval] of intervals) {
				if (interval.nextAt < nextAt) {
					nextAt = interval.nextAt;
					nextHandle = handle;
				}
			}

			if (nextHandle === null || nextAt > target) {
				now = new Date(target);
				return;
			}

			now = new Date(nextAt);
			const interval = intervals.get(nextHandle);
			if (!interval) {
				continue;
			}

			interval.nextAt += interval.ms;
			await interval.handler();
		}
	}

	return {
		runtime: {
			now: () => new Date(now),
			async sleep(ms: number): Promise<void> {
				sleepCalls.push(ms);
				await advance(ms);
				await onSleep?.(ms);
			},
			setInterval(handler: () => void | Promise<void>, ms: number) {
				const handle = nextIntervalHandle;
				nextIntervalHandle += 1;
				intervals.set(handle, { handler, ms, nextAt: now.getTime() + ms });
				return handle as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval(handle: ReturnType<typeof setInterval>) {
				intervals.delete(handle as unknown as number);
			},
			addSignalListener(signal: NodeJS.Signals, handler: () => void) {
				const listeners = signalListeners.get(signal) ?? new Set<() => void>();
				listeners.add(handler);
				signalListeners.set(signal, listeners);

				return () => {
					listeners.delete(handler);
					if (listeners.size === 0) {
						signalListeners.delete(signal);
					}
				};
			},
		},
		sleepCalls,
		setOnSleep(handler: (ms: number) => Promise<void> | void) {
			onSleep = handler;
		},
		emit(signal: NodeJS.Signals) {
			for (const handler of signalListeners.get(signal) ?? []) {
				handler();
			}
		},
	};
}
