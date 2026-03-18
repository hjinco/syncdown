import type { SourceSnapshot } from "@syncdown/core";

import { normalizeFrontmatterKey } from "./strings.js";
import { appendYamlValue } from "./yaml.js";

function getAppleNotesFolderLabel(document: SourceSnapshot): string | null {
	const folderPath = document.metadata.appleNotesFolderPath;
	if (Array.isArray(folderPath) && folderPath.length > 0) {
		return folderPath.join("/");
	}

	return document.metadata.appleNotesFolder ?? null;
}

export function buildFrontmatterFields(
	document: SourceSnapshot,
): Map<string, unknown> {
	const fields = new Map<string, unknown>();

	fields.set("title", document.title);

	if (document.metadata.sourceUrl) {
		fields.set("source", document.metadata.sourceUrl);
	}

	if (document.metadata.createdAt) {
		fields.set("created", document.metadata.createdAt);
	}

	if (document.metadata.updatedAt) {
		fields.set("updated", document.metadata.updatedAt);
	}

	if (document.metadata.notionDatabase) {
		fields.set("database", document.metadata.notionDatabase);
	}

	if (document.connectorId === "notion" && document.metadata.notionProperties) {
		for (const [propertyName, propertyValue] of Object.entries(
			document.metadata.notionProperties,
		)) {
			const normalizedKey = normalizeFrontmatterKey(propertyName);
			if (!normalizedKey) {
				continue;
			}

			fields.set(normalizedKey, propertyValue);
		}
	}

	if (document.metadata.gmailFrom) {
		fields.set("from", document.metadata.gmailFrom);
	}

	if (document.metadata.gmailAccountEmail) {
		fields.set("account", document.metadata.gmailAccountEmail);
	}

	if (document.metadata.gmailTo) {
		fields.set("to", document.metadata.gmailTo);
	}

	if (document.metadata.gmailCc) {
		fields.set("cc", document.metadata.gmailCc);
	}

	if (document.metadata.gmailSnippet) {
		fields.set("snippet", document.metadata.gmailSnippet);
	}

	if (document.metadata.calendarName) {
		fields.set("calendar", document.metadata.calendarName);
	}

	if (document.metadata.calendarEventStatus) {
		fields.set("status", document.metadata.calendarEventStatus);
	}

	if (document.metadata.calendarStartAt) {
		fields.set("start", document.metadata.calendarStartAt);
	}

	if (document.metadata.calendarEndAt) {
		fields.set("end", document.metadata.calendarEndAt);
	}

	if (document.metadata.calendarAllDay !== undefined) {
		fields.set("all_day", document.metadata.calendarAllDay);
	}

	if (document.metadata.calendarLocation) {
		fields.set("location", document.metadata.calendarLocation);
	}

	if (document.metadata.calendarOrganizer) {
		fields.set("organizer", document.metadata.calendarOrganizer);
	}

	if (document.metadata.calendarAttendees) {
		fields.set("attendees", document.metadata.calendarAttendees);
	}

	if (document.metadata.calendarRecurrence) {
		fields.set("recurrence", document.metadata.calendarRecurrence);
	}

	const appleNotesFolderLabel = getAppleNotesFolderLabel(document);
	if (appleNotesFolderLabel) {
		fields.set("folder", appleNotesFolderLabel);
	}

	return fields;
}

export function stringifyFrontmatter(document: SourceSnapshot): string {
	const lines = ["---"];

	for (const [key, value] of buildFrontmatterFields(document)) {
		appendYamlValue(lines, key, value);
	}

	lines.push("---", "", `# ${document.title}`, "");
	return lines.join("\n");
}
