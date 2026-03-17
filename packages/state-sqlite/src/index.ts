import { Database } from "bun:sqlite";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type {
	SourceRecord,
	SourceSnapshot,
	StateStore,
	StoredSourceSnapshot,
} from "@syncdown/core";
import { resolveAppPaths } from "@syncdown/core";
import { DRIZZLE_MIGRATIONS } from "./generated-migrations.js";

const SQLITE_HEADER = "SQLite format 3";
const MIGRATIONS_TABLE = "__drizzle_migrations";

interface CursorRow {
	cursor_value: string | null;
}

interface LastSyncRow {
	last_sync_at: string | null;
}

interface SourceRecordRow {
	integration_id: string;
	connector_id: string;
	source_id: string;
	entity_type: string;
	relative_path: string;
	source_hash: string;
	render_version: string;
	snapshot_hash: string;
	source_updated_at: string | null;
	last_rendered_at: string | null;
}

interface SourceSnapshotRow {
	integration_id: string;
	connector_id: string;
	source_id: string;
	snapshot_hash: string;
	snapshot_schema_version: string;
	payload_json: string;
}

interface CountRow {
	count: number;
}

interface MigrationTagRow {
	tag: string;
}

interface StateMigration {
	idx: number;
	tag: string;
	statements: string[];
}

type SqlBinding = string | number | bigint | boolean | Uint8Array | null;
type SqlBindings = SqlBinding[];

export interface CreateStateStoreOptions {
	statePath?: string;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
}

async function ensureSqliteFile(filePath: string): Promise<void> {
	await ensureParentDirectory(filePath);

	const stateFile = Bun.file(filePath);
	if (!(await stateFile.exists())) {
		return;
	}

	const header = await stateFile
		.slice(0, SQLITE_HEADER.length)
		.text()
		.catch(() => "");
	if (header.startsWith(SQLITE_HEADER)) {
		return;
	}

	await rename(filePath, `${filePath}.legacy.json`);
}

function loadMigrations(): StateMigration[] {
	return DRIZZLE_MIGRATIONS.map((entry) => {
		const statements = entry.sql
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter((statement) => statement.length > 0);

		return {
			idx: entry.idx,
			tag: entry.tag,
			statements,
		};
	});
}

function ensureMigrations(database: Database): void {
	database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

	const appliedRows = database
		.query(`SELECT tag FROM ${MIGRATIONS_TABLE}`)
		.all() as MigrationTagRow[];
	const appliedTags = new Set(appliedRows.map((row) => row.tag));

	for (const migration of loadMigrations().sort((a, b) => a.idx - b.idx)) {
		if (appliedTags.has(migration.tag)) {
			continue;
		}

		try {
			database.exec("BEGIN IMMEDIATE");
			for (const statement of migration.statements) {
				database.exec(statement);
			}
			database.run(
				`INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (?, ?)`,
				[migration.tag, Date.now()],
			);
			database.exec("COMMIT");
		} catch (error) {
			if (database.inTransaction) {
				database.exec("ROLLBACK");
			}
			throw error;
		}
	}
}

function toCount(value: number | bigint): number {
	return Number(value);
}

function toSourceRecord(row: SourceRecordRow): SourceRecord {
	return {
		integrationId: row.integration_id,
		connectorId: row.connector_id,
		sourceId: row.source_id,
		entityType: row.entity_type,
		relativePath: row.relative_path,
		sourceHash: row.source_hash,
		renderVersion: row.render_version,
		snapshotHash: row.snapshot_hash,
		sourceUpdatedAt: row.source_updated_at ?? undefined,
		lastRenderedAt: row.last_rendered_at ?? undefined,
	};
}

class BunSqliteStateStore implements StateStore {
	private readonly statePath: string;
	private database: Database | null = null;
	private ready: Promise<void> | null = null;

	constructor(options: CreateStateStoreOptions = {}) {
		this.statePath = options.statePath ?? resolveAppPaths().statePath;
	}

