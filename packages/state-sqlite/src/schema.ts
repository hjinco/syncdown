import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const integrationState = sqliteTable("integration_state", {
	integrationId: text("integration_id").primaryKey(),
	cursorValue: text("cursor_value"),
	lastSyncAt: text("last_sync_at"),
});

export const documentRecords = sqliteTable(
	"document_records",
	{
		integrationId: text("integration_id").notNull(),
		connectorId: text("connector_id").notNull(),
		sourceId: text("source_id").notNull(),
		entityType: text("entity_type").notNull(),
		relativePath: text("relative_path").notNull(),
		sourceHash: text("source_hash").notNull(),
		renderVersion: text("render_version").notNull(),
		snapshotHash: text("snapshot_hash").notNull(),
		sourceUpdatedAt: text("source_updated_at"),
		lastRenderedAt: text("last_rendered_at"),
	},
	(table) => [primaryKey({ columns: [table.integrationId, table.sourceId] })],
);

export const sourceSnapshots = sqliteTable(
	"source_snapshots",
	{
		integrationId: text("integration_id").notNull(),
		connectorId: text("connector_id").notNull(),
		sourceId: text("source_id").notNull(),
		snapshotHash: text("snapshot_hash").notNull(),
		snapshotSchemaVersion: text("snapshot_schema_version").notNull(),
		payloadJson: text("payload_json").notNull(),
	},
	(table) => [primaryKey({ columns: [table.integrationId, table.sourceId] })],
);
