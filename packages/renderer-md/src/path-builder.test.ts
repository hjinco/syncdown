import { expect, test } from "bun:test";

import type { SourceSnapshot } from "@syncdown/core";

import { buildRelativePath } from "./path-builder.js";

function createSnapshot(overrides: Partial<SourceSnapshot>): SourceSnapshot {
	return {
		integrationId: "integration-1",
		connectorId: "gmail",
		sourceId: "source-1",
		entityType: "message",
		title: "Launch Status Update",
		slug: "",
		pathHint: { kind: "message", gmailAccountEmail: "Owner@Example.com" },
		metadata: {},
		bodyMd: "Hello world",
		sourceHash: "hash-source-1",
		snapshotSchemaVersion: "1",
		...overrides,
	};
}

test("buildRelativePath uses unknown buckets for gmail documents without createdAt", () => {
	const document = createSnapshot({
		connectorId: "gmail",
		sourceId: "msg-123",
		pathHint: { kind: "message", gmailAccountEmail: "Owner@Example.com" },
	});

	expect(buildRelativePath(document)).toBe(
		"gmail/owner-example-com/unknown/unknown/launch-status-update-msg-123.md",
	);
});

test("buildRelativePath falls back to createdAt for calendar buckets", () => {
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: "primary:event-123",
		entityType: "event",
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2026-03-17T07:00:00.000Z",
			calendarEventId: "event-123",
		},
	});

	expect(buildRelativePath(document)).toBe(
		"google-calendar/primary-calendar/2026/03/launch-status-update-event-123.md",
	);
});

test("buildRelativePath falls back to sourceId when calendarEventId is missing", () => {
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: "primary:event-123",
		entityType: "event",
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2026-03-17T07:00:00.000Z",
		},
	});

	expect(buildRelativePath(document)).toBe(
		"google-calendar/primary-calendar/2026/03/launch-status-update-primary:event-123.md",
	);
});

test("buildRelativePath routes notion database items under databases folders", () => {
	const document = createSnapshot({
		connectorId: "notion",
		sourceId: "page-123",
		entityType: "page",
		title: "Roadmap",
		pathHint: { kind: "database", databaseName: "Projects" },
	});

	expect(buildRelativePath(document)).toBe(
		"notion/databases/projects/roadmap-page-123.md",
	);
});

test("buildRelativePath routes non-database notion pages under pages folders", () => {
	const document = createSnapshot({
		connectorId: "notion",
		sourceId: "page-999",
		entityType: "page",
		title: "Overview",
		pathHint: { kind: "page" },
	});

	expect(buildRelativePath(document)).toBe("notion/pages/overview-page-999.md");
});
