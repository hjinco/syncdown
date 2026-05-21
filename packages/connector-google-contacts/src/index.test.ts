import { expect, test } from "bun:test";

import type {
	ConnectorSyncRequest,
	GoogleResolvedAuth,
	SourceRecord,
	SourceSnapshot,
	StoredSourceSnapshot,
} from "@syncdown/core";
import { MemoryStateStore } from "../../core/src/test-support.js";
import {
	createGoogleContactsConnector,
	type GoogleContactGroup,
	type GoogleContactsAdapter,
	type GooglePerson,
} from "./index.js";

function createRequest(
	options: {
		since?: string | null;
		resolvedAuth?: GoogleResolvedAuth | null;
		existingSourceIds?: string[];
	},
	overrides: Partial<ConnectorSyncRequest> = {},
): ConnectorSyncRequest {
	const state = new MemoryStateStore();
	for (const sourceId of options.existingSourceIds ?? []) {
		void state.upsertSourceRecord({
			integrationId: "google-contacts-integration",
			connectorId: "google-contacts",
			sourceId,
			entityType: "contact",
			relativePath: `google-contacts/default/${sourceId}.md`,
			sourceHash: `hash-${sourceId}`,
			renderVersion: "test",
			snapshotHash: `snapshot-${sourceId}`,
			lastRenderedAt: "2026-03-17T00:00:00.000Z",
		} satisfies SourceRecord);
		void state.upsertSourceSnapshot({
			integrationId: "google-contacts-integration",
			connectorId: "google-contacts",
			sourceId,
			snapshotHash: `snapshot-${sourceId}`,
			snapshotSchemaVersion: "1",
			payload: {
				integrationId: "google-contacts-integration",
				connectorId: "google-contacts",
				sourceId,
				entityType: "contact",
				title: sourceId,
				slug: sourceId,
				pathHint: { kind: "contact" },
				metadata: {},
				bodyMd: "",
				sourceHash: `hash-${sourceId}`,
				snapshotSchemaVersion: "1",
			},
		} satisfies StoredSourceSnapshot);
	}

	return {
		config: {
			oauthApps: [],
			connections: [],
			integrations: [
				{
					id: "google-contacts-integration",
					connectorId: "google-contacts",
					connectionId: "google-account-default",
					label: "Google Contacts",
					enabled: true,
					interval: "1h",
					config: {},
				},
			],
		},
		integration: {
			id: "google-contacts-integration",
			connectorId: "google-contacts",
			connectionId: "google-account-default",
			label: "Google Contacts",
			enabled: true,
			interval: "1h",
			config: {},
		},
		connection: {
			id: "google-account-default",
			kind: "google-account",
			label: "Default Google Account",
			oauthAppId: "google-default",
		},
		io: {
			write() {},
			error() {},
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
				requiredScopes: ["https://www.googleapis.com/auth/contacts.readonly"],
			} satisfies GoogleResolvedAuth),
		throwIfCancelled() {},
		async persistSource() {},
		async deleteSource() {},
		async resetIntegrationState() {},
		setProgress() {},
		...overrides,
	};
}

function makeAdapter(options: {
	pages: Array<{
		connections: GooglePerson[];
		nextPageToken?: string;
		nextSyncToken?: string;
		invalidSyncToken?: boolean;
	}>;
	groups?: GoogleContactGroup[];
	ownerEmail?: string | null;
	observed?: {
		pageTokens: Array<string | undefined>;
		syncTokens: Array<string | undefined>;
	};
}): GoogleContactsAdapter {
	const queue = [...options.pages];
	return {
		async listConnections(_credentials, opts) {
			options.observed?.pageTokens.push(opts.pageToken);
			options.observed?.syncTokens.push(opts.syncToken);
			const page = queue.shift();
			if (!page) {
				return { connections: [] };
			}
			return page;
		},
		async listContactGroups() {
			return options.groups ?? [];
		},
		async getOwnerEmail() {
			return options.ownerEmail ?? "owner@example.com";
		},
	};
}

