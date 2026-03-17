import type {
	DataSourceObjectResponse,
	PageObjectResponse,
	PartialUserObjectResponse,
} from "@notionhq/client";

import type {
	NotionCandidatePage,
	NotionDataSource,
	NotionDateValue,
	NotionFile,
	NotionFormulaValue,
	NotionPage,
	NotionParent,
	NotionPropertyValue,
	NotionRichText,
	NotionUser,
} from "./notion-types.js";

type NotionApiPropertyValue = PageObjectResponse["properties"][string] & {
	title?: Array<{ plain_text: string }>;
	rich_text?: Array<{ plain_text: string }>;
	number?: number | null;
	checkbox?: boolean;
	url?: string | null;
	email?: string | null;
	phone_number?: string | null;
	select?: { name: string } | null;
	multi_select?: Array<{ name: string }>;
	status?: { name: string } | null;
	date?: { start: string; end?: string | null } | null;
	people?: PartialUserObjectResponse[];
	files?: unknown[];
	relation?: Array<{ id: string }>;
	formula?: unknown;
	created_time?: string;
	last_edited_time?: string;
	created_by?: PartialUserObjectResponse;
	last_edited_by?: PartialUserObjectResponse;
	unique_id?: { prefix?: string | null; number: number };
	verification?: {
		state?: string;
		verified_by?: PartialUserObjectResponse | null;
		date?: { start: string; end?: string | null } | null;
	} | null;
	rollup?: {
		type: string;
		number?: number | null;
		date?: { start: string; end?: string | null } | null;
		array?: Array<PageObjectResponse["properties"][string]>;
	};
};

type FormulaMapper = (
	value: NonNullable<NotionApiPropertyValue["formula"]> & { type: string },
) => NotionFormulaValue | undefined;
type PropertyMapper = (
	value: NotionApiPropertyValue,
	base: NotionPropertyValue,
) => NotionPropertyValue;
type ParentMapper = (parent: PageObjectResponse["parent"]) => NotionParent;

function extractPlainText(chunks: NotionRichText[] | undefined): string {
	return (chunks ?? [])
		.map((chunk) => chunk.plain_text ?? "")
		.join("")
		.trim();
}

function toNotionRichText(
	chunks: Array<{ plain_text: string }> | undefined,
): NotionRichText[] | undefined {
	return chunks?.map((chunk) => ({
		plain_text: chunk.plain_text,
	}));
}

function toNotionUser(user: unknown): NotionUser | undefined {
	if (!user || typeof user !== "object") {
		return undefined;
	}

	const value = user as { id?: unknown; name?: unknown };
	if (typeof value.id !== "string") {
		return undefined;
	}

	return {
		id: value.id,
		name: typeof value.name === "string" ? value.name : undefined,
	};
}

function toNotionDateValue(
	value: { start: string; end?: string | null } | null | undefined,
): NotionDateValue | null | undefined {
	if (!value) {
		return value;
	}

	return {
		start: value.start,
		end: value.end ?? null,
	};
}

function toNotionFile(file: unknown): NotionFile {
	const value = file as {
		name?: string;
		type?: string;
		external?: { url?: string };
		file?: { url?: string };
		file_upload?: { url?: string };
	};

	let url: string | null | undefined;
	switch (value.type) {
		case "external":
			url =
				typeof value.external?.url === "string"
					? value.external.url
					: undefined;
			break;
		case "file":
			url = typeof value.file?.url === "string" ? value.file.url : undefined;
			break;
		case "file_upload":
			url =
				typeof value.file_upload?.url === "string"
					? value.file_upload.url
					: undefined;
			break;
		default:
			url = undefined;
	}

	return {
		name: value.name,
		url,
	};
}

const formulaMappers: Record<string, FormulaMapper> = {
	string: (value) => ({
		type: value.type as "string",
		string: (value as { string?: string | null }).string ?? null,
	}),
	number: (value) => ({
		type: value.type as "number",
		number: (value as { number?: number | null }).number ?? null,
	}),
	boolean: (value) => ({
		type: value.type as "boolean",
		boolean: (value as { boolean?: boolean | null }).boolean ?? null,
	}),
	date: (value) => ({
		type: value.type as "date",
		date:
			toNotionDateValue(
				(value as { date?: { start: string; end?: string | null } | null })
					.date,
			) ?? null,
	}),
};

function toNotionFormulaValue(
	formula: unknown,
): NotionFormulaValue | undefined {
	const value = formula as
		| ({ type: string } & Record<string, unknown>)
		| undefined;

	if (!value) {
		return undefined;
	}

	return formulaMappers[value.type]?.(value) ?? undefined;
}

