import { expect, test } from "bun:test";

import type { SourceSnapshot } from "@syncdown/core";

import { createMarkdownRenderer } from "./index.js";

const NOTION_INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const GMAIL_INTEGRATION_ID = "22222222-2222-4222-8222-222222222222";
const CALENDAR_INTEGRATION_ID = "33333333-3333-4333-8333-333333333333";

function createGmailSnapshot(): SourceSnapshot {
	return {
		integrationId: GMAIL_INTEGRATION_ID,
		connectorId: "gmail",
		sourceId: "msg-123",
		entityType: "message",
		title: "Launch Status Update",
		slug: "",
		pathHint: {
			kind: "message",
			gmailAccountEmail: "Owner@Example.com",
		},
		metadata: {
			createdAt: "2026-03-16T12:34:56.000Z",
			updatedAt: "2026-03-16T12:34:56.000Z",
			sourceUrl: "https://mail.google.com/mail/u/0/#inbox/msg-123",
			gmailThreadId: "thread-123",
			gmailLabelIds: ["INBOX", "IMPORTANT"],
			gmailAccountEmail: "Owner@Example.com",
			gmailFrom: "Sender <sender@example.com>",
			gmailTo: ["Team <team@example.com>"],
			gmailCc: ["Cc <cc@example.com>"],
			gmailSnippet: "Preview text",
		},
		bodyMd: "Hello world",
		sourceHash: "hash-msg-123",
		snapshotSchemaVersion: "1",
	};
}

function createNotionSnapshot(): SourceSnapshot {
	return {
		integrationId: NOTION_INTEGRATION_ID,
		connectorId: "notion",
		sourceId: "page-123",
		entityType: "page",
		title: "Roadmap",
		slug: "",
		pathHint: { kind: "database", databaseName: "Projects" },
		metadata: {
			archived: true,
			createdAt: "2026-03-15T12:00:00.000Z",
			updatedAt: "2026-03-16T12:00:00.000Z",
			sourceUrl: "https://notion.so/page-123",
			notionParentType: "database",
			notionDatabase: "Projects",
			notionProperties: {
				Status: "Done",
			},
		},
		bodyMd: "Done body",
		sourceHash: "hash-page-123",
		snapshotSchemaVersion: "1",
	};
}

function createCalendarSnapshot(): SourceSnapshot {
	return {
		integrationId: CALENDAR_INTEGRATION_ID,
		connectorId: "google-calendar",
		sourceId: "primary:event-123",
		entityType: "event",
		title: "Weekly Review",
		slug: "",
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			sourceUrl: "https://calendar.google.com/event?eid=123",
			createdAt: "2026-03-17T07:00:00.000Z",
			updatedAt: "2026-03-17T08:00:00.000Z",
			calendarId: "primary",
			calendarName: "Primary Calendar",
			calendarEventId: "event-123",
			calendarEventStatus: "confirmed",
			calendarStartAt: "2026-03-17T09:00:00.000Z",
			calendarEndAt: "2026-03-17T10:00:00.000Z",
			calendarAllDay: false,
			calendarLocation: "Zoom",
			calendarOrganizer: "Alice <alice@example.com>",
			calendarAttendees: ["Bob <bob@example.com>", "Carol <carol@example.com>"],
			calendarRecurrence: ["RRULE:FREQ=WEEKLY"],
		},
		bodyMd: "Agenda",
		sourceHash: "hash-event-123",
		snapshotSchemaVersion: "1",
	};
}

test("gmail message paths render under account, year, and month folders", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render(createGmailSnapshot());

	expect(document.relativePath).toBe(
		"gmail/owner-example-com/2026/03/launch-status-update-msg-123.md",
	);
});

test("renderer exposes connector-specific versions", () => {
	const renderer = createMarkdownRenderer();

	expect(renderer.getVersion("notion")).toBe("1");
	expect(renderer.getVersion("gmail")).toBe("1");
	expect(renderer.getVersion("google-calendar")).toBe("1");
});

test("calendar paths use event ids for filenames when available", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render(createCalendarSnapshot());

	expect(document.relativePath).toBe(
		"google-calendar/primary-calendar/2026/03/weekly-review-event-123.md",
	);
});

test("notion database item paths omit integration ids", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render(createNotionSnapshot());

	expect(document.relativePath).toBe(
		"notion/databases/projects/roadmap-page-123.md",
	);
});

test("gmail frontmatter includes gmail metadata fields", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render(createGmailSnapshot());

	expect(document.contents).not.toMatch(/^archived:/m);
	expect(document.contents).not.toMatch(/^integration_id:/m);
	expect(document.contents).not.toMatch(/^source_id:/m);
	expect(document.contents).not.toMatch(/^gmail_thread_id:/m);
	expect(document.contents).not.toMatch(/^gmail_label_ids:/m);
	expect(document.contents).toMatch(
		/^source: "https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/msg-123"$/m,
	);
	expect(document.contents).toMatch(/^created: "2026-03-16T12:34:56\.000Z"$/m);
	expect(document.contents).toMatch(/^updated: "2026-03-16T12:34:56\.000Z"$/m);
	expect(document.contents).toMatch(/^account: "Owner@Example\.com"$/m);
	expect(document.contents).toMatch(/^from: "Sender <sender@example\.com>"$/m);
	expect(document.contents).toMatch(/^to:$/m);
	expect(document.contents).toMatch(/^ {2}- "Team <team@example\.com>"$/m);
	expect(document.contents).toMatch(/^cc:$/m);
	expect(document.contents).toMatch(/^ {2}- "Cc <cc@example\.com>"$/m);
	expect(document.contents).toMatch(/^snippet: "Preview text"$/m);
});

