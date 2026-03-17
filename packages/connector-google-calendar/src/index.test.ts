import { expect, test } from "bun:test";

import type {
	ConnectorSyncRequest,
	GoogleResolvedAuth,
	SourceRecord,
	StoredSourceSnapshot,
} from "@syncdown/core";
import { MemoryStateStore } from "../../core/src/test-support.js";
import { createGoogleCalendarConnector } from "./index.js";

function createRequest(
	options: {
		since?: string | null;
		selectedCalendarIds?: string[];
		resolvedAuth?: GoogleResolvedAuth | null;
		existingSourceIds?: string[];
	},
	overrides: Partial<ConnectorSyncRequest> = {},
): ConnectorSyncRequest {
	const state = new MemoryStateStore();
	for (const sourceId of options.existingSourceIds ?? []) {
		void state.upsertSourceRecord({
			integrationId: "google-calendar-integration",
			connectorId: "google-calendar",
			sourceId,
			entityType: "event",
			relativePath: `google-calendar/default/${sourceId}.md`,
			sourceHash: `hash-${sourceId}`,
			renderVersion: "test",
			snapshotHash: `snapshot-${sourceId}`,
			lastRenderedAt: "2026-03-17T00:00:00.000Z",
		} satisfies SourceRecord);
		void state.upsertSourceSnapshot({
			integrationId: "google-calendar-integration",
			connectorId: "google-calendar",
			sourceId,
			snapshotHash: `snapshot-${sourceId}`,
			snapshotSchemaVersion: "1",
			payload: {
				integrationId: "google-calendar-integration",
				connectorId: "google-calendar",
				sourceId,
				entityType: "event",
				title: sourceId,
				slug: sourceId,
				pathHint: { kind: "calendar-event", calendarName: "Default" },
				metadata: {},
				bodyMd: "",
				sourceHash: `hash-${sourceId}`,
				snapshotSchemaVersion: "1",
			},
		} satisfies StoredSourceSnapshot);
	}

	const writes: string[] = [];
	const deleted: string[] = [];
	const persisted: string[] = [];

	return {
		config: {
			oauthApps: [],
			connections: [],
			integrations: [
				{
					id: "google-calendar-integration",
					connectorId: "google-calendar",
					connectionId: "google-account-default",
					label: "Google Calendar",
					enabled: true,
					interval: "1h",
					config: {
						selectedCalendarIds: options.selectedCalendarIds ?? ["primary"],
					},
				},
			],
		},
		integration: {
			id: "google-calendar-integration",
			connectorId: "google-calendar",
			connectionId: "google-account-default",
			label: "Google Calendar",
			enabled: true,
			interval: "1h",
			config: {
				selectedCalendarIds: options.selectedCalendarIds ?? ["primary"],
			},
		},
		connection: {
			id: "google-account-default",
			kind: "google-account",
			label: "Default Google Account",
			oauthAppId: "google-default",
		},
		io: {
			write(line) {
				writes.push(line);
			},
			error(line) {
				writes.push(`ERR:${line}`);
			},
		},
		paths: {
			configDir: "/tmp/config",
			dataDir: "/tmp/data",
			configPath: "/tmp/config/config.json",
			statePath: "/tmp/data/state.db",
			secretsPath: "/tmp/data/secrets.enc",
			masterKeyPath: "/tmp/data/master.key",
			lockPath: "/tmp/data/sync.lock",
		},
		since: options.since ?? null,
		renderVersion: "test",
		secrets: {
			async hasSecret() {
				return true;
			},
			async getSecret() {
				return "secret";
			},
			async setSecret() {},
			async deleteSecret() {},
			describe() {
				return "memory";
			},
		},
		state,
		resolvedAuth:
			options.resolvedAuth ??
			({
				kind: "google-oauth",
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "refresh-token",
				requiredScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
			} satisfies GoogleResolvedAuth),
		throwIfCancelled() {},
		async persistSource(source) {
			persisted.push(source.sourceId);
		},
		async deleteSource(sourceId) {
			deleted.push(sourceId);
		},
		async resetIntegrationState() {},
		setProgress() {},
		...overrides,
	};
}

