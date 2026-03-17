import { expect, test } from "bun:test";

import type { SourceSnapshot } from "@syncdown/core";

import { stringifyFrontmatter } from "./frontmatter.js";

function createNotionSnapshot(): SourceSnapshot {
	return {
		integrationId: "11111111-1111-4111-8111-111111111111",
		connectorId: "notion",
		sourceId: "page-123",
		entityType: "page",
		title: "Roadmap",
		slug: "",
		pathHint: { kind: "database", databaseName: "Projects" },
		metadata: {
			createdAt: "2026-03-15T12:00:00.000Z",
			updatedAt: "2026-03-16T12:00:00.000Z",
			sourceUrl: "https://notion.so/page-123",
			notionDatabase: "Projects",
			notionProperties: {
				title: "Property Title",
				Source: "https://example.com/property-source",
				Created: "2026-03-01T00:00:00.000Z",
			},
		},
		bodyMd: "Done body",
		sourceHash: "hash-page-123",
		snapshotSchemaVersion: "1",
	};
}

test("stringifyFrontmatter keeps the document heading while notion properties overwrite frontmatter fields", () => {
	const document = stringifyFrontmatter(createNotionSnapshot());

	expect(document).toMatch(/^title: "Property Title"$/m);
	expect(document).toMatch(
		/^source: "https:\/\/example\.com\/property-source"$/m,
	);
	expect(document).toMatch(/^created: "2026-03-01T00:00:00\.000Z"$/m);
	expect(document).toMatch(/^# Roadmap$/m);
});
