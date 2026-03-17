import { expect, test } from "bun:test";

import { normalizeFrontmatterKey, slugifySegment } from "./strings.js";

test("slugifySegment normalizes email-like values into path-safe segments", () => {
	expect(slugifySegment(" User.Name+Alias@Example.COM ")).toBe(
		"user-name-alias-example-com",
	);
});

test("slugifySegment falls back to untitled when nothing slugifies", () => {
	expect(slugifySegment("!!!")).toBe("untitled");
});

test("normalizeFrontmatterKey preserves unicode letters while collapsing separators", () => {
	expect(normalizeFrontmatterKey("담당자 이름")).toBe("담당자_이름");
	expect(normalizeFrontmatterKey("Review/Status")).toBe("review_status");
	expect(normalizeFrontmatterKey("   ")).toBe("");
});
