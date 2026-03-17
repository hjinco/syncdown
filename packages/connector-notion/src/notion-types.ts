import type { Client } from "@notionhq/client";

export type NotionClientFactory = (
	options: ConstructorParameters<typeof Client>[0],
) => Client;

export interface NotionRichText {
	plain_text?: string;
}

export interface NotionUser {
	id: string;
	name?: string | null;
}

export interface NotionDateValue {
	start: string;
	end?: string | null;
}

export interface NotionFile {
	name?: string;
	url?: string | null;
}

export interface NotionFormulaValue {
	type: "string" | "number" | "boolean" | "date";
	string?: string | null;
	number?: number | null;
	boolean?: boolean | null;
	date?: NotionDateValue | null;
}

export interface NotionPropertyValue {
	id?: string;
	type: string;
	title?: NotionRichText[];
	rich_text?: NotionRichText[];
	number?: number | null;
	checkbox?: boolean;
	url?: string | null;
	email?: string | null;
	phone_number?: string | null;
	select?: { name: string } | null;
	multi_select?: Array<{ name: string }>;
	status?: { name: string } | null;
	date?: NotionDateValue | null;
	people?: NotionUser[];
	files?: NotionFile[];
	relation?: Array<{ id: string }>;
	formula?: NotionFormulaValue;
	created_time?: string;
	last_edited_time?: string;
	created_by?: NotionUser;
	last_edited_by?: NotionUser;
	unique_id?: { prefix?: string | null; number: number };
	verification?: {
		state?: string;
		verified_by?: NotionUser | null;
		date?: NotionDateValue | null;
	} | null;
	rollup?: {
		type: "number" | "date" | "array" | "unsupported" | string;
		number?: number | null;
		date?: NotionDateValue | null;
		array?: NotionPropertyValue[];
	};
}

export interface NotionParent {
	type:
		| "workspace"
		| "page_id"
		| "block_id"
		| "data_source_id"
		| "database_id"
		| string;
	workspace?: boolean;
	page_id?: string;
	block_id?: string;
	data_source_id?: string;
	database_id?: string;
}

export interface NotionPage {
	id: string;
	created_time: string;
	last_edited_time: string;
	archived?: boolean;
	in_trash?: boolean;
	url?: string;
	public_url?: string | null;
	parent: NotionParent;
	properties: Record<string, NotionPropertyValue>;
}

export interface NotionDataSource {
	id: string;
	name?: string | null;
	title?: NotionRichText[];
}

export interface NotionCandidatePage {
	id: string;
	lastEditedTime: string;
}

export interface NotionAdapter {
	validateToken(token: string): Promise<void>;
	listSharedPages(token: string): Promise<NotionCandidatePage[]>;
	listSharedDataSources(token: string): Promise<NotionDataSource[]>;
	listDataSourcePages(
		token: string,
		dataSourceId: string,
		since: string | null,
	): Promise<NotionCandidatePage[]>;
	retrievePage(token: string, pageId: string): Promise<NotionPage>;
	retrievePageMarkdown(token: string, pageId: string): Promise<string>;
}

export interface CreateNotionConnectorOptions {
	adapter?: NotionAdapter;
	clientFactory?: NotionClientFactory;
}