	private async ensureDatabase(): Promise<Database> {
		if (this.database) {
			return this.database;
		}

		if (!this.ready) {
			this.ready = (async () => {
				await ensureSqliteFile(this.statePath);

				const database = new Database(this.statePath);
				database.exec("PRAGMA journal_mode = WAL");
				ensureMigrations(database);
				this.database = database;
			})();
		}

		await this.ready;
		if (!this.database) {
			throw new Error("State database failed to initialize.");
		}

		return this.database;
	}

	private async queryOne<T>(
		sql: string,
		args: SqlBindings = [],
	): Promise<T | undefined> {
		const database = await this.ensureDatabase();
		return (
			database.query(sql) as unknown as {
				get(bindings: SqlBindings): T | undefined;
			}
		).get(args);
	}

	private async execute(sql: string, args: SqlBindings = []): Promise<void> {
		const database = await this.ensureDatabase();
		database.run(sql, args);
	}

	async getCursor(integrationId: string): Promise<string | null> {
		const row = await this.queryOne<CursorRow>(
			"SELECT cursor_value FROM integration_state WHERE integration_id = ?",
			[integrationId],
		);
		return row?.cursor_value ?? null;
	}

	async setCursor(integrationId: string, cursor: string | null): Promise<void> {
		await this.execute(
			`
        INSERT INTO integration_state (integration_id, cursor_value, last_sync_at)
        VALUES (?, ?, NULL)
        ON CONFLICT(integration_id) DO UPDATE SET cursor_value = excluded.cursor_value
      `,
			[integrationId, cursor],
		);
	}

	async getLastSyncAt(integrationId: string): Promise<string | null> {
		const row = await this.queryOne<LastSyncRow>(
			"SELECT last_sync_at FROM integration_state WHERE integration_id = ?",
			[integrationId],
		);
		return row?.last_sync_at ?? null;
	}

	async setLastSyncAt(integrationId: string, value: string): Promise<void> {
		await this.execute(
			`
        INSERT INTO integration_state (integration_id, cursor_value, last_sync_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(integration_id) DO UPDATE SET last_sync_at = excluded.last_sync_at
      `,
			[integrationId, value],
		);
	}

	async resetIntegration(integrationId: string): Promise<SourceRecord[]> {
		const database = await this.ensureDatabase();
		const deletedRecords = (
			database.query(
				`
          SELECT integration_id, connector_id, source_id, entity_type, relative_path, source_hash, render_version, snapshot_hash, source_updated_at, last_rendered_at
          FROM document_records
          WHERE integration_id = ?
        `,
			) as unknown as {
				all(bindings: SqlBindings): SourceRecordRow[];
			}
		).all([integrationId]);

		try {
			database.exec("BEGIN IMMEDIATE");
			database.run("DELETE FROM source_snapshots WHERE integration_id = ?", [
				integrationId,
			]);
			database.run("DELETE FROM document_records WHERE integration_id = ?", [
				integrationId,
			]);
			database.run("DELETE FROM integration_state WHERE integration_id = ?", [
				integrationId,
			]);
			database.exec("COMMIT");
		} catch (error) {
			if (database.inTransaction) {
				database.exec("ROLLBACK");
			}
			throw error;
		}

		return deletedRecords.map(toSourceRecord);
	}

	async getSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<SourceRecord | null> {
		const row = await this.queryOne<SourceRecordRow>(
			`
        SELECT integration_id, connector_id, source_id, entity_type, relative_path, source_hash, render_version, snapshot_hash, source_updated_at, last_rendered_at
        FROM document_records
        WHERE integration_id = ? AND source_id = ?
      `,
			[integrationId, sourceId],
		);

		if (!row) {
			return null;
		}

		return toSourceRecord(row);
	}

	async listSourceRecords(integrationId: string): Promise<SourceRecord[]> {
		const database = await this.ensureDatabase();
		const rows = (
			database.query(
				`
          SELECT integration_id, connector_id, source_id, entity_type, relative_path, source_hash, render_version, snapshot_hash, source_updated_at, last_rendered_at
          FROM document_records
          WHERE integration_id = ?
          ORDER BY source_id ASC
        `,
			) as unknown as {
				all(bindings: SqlBindings): SourceRecordRow[];
			}
		).all([integrationId]);

		return rows.map(toSourceRecord);
	}

