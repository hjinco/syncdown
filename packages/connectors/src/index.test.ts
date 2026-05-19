import { expect, test } from "bun:test";

import {
	createBuiltinConnectorPlugins,
	createConnectorAliasMap,
} from "./index.js";

test("createBuiltinConnectorPlugins respects platform support", () => {
	expect(
		createBuiltinConnectorPlugins("darwin").map((plugin) => plugin.id),
	).toEqual([
		"notion",
		"gmail",
		"google-calendar",
		"google-contacts",
		"apple-notes",
	]);
	expect(
		createBuiltinConnectorPlugins("linux").map((plugin) => plugin.id),
	).toEqual(["notion", "gmail", "google-calendar", "google-contacts"]);
});

test("createConnectorAliasMap exposes built-in config aliases", () => {
	const aliases = createConnectorAliasMap(
		createBuiltinConnectorPlugins("darwin"),
	);

	expect(aliases.get("notion.enabled")?.key).toBe("notion.enabled");
	expect(aliases.get("gmail.syncFilter")?.key).toBe("gmail.syncFilter");
	expect(aliases.get("googleCalendar.selectedCalendarIds")?.key).toBe(
		"googleCalendar.selectedCalendarIds",
	);
	expect(aliases.get("googleContacts.enabled")?.key).toBe(
		"googleContacts.enabled",
	);
	expect(aliases.get("appleNotes.interval")?.key).toBe("appleNotes.interval");
});
