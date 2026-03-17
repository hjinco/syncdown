CREATE TABLE `document_records` (
	`integration_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`source_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`relative_path` text NOT NULL,
	`source_hash` text NOT NULL,
	`render_version` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`source_updated_at` text,
	`last_rendered_at` text,
	PRIMARY KEY(`integration_id`, `source_id`)
);
--> statement-breakpoint
CREATE TABLE `integration_state` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`cursor_value` text,
	`last_sync_at` text
);
--> statement-breakpoint
CREATE TABLE `source_snapshots` (
	`integration_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`source_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`snapshot_schema_version` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`integration_id`, `source_id`)
);