test("gmail account path segments are slugified from the raw email", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render({
		...createGmailSnapshot(),
		pathHint: {
			kind: "message",
			gmailAccountEmail: " User.Name+Alias@Example.COM ",
		},
		metadata: {
			...createGmailSnapshot().metadata,
			gmailAccountEmail: " User.Name+Alias@Example.COM ",
		},
	});

	expect(document.relativePath).toBe(
		"gmail/user-name-alias-example-com/2026/03/launch-status-update-msg-123.md",
	);
});

test("notion frontmatter excludes archived while keeping notion metadata fields", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render(createNotionSnapshot());

	expect(document.contents).not.toMatch(/^archived:/m);
	expect(document.contents).not.toMatch(/^integration_id:/m);
	expect(document.contents).not.toMatch(/^source_id:/m);
	expect(document.contents).not.toMatch(/^notion_parent_type:/m);
	expect(document.contents).not.toMatch(/^properties:$/m);
	expect(document.contents).toMatch(
		/^source: "https:\/\/notion\.so\/page-123"$/m,
	);
	expect(document.contents).toMatch(/^created: "2026-03-15T12:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^updated: "2026-03-16T12:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^database: "Projects"$/m);
	expect(document.contents).toMatch(/^status: "Done"$/m);
});

test("notion frontmatter flattens normalized property keys", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render({
		...createNotionSnapshot(),
		metadata: {
			...createNotionSnapshot().metadata,
			notionProperties: {
				"Due Date!": "2026-03-17",
				"담당자 이름": "홍길동",
				"Review/Status": "Ready",
				"   ": "skip-me",
				Schedule: {
					start: "2026-03-17",
					end: "2026-03-20",
				},
			},
		},
	});

	expect(document.contents).toMatch(/^due_date: "2026-03-17"$/m);
	expect(document.contents).toMatch(/^담당자_이름: "홍길동"$/m);
	expect(document.contents).toMatch(/^review_status: "Ready"$/m);
	expect(document.contents).toMatch(/^schedule:$/m);
	expect(document.contents).toMatch(/^ {2}"start": "2026-03-17"$/m);
	expect(document.contents).toMatch(/^ {2}"end": "2026-03-20"$/m);
	expect(document.contents).not.toContain("skip-me");
});

test("notion property collisions overwrite frontmatter fields only", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render({
		...createNotionSnapshot(),
		metadata: {
			...createNotionSnapshot().metadata,
			notionProperties: {
				title: "Property Title",
				Source: "https://example.com/property-source",
				Created: "2026-03-01T00:00:00.000Z",
			},
		},
	});

	expect(document.relativePath).toBe(
		"notion/databases/projects/roadmap-page-123.md",
	);
	expect(document.title).toBe("Roadmap");
	expect(document.contents).toMatch(/^title: "Property Title"$/m);
	expect(document.contents).toMatch(
		/^source: "https:\/\/example\.com\/property-source"$/m,
	);
	expect(document.contents).toMatch(/^created: "2026-03-01T00:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^# Roadmap$/m);
});

test("calendar frontmatter stays user-facing without syncdown namespacing", () => {
	const renderer = createMarkdownRenderer();
	const document = renderer.render(createCalendarSnapshot());

	expect(document.contents).toMatch(
		/^source: "https:\/\/calendar\.google\.com\/event\?eid=123"$/m,
	);
	expect(document.contents).toMatch(/^created: "2026-03-17T07:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^updated: "2026-03-17T08:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^calendar: "Primary Calendar"$/m);
	expect(document.contents).toMatch(/^status: "confirmed"$/m);
	expect(document.contents).toMatch(/^start: "2026-03-17T09:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^end: "2026-03-17T10:00:00\.000Z"$/m);
	expect(document.contents).toMatch(/^all_day: false$/m);
	expect(document.contents).toMatch(/^location: "Zoom"$/m);
	expect(document.contents).toMatch(
		/^organizer: "Alice <alice@example\.com>"$/m,
	);
	expect(document.contents).toMatch(/^attendees:$/m);
	expect(document.contents).toMatch(/^ {2}- "Bob <bob@example\.com>"$/m);
	expect(document.contents).toMatch(/^ {2}- "Carol <carol@example\.com>"$/m);
	expect(document.contents).toMatch(/^recurrence:$/m);
	expect(document.contents).toMatch(/^ {2}- "RRULE:FREQ=WEEKLY"$/m);
	expect(document.contents).not.toMatch(/^syncdown:$/m);
	expect(document.contents).not.toMatch(/^calendar_id:/m);
	expect(document.contents).not.toMatch(/^event_status:/m);
});
