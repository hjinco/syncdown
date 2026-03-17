import path from "node:path";

import type { SourceSnapshot } from "@syncdown/core";

import { slugifySegment } from "./strings.js";

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

export function buildRelativePath(document: SourceSnapshot): string {
	const fileName = `${document.slug || slugifySegment(document.title)}-${document.sourceId}.md`;
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