test("google contacts initial sync persists contacts and stores syncToken", async () => {
	const persisted: SourceSnapshot[] = [];
	const adapter = makeAdapter({
		pages: [
			{
				connections: [
					{
						resourceName: "people/c111",
						names: [{ displayName: "Alice Adams" }],
						emailAddresses: [{ value: "alice@example.com" }],
						phoneNumbers: [{ value: "+1 555 0100" }],
						organizations: [{ name: "Acme", title: "Engineer" }],
						memberships: [
							{
								contactGroupMembership: {
									contactGroupResourceName: "contactGroups/family",
								},
							},
						],
					},
				],
				nextSyncToken: "sync-v1",
			},
		],
		groups: [
			{
				resourceName: "contactGroups/family",
				name: "Family",
				groupType: "SYSTEM_CONTACT_GROUP",
			},
		],
	});
	const connector = createGoogleContactsConnector({ adapter });
	const request = createRequest(
		{},
		{
			async persistSource(snapshot) {
				persisted.push(snapshot);
			},
		},
	);

	const result = await connector.sync(request);
	expect(persisted).toHaveLength(1);
	const [snapshot] = persisted;
	expect(snapshot.sourceId).toBe("people/c111");
	expect(snapshot.title).toBe("Alice Adams");
	expect(snapshot.pathHint.kind).toBe("contact");
	expect(snapshot.pathHint.contactAccountEmail).toBe("owner@example.com");
	expect(snapshot.metadata.contactEmails).toEqual(["alice@example.com"]);
	expect(snapshot.metadata.contactPhones).toEqual(["+1 555 0100"]);
	expect(snapshot.metadata.contactOrganizations).toEqual(["Acme"]);
	expect(snapshot.metadata.contactTitles).toEqual(["Engineer"]);
	expect(snapshot.metadata.contactGroups).toEqual(["Family"]);
	expect(snapshot.metadata.contactSource).toBe("person");
	expect(snapshot.bodyMd).toContain("## Emails");
	expect(snapshot.bodyMd).toContain("alice@example.com");

	expect(result.nextCursor).toBe(
		JSON.stringify({
			version: 1,
			syncToken: "sync-v1",
			accountEmail: "owner@example.com",
		}),
	);
});

test("google contacts incremental sync deletes contacts flagged deleted", async () => {
	const persisted: string[] = [];
	const deleted: string[] = [];
	const adapter = makeAdapter({
		pages: [
			{
				connections: [
					{
						resourceName: "people/c222",
						metadata: { deleted: true },
					},
					{
						resourceName: "people/c333",
						names: [{ displayName: "Bob" }],
					},
				],
				nextSyncToken: "sync-v2",
			},
		],
	});
	const connector = createGoogleContactsConnector({ adapter });
	const request = createRequest(
		{
			since: JSON.stringify({
				version: 1,
				syncToken: "sync-v1",
				accountEmail: "owner@example.com",
			}),
		},
		{
			async deleteSource(sourceId) {
				deleted.push(sourceId);
			},
			async persistSource(snapshot) {
				persisted.push(snapshot.sourceId);
			},
		},
	);

	const result = await connector.sync(request);
	expect(deleted).toEqual(["people/c222"]);
	expect(persisted).toEqual(["people/c333"]);
	expect(result.nextCursor).toContain('"syncToken":"sync-v2"');
});

test("google contacts handles expired sync token by rebuilding from scratch", async () => {
	const persisted: string[] = [];
	const adapter = makeAdapter({
		pages: [
			{ connections: [], invalidSyncToken: true },
			{
				connections: [
					{
						resourceName: "people/c444",
						names: [{ displayName: "Carol" }],
					},
				],
				nextSyncToken: "sync-v3",
			},
		],
	});
	const connector = createGoogleContactsConnector({ adapter });
	const request = createRequest(
		{
			since: JSON.stringify({
				version: 1,
				syncToken: "stale",
				accountEmail: "owner@example.com",
			}),
		},
		{
			async persistSource(snapshot) {
				persisted.push(snapshot.sourceId);
			},
		},
	);

	const result = await connector.sync(request);
	expect(persisted).toEqual(["people/c444"]);
	expect(result.nextCursor).toContain('"syncToken":"sync-v3"');
});

test("google contacts picks fallback title from email when name missing", async () => {
	const persisted: SourceSnapshot[] = [];
	const adapter = makeAdapter({
		pages: [
			{
				connections: [
					{
						resourceName: "people/c555",
						emailAddresses: [{ value: "no-name@example.com" }],
					},
				],
				nextSyncToken: "sync-v1",
			},
		],
	});
	const connector = createGoogleContactsConnector({ adapter });
	const request = createRequest(
		{},
		{
			async persistSource(snapshot) {
				persisted.push(snapshot);
			},
		},
	);

	await connector.sync(request);
	expect(persisted[0].title).toBe("no-name@example.com");
});
