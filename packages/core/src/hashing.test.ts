import { describe, expect, test } from "bun:test";

import { stableStringify } from "./hashing.js";

describe("stableStringify", () => {
	test("produces identical output regardless of key insertion order", () => {
		const a = { b: 2, a: 1, c: { y: 2, x: 1 } };
		const b = { c: { x: 1, y: 2 }, a: 1, b: 2 };
		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	test("preserves array element order", () => {
		expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
	});

	test("sorts nested object keys inside arrays", () => {
		expect(stableStringify([{ b: 2, a: 1 }])).toBe('[{"a":1,"b":2}]');
	});
});