	async upsertSourceRecord(record: SourceRecord): Promise<void> {
		await this.execute(
			`
        INSERT INTO document_records (integration_id, connector_id, source_id, entity_type, relative_path, source_hash, render_version, snapshot_hash, source_updated_at, last_rendered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(integration_id, source_id) DO UPDATE SET
          connector_id = excluded.connector_id,
          entity_type = excluded.entity_type,
          relative_path = excluded.relative_path,
          source_hash = excluded.source_hash,
          render_version = excluded.render_version,
          snapshot_hash = excluded.snapshot_hash,
          last_rendered_at = excluded.last_rendered_at,
          source_updated_at = excluded.source_updated_at
      `,
			[
				record.integrationId,
				record.connectorId,
				record.sourceId,
				record.entityType,
				record.relativePath,
				record.sourceHash,
				record.renderVersion,
				record.snapshotHash,
				record.sourceUpdatedAt ?? null,
				record.lastRenderedAt ?? null,
			],
		);
	}

	async deleteSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		await this.execute(
			"DELETE FROM document_records WHERE integration_id = ? AND source_id = ?",
			[integrationId, sourceId],
		);
	}

	async getSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<StoredSourceSnapshot | null> {
		const row = await this.queryOne<SourceSnapshotRow>(
			`
        SELECT integration_id, connector_id, source_id, snapshot_hash, snapshot_schema_version, payload_json
        FROM source_snapshots
        WHERE integration_id = ? AND source_id = ?
      `,
			[integrationId, sourceId],
		);

		if (!row) {
			return null;
		}

		return {
			integrationId: row.integration_id,
			connectorId: row.connector_id,
			sourceId: row.source_id,
			snapshotHash: row.snapshot_hash,
			snapshotSchemaVersion: row.snapshot_schema_version,
			payload: JSON.parse(row.payload_json) as SourceSnapshot,
		};
	}

	async upsertSourceSnapshot(snapshot: StoredSourceSnapshot): Promise<void> {
		await this.execute(
			`
        INSERT INTO source_snapshots (integration_id, connector_id, source_id, snapshot_hash, snapshot_schema_version, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(integration_id, source_id) DO UPDATE SET
          connector_id = excluded.connector_id,
          snapshot_hash = excluded.snapshot_hash,
          snapshot_schema_version = excluded.snapshot_schema_version,
          payload_json = excluded.payload_json
      `,
			[
				snapshot.integrationId,
				snapshot.connectorId,
				snapshot.sourceId,
				snapshot.snapshotHash,
				snapshot.snapshotSchemaVersion,
				JSON.stringify(snapshot.payload),
			],
		);
	}

	async deleteSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		await this.execute(
			"DELETE FROM source_snapshots WHERE integration_id = ? AND source_id = ?",
			[integrationId, sourceId],
		);
	}

	async describe(): Promise<string[]> {
		const integrationStateCount = await this.queryOne<CountRow>(
			"SELECT COUNT(*) AS count FROM integration_state",
		);
		const documentCount = await this.queryOne<CountRow>(
			"SELECT COUNT(*) AS count FROM document_records",
		);
		const snapshotCount = await this.queryOne<CountRow>(
			"SELECT COUNT(*) AS count FROM source_snapshots",
		);
		const migrationCount = await this.queryOne<CountRow>(
			`SELECT COUNT(*) AS count FROM ${MIGRATIONS_TABLE}`,
		);

		return [
			"sqlite-backed state store (drizzle SQL migrations)",
			`tracked_documents=${toCount(documentCount?.count ?? 0)}`,
			`tracked_snapshots=${toCount(snapshotCount?.count ?? 0)}`,
			`tracked_integrations=${toCount(integrationStateCount?.count ?? 0)}`,
			`applied_migrations=${toCount(migrationCount?.count ?? 0)}`,
		];
	}
}

export function createStateStore(
	options: CreateStateStoreOptions = {},
): StateStore {
	return new BunSqliteStateStore(options);
}