test("google calendar initial sync persists selected calendar events and encodes per-calendar tokens", async () => {
	const connector = createGoogleCalendarConnector({
		adapter: {
			async listCalendars() {
				return [{ id: "primary", summary: "Primary Calendar", primary: true }];
			},
			async listEvents(_credentials, calendarId, options) {
				expect(calendarId).toBe("primary");
				expect(options.syncToken).toBeUndefined();
				return {
					events: [
						{
							id: "event-1",
							summary: "Weekly Review",
							description: "Agenda",
							start: { dateTime: "2026-03-17T09:00:00Z" },
							end: { dateTime: "2026-03-17T10:00:00Z" },
							updated: "2026-03-17T08:00:00Z",
							created: "2026-03-17T07:00:00Z",
							htmlLink: "https://calendar.google.com/event?eid=1",
						},
					],
					nextSyncToken: "sync-primary-v1",
				};
			},
		},
	});
	const persisted: string[] = [];
	const request = createRequest(
		{},
		{
			async persistSource(source) {
				persisted.push(source.sourceId);
			},
		},
	);

	const result = await connector.sync(request);
	expect(persisted).toEqual(["primary:event-1"]);
	expect(result.nextCursor).toBe(
		JSON.stringify({
			version: 1,
			selectedCalendarIds: ["primary"],
			syncTokens: { primary: "sync-primary-v1" },
		}),
	);
});

test("google calendar incremental sync deletes cancelled events and ignores recurring instances", async () => {
	const connector = createGoogleCalendarConnector({
		adapter: {
			async listCalendars() {
				return [{ id: "primary", summary: "Primary Calendar", primary: true }];
			},
			async listEvents() {
				return {
					events: [
						{
							id: "event-1",
							status: "cancelled",
						},
						{
							id: "child-instance",
							recurringEventId: "series-1",
							summary: "Child",
						},
						{
							id: "series-1",
							summary: "Series",
							recurrence: ["RRULE:FREQ=WEEKLY"],
							start: { date: "2026-03-17" },
							end: { date: "2026-03-18" },
						},
					],
					nextSyncToken: "next-sync",
				};
			},
		},
	});
	const deleted: string[] = [];
	const persisted: string[] = [];
	const request = createRequest(
		{
			since: JSON.stringify({
				version: 1,
				selectedCalendarIds: ["primary"],
				syncTokens: { primary: "cursor-1" },
			}),
		},
		{
			async deleteSource(sourceId) {
				deleted.push(sourceId);
			},
			async persistSource(source) {
				persisted.push(source.sourceId);
			},
		},
	);

	const result = await connector.sync(request);
	expect(deleted).toEqual(["primary:event-1"]);
	expect(persisted).toEqual(["primary:series-1"]);
	expect(result.nextCursor).toBe(
		JSON.stringify({
			version: 1,
			selectedCalendarIds: ["primary"],
			syncTokens: { primary: "next-sync" },
		}),
	);
});

test("google calendar purges deselected calendars only", async () => {
	const connector = createGoogleCalendarConnector({
		adapter: {
			async listCalendars() {
				return [{ id: "work", summary: "Work" }];
			},
			async listEvents() {
				return {
					events: [],
					nextSyncToken: "work-sync",
				};
			},
		},
	});
	const deleted: string[] = [];
	const request = createRequest(
		{
			selectedCalendarIds: ["work"],
			since: JSON.stringify({
				version: 1,
				selectedCalendarIds: ["primary", "work"],
				syncTokens: { primary: "old-primary", work: "old-work" },
			}),
			existingSourceIds: ["primary:old-1", "work:keep-1"],
		},
		{
			async deleteSource(sourceId) {
				deleted.push(sourceId);
			},
		},
	);

	const result = await connector.sync(request);
	expect(deleted).toEqual(["primary:old-1"]);
	expect(result.nextCursor).toBe(
		JSON.stringify({
			version: 1,
			selectedCalendarIds: ["work"],
			syncTokens: { work: "work-sync" },
		}),
	);
});

test("google calendar full sync deletes stale records for a selected calendar", async () => {
	const connector = createGoogleCalendarConnector({
		adapter: {
			async listCalendars() {
				return [{ id: "primary", summary: "Primary" }];
			},
			async listEvents() {
				return {
					events: [
						{
							id: "keep",
							summary: "Keep",
							start: { dateTime: "2026-03-17T09:00:00Z" },
							end: { dateTime: "2026-03-17T10:00:00Z" },
						},
					],
					nextSyncToken: "primary-sync",
				};
			},
		},
	});
	const deleted: string[] = [];
	const request = createRequest(
		{
			existingSourceIds: ["primary:keep", "primary:remove", "other:stay"],
		},
		{
			async deleteSource(sourceId) {
				deleted.push(sourceId);
			},
		},
	);

	await connector.sync(request);
	expect(deleted).toEqual(["primary:remove"]);
});
