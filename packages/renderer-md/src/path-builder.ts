import path from "node:path";

import type { SourceSnapshot } from "@syncdown/core";

import { slugifySegment } from "./strings.js";

function getAppleNotesFileIdentifier(noteId: string): string {
	const withoutScheme = noteId.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	return slugifySegment(withoutScheme);
}

function getCalendarBucketDate(document: SourceSnapshot): Date | null {
	const value =
		document.metadata.calendarStartAt ?? document.metadata.createdAt;
	if (!value) {
		return null;
	}

	const date = new Date(value);
	return Number.isFinite(date.valueOf()) ? date : null;
}

function getGmailAccountSegment(document: SourceSnapshot): string {
	return slugifySegment(
		document.pathHint.gmailAccountEmail ??
			document.metadata.gmailAccountEmail ??
			"unknown-account",
	);
}

function getAppleNotesFolderSegments(document: SourceSnapshot): string[] {
	const rawPath =
		document.pathHint.appleNotesFolderPath ??
		document.metadata.appleNotesFolderPath;
	if (Array.isArray(rawPath) && rawPath.length > 0) {
		return rawPath.map((segment) => slugifySegment(String(segment)));
	}

	return [
		slugifySegment(
			document.pathHint.appleNotesFolder ??
				document.metadata.appleNotesFolder ??
				"root",
		),
	];
}

function getFileIdentifier(document: SourceSnapshot): string {
	if (document.pathHint.kind === "calendar-event") {
		const eventId = document.metadata.calendarEventId;
		if (typeof eventId === "string" && eventId.trim().length > 0) {
			return eventId;
		}
	}

	if (document.pathHint.kind === "note") {
		const noteId = document.metadata.appleNotesNoteId;
		if (typeof noteId === "string" && noteId.trim().length > 0) {
			return getAppleNotesFileIdentifier(noteId);
		}
	}

	return document.sourceId;
}

const MAX_FILENAME_LENGTH = 255;

function truncateToBytes(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(str) <= maxBytes) return str;
	return Buffer.from(str, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

function buildFileName(document: SourceSnapshot): string {
	const identifier = getFileIdentifier(document);
	const suffix = `-${identifier}.md`;
	const rawSlug = document.slug || slugifySegment(document.title);
	const maxSlugBytes = Math.max(0, MAX_FILENAME_LENGTH - Buffer.byteLength(suffix));
	const slug = truncateToBytes(rawSlug, maxSlugBytes).replace(/-+$/, "");
	return `${slug}${suffix}`;
}

export function buildRelativePath(document: SourceSnapshot): string {
	const fileName = buildFileName(document);
	if (document.pathHint.kind === "message") {
		const createdAt = document.metadata.createdAt
			? new Date(document.metadata.createdAt)
			: null;
		const year =
			createdAt && Number.isFinite(createdAt.valueOf())
				? String(createdAt.getUTCFullYear())
				: "unknown";
		const month =
			createdAt && Number.isFinite(createdAt.valueOf())
				? String(createdAt.getUTCMonth() + 1).padStart(2, "0")
				: "unknown";

		return path.join(
			document.connectorId,
			getGmailAccountSegment(document),
			year,
			month,
			fileName,
		);
	}

	if (document.pathHint.kind === "calendar-event") {
		const bucketDate = getCalendarBucketDate(document);
		const year = bucketDate ? String(bucketDate.getUTCFullYear()) : "undated";
		const month = bucketDate
			? String(bucketDate.getUTCMonth() + 1).padStart(2, "0")
			: "undated";
		const calendarName = slugifySegment(
			document.pathHint.calendarName ??
				document.metadata.calendarName ??
				"default",
		);

		return path.join(document.connectorId, calendarName, year, month, fileName);
	}

	if (document.pathHint.kind === "note") {
		const accountName = slugifySegment(
			document.pathHint.appleNotesAccount ?? "unknown-account",
		);
		return path.join(
			document.connectorId,
			accountName,
			...getAppleNotesFolderSegments(document),
			fileName,
		);
	}

	if (document.pathHint.kind === "database" && document.pathHint.databaseName) {
		return path.join(
			document.connectorId,
			"databases",
			slugifySegment(document.pathHint.databaseName),
			fileName,
		);
	}

	return path.join(document.connectorId, "pages", fileName);
}