const propertyMappers: Record<string, PropertyMapper> = {
	title: (value, base) => ({ ...base, title: toNotionRichText(value.title) }),
	rich_text: (value, base) => ({
		...base,
		rich_text: toNotionRichText(value.rich_text),
	}),
	number: (value, base) => ({ ...base, number: value.number ?? null }),
	checkbox: (value, base) => ({ ...base, checkbox: value.checkbox ?? false }),
	url: (value, base) => ({ ...base, url: value.url ?? null }),
	email: (value, base) => ({ ...base, email: value.email ?? null }),
	phone_number: (value, base) => ({
		...base,
		phone_number: value.phone_number ?? null,
	}),
	select: (value, base) => ({
		...base,
		select: value.select ? { name: value.select.name } : null,
	}),
	multi_select: (value, base) => ({
		...base,
		multi_select: (value.multi_select ?? []).map((option) => ({
			name: option.name,
		})),
	}),
	status: (value, base) => ({
		...base,
		status: value.status ? { name: value.status.name } : null,
	}),
	date: (value, base) => ({
		...base,
		date: toNotionDateValue(value.date) ?? null,
	}),
	people: (value, base) => ({
		...base,
		people: (value.people ?? [])
			.map((person) => toNotionUser(person))
			.filter(Boolean) as NotionUser[],
	}),
	files: (value, base) => ({
		...base,
		files: (value.files ?? []).map((file) => toNotionFile(file)),
	}),
	relation: (value, base) => ({
		...base,
		relation: (value.relation ?? []).map((relation) => ({ id: relation.id })),
	}),
	formula: (value, base) => ({
		...base,
		formula: toNotionFormulaValue(value.formula),
	}),
	created_time: (value, base) => ({
		...base,
		created_time: value.created_time,
	}),
	last_edited_time: (value, base) => ({
		...base,
		last_edited_time: value.last_edited_time,
	}),
	created_by: (value, base) => ({
		...base,
		created_by: toNotionUser(value.created_by),
	}),
	last_edited_by: (value, base) => ({
		...base,
		last_edited_by: toNotionUser(value.last_edited_by),
	}),
	unique_id: (value, base) => ({
		...base,
		unique_id: value.unique_id
			? {
					prefix: value.unique_id.prefix ?? null,
					number: value.unique_id.number,
				}
			: undefined,
	}),
	verification: (value, base) => ({
		...base,
		verification: value.verification
			? {
					state: value.verification.state,
					verified_by:
						toNotionUser(value.verification.verified_by ?? undefined) ?? null,
					date: toNotionDateValue(value.verification.date) ?? null,
				}
			: null,
	}),
	rollup: (value, base) => ({
		...base,
		rollup: value.rollup
			? {
					type: value.rollup.type,
					number: value.rollup.number ?? null,
					date: toNotionDateValue(value.rollup.date) ?? null,
					array: value.rollup.array?.map((entry) =>
						toNotionPropertyValue(entry),
					),
				}
			: undefined,
	}),
};

function toNotionPropertyValue(
	property: PageObjectResponse["properties"][string],
): NotionPropertyValue {
	const value = property as NotionApiPropertyValue;

	const base: NotionPropertyValue = {
		id: value.id,
		type: value.type,
	};

	return propertyMappers[value.type]?.(value, base) ?? base;
}

const parentMappers: Record<string, ParentMapper> = {
	workspace: (parent) => ({
		type: parent.type,
		workspace: (
			parent as Extract<PageObjectResponse["parent"], { type: "workspace" }>
		).workspace,
	}),
	page_id: (parent) => ({
		type: parent.type,
		page_id: (
			parent as Extract<PageObjectResponse["parent"], { type: "page_id" }>
		).page_id,
	}),
	block_id: (parent) => ({
		type: parent.type,
		block_id: (
			parent as Extract<PageObjectResponse["parent"], { type: "block_id" }>
		).block_id,
	}),
	database_id: (parent) => ({
		type: parent.type,
		database_id: (
			parent as Extract<PageObjectResponse["parent"], { type: "database_id" }>
		).database_id,
	}),
	data_source_id: (parent) => ({
		type: parent.type,
		data_source_id: (
			parent as Extract<
				PageObjectResponse["parent"],
				{ type: "data_source_id" }
			>
		).data_source_id,
		database_id: (
			parent as Extract<
				PageObjectResponse["parent"],
				{ type: "data_source_id" }
			>
		).database_id,
	}),
};

function toNotionParent(parent: PageObjectResponse["parent"]): NotionParent {
	return (
		parentMappers[parent.type]?.(parent) ?? {
			type: (parent as { type: string }).type,
		}
	);
}

export function toNotionPage(page: PageObjectResponse): NotionPage {
	const properties = Object.fromEntries(
		Object.entries(page.properties).map(([name, property]) => [
			name,
			toNotionPropertyValue(property),
		]),
	);

	return {
		id: page.id,
		created_time: page.created_time,
		last_edited_time: page.last_edited_time,
		archived: page.archived,
		in_trash: page.in_trash,
		url: page.url,
		public_url: page.public_url,
		parent: toNotionParent(page.parent),
		properties,
	};
}

export function toNotionDataSource(
	dataSource: DataSourceObjectResponse,
): NotionDataSource {
	const title = toNotionRichText(dataSource.title);
	return {
		id: dataSource.id,
		name: extractPlainText(title),
		title,
	};
}

export function toNotionCandidatePage(
	page: PageObjectResponse,
): NotionCandidatePage {
	return {
		id: page.id,
		lastEditedTime: page.last_edited_time,
	};
}
