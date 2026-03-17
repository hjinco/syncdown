import type { SourceSnapshot } from "@syncdown/core";

import type {
	NotionDataSource,
	NotionDateValue,
	NotionFormulaValue,
	NotionPage,
	NotionParent,
	NotionPropertyValue,
	NotionRichText,
	NotionUser,
} from "./notion-types.js";

export const NOTION_SNAPSHOT_SCHEMA_VERSION = "1";

function extractPlainText(chunks: NotionRichText[] | undefined): string {
	return (chunks ?? [])
		.map((chunk) => chunk.plain_text ?? "")
		.join("")
		.trim();
}

function extractTitle(page: NotionPage): string {
	for (const property of Object.values(page.properties)) {
		if (property.type === "title") {
			const value = extractPlainText(property.title);
			if (value.length > 0) {
				return value;
			}
		}
	}

	return "Untitled";
}

export function extractDataSourceTitle(dataSource: NotionDataSource): string {
	return (
		dataSource.name?.trim() ||
		extractPlainText(dataSource.title) ||
		"untitled-database"
	);
}

type FormulaNormalizer = (value: NotionFormulaValue) => unknown;
type RollupNormalizer = (
	value: NonNullable<NotionPropertyValue["rollup"]>,
) => unknown;
type PropertyNormalizer = (property: NotionPropertyValue) => unknown;

function normalizeDate(
	value: NotionDateValue | null | undefined,
): string | Record<string, string> | null {
	if (!value) {
		return null;
	}

	if (!value.end) {
		return value.start;
	}

	return {
		start: value.start,
		end: value.end,
	};
}

function normalizeUser(user: NotionUser | null | undefined): string {
	if (!user) {
		return "";
	}

	return user.name?.trim() || user.id;
}

const formulaNormalizers: Record<string, FormulaNormalizer> = {
	string: (value) => value.string ?? null,
	number: (value) => value.number ?? null,
	boolean: (value) => value.boolean ?? null,
	date: (value) => normalizeDate(value.date),
};

function normalizeFormula(value: NotionFormulaValue | undefined): unknown {
	if (!value) {
		return null;
	}

	return formulaNormalizers[value.type]?.(value) ?? null;
}

const rollupNormalizers: Record<string, RollupNormalizer> = {
	number: (value) => value.number ?? null,
	date: (value) => normalizeDate(value.date),
	array: (value) =>
		(value.array ?? []).map((entry) => normalizePropertyValue(entry)),
};

function normalizeRollup(value: NotionPropertyValue["rollup"]): unknown {
	if (!value) {
		return null;
	}

	return rollupNormalizers[value.type]?.(value) ?? null;
}

const propertyNormalizers: Record<string, PropertyNormalizer> = {
	title: (property) => extractPlainText(property.title),
	rich_text: (property) => extractPlainText(property.rich_text),
	number: (property) => property.number ?? null,
	checkbox: (property) => property.checkbox ?? false,
	url: (property) => property.url ?? null,
	email: (property) => property.email ?? null,
	phone_number: (property) => property.phone_number ?? null,
	select: (property) => property.select?.name ?? null,
	multi_select: (property) =>
		(property.multi_select ?? []).map((option) => option.name),
	status: (property) => property.status?.name ?? null,
	date: (property) => normalizeDate(property.date),
	people: (property) =>
		(property.people ?? []).map((user) => normalizeUser(user)).filter(Boolean),
	files: (property) =>
		(property.files ?? [])
			.map((file) => file.url || file.name || "")
			.filter(Boolean),
	relation: (property) =>
		(property.relation ?? []).map((relation) => relation.id),
	formula: (property) => normalizeFormula(property.formula),
	created_time: (property) => property.created_time ?? null,
	last_edited_time: (property) => property.last_edited_time ?? null,
	created_by: (property) => normalizeUser(property.created_by),
	last_edited_by: (property) => normalizeUser(property.last_edited_by),
	unique_id: (property) =>
		!property.unique_id
			? null
			: property.unique_id.prefix
				? `${property.unique_id.prefix}-${property.unique_id.number}`
				: property.unique_id.number,
	verification: (property) =>
		!property.verification
			? null
			: {
					state: property.verification.state ?? null,
					verified_by: normalizeUser(property.verification.verified_by),
					date: normalizeDate(property.verification.date),
				},
	rollup: (property) => normalizeRollup(property.rollup),
};

function normalizePropertyValue(property: NotionPropertyValue): unknown {
	return propertyNormalizers[property.type]?.(property) ?? null;
}

function normalizeProperties(
	properties: Record<string, NotionPropertyValue>,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [name, property] of Object.entries(properties)) {
		normalized[name] = normalizePropertyValue(property);
	}
	return normalized;
}

function toParentType(parent: NotionParent): "page" | "database" | "workspace" {
	if (parent.type === "data_source_id" || parent.type === "database_id") {
		return "database";
	}

	if (parent.type === "workspace") {
		return "workspace";
	}

	return "page";
}

function isArchived(page: NotionPage): boolean {
	return Boolean(page.in_trash ?? page.archived);
}

function sanitizeMarkdown(markdown: string): string {
	return markdown.replace(/<unknown\b[^>]*\/>/g, "").trim();
}

function hashDocumentPayload(value: unknown): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(value))
		.digest("hex");
}

export function toSourceId(pageId: string): string {
	return pageId.replace(/-/g, "");
}

export function toSourceSnapshot(
	integrationId: string,
	page: NotionPage,
	markdown: string,
	dataSourceNames: Map<string, string>,
): SourceSnapshot {
	const title = extractTitle(page);
	const notionDatabase =
		page.parent.type === "data_source_id"
			? (dataSourceNames.get(page.parent.data_source_id ?? "") ??
				"untitled-database")
			: page.parent.type === "database_id"
				? (dataSourceNames.get(page.parent.database_id ?? "") ??
					"untitled-database")
				: undefined;

	const metadata = {
		sourceUrl: page.public_url ?? page.url,
		createdAt: page.created_time,
		updatedAt: page.last_edited_time,
		archived: isArchived(page),
		notionParentType: toParentType(page.parent),
		notionDatabase,
		notionProperties: normalizeProperties(page.properties),
	} as const;

	return {
		integrationId,
		connectorId: "notion",
		sourceId: toSourceId(page.id),
		entityType: "page",
		title,
		slug: "",
		pathHint:
			metadata.notionParentType === "database" && notionDatabase
				? { kind: "database", databaseName: notionDatabase }
				: { kind: "page" },
		metadata,
		bodyMd: sanitizeMarkdown(markdown),
		sourceHash: hashDocumentPayload({
			title,
			metadata,
			markdown,
		}),
		snapshotSchemaVersion: NOTION_SNAPSHOT_SCHEMA_VERSION,
	};
}
