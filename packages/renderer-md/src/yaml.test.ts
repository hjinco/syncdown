import { expect, test } from "bun:test";

import { appendYamlValue } from "./yaml.js";

test("appendYamlValue serializes scalars, arrays, and nested objects", () => {
	const lines: string[] = [];

	appendYamlValue(lines, "title", "Roadmap");
	appendYamlValue(lines, "tags", ["alpha", "beta"]);
	appendYamlValue(lines, "schedule", {
		start: "2026-03-17",
		end: "2026-03-20",
	});
	appendYamlValue(lines, "items", [{ done: true }, ["x", "y"]]);

	expect(lines.join("\n")).toBe(
		[
			'title: "Roadmap"',
			"tags:",
			'  - "alpha"',
			'  - "beta"',
			"schedule:",
			'  "start": "2026-03-17"',
			'  "end": "2026-03-20"',
			"items:",
			"  -",
			'    "done": true',
			"  -",
			'    - "x"',
			'    - "y"',
		].join("\n"),
	);
});

test("appendYamlValue skips undefined, empty arrays, and empty objects", () => {
	const lines: string[] = [];

	appendYamlValue(lines, "missing", undefined);
	appendYamlValue(lines, "empty_list", []);
	appendYamlValue(lines, "empty_map", {});
	appendYamlValue(lines, "present", false);

	expect(lines).toEqual(["present: false"]);
});
