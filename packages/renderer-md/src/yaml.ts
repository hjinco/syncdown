function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatYamlScalar(value: string | number | boolean | null): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (value === null) {
		return "null";
	}

	return String(value);
}

export function appendYamlValue(
	lines: string[],
	key: string,
	value: unknown,
	indent = "",
): void {
	if (value === undefined) {
		return;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return;
		}

		lines.push(`${indent}${key}:`);
		for (const item of value) {
			if (Array.isArray(item) || isPlainObject(item)) {
				lines.push(`${indent}  -`);
				appendYamlNestedValue(lines, item, `${indent}    `);
				continue;
			}

			lines.push(
				`${indent}  - ${formatYamlScalar(
					(item ?? null) as string | number | boolean | null,
				)}`,
			);
		}
		return;
	}

	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) {
			return;
		}

		lines.push(`${indent}${key}:`);
		for (const [childKey, childValue] of entries) {
			appendYamlValue(
				lines,
				JSON.stringify(childKey),
				childValue,
				`${indent}  `,
			);
		}
		return;
	}

	lines.push(
		`${indent}${key}: ${formatYamlScalar(
			(value ?? null) as string | number | boolean | null,
		)}`,
	);
}

function appendYamlNestedValue(
	lines: string[],
	value: unknown,
	indent: string,
): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			if (Array.isArray(item) || isPlainObject(item)) {
				lines.push(`${indent}-`);
				appendYamlNestedValue(lines, item, `${indent}  `);
				continue;
			}

			lines.push(
				`${indent}- ${formatYamlScalar(
					(item ?? null) as string | number | boolean | null,
				)}`,
			);
		}
		return;
	}

	if (isPlainObject(value)) {
		for (const [key, childValue] of Object.entries(value)) {
			appendYamlValue(lines, JSON.stringify(key), childValue, indent);
		}
		return;
	}

	lines.push(
		`${indent}${formatYamlScalar(
			(value ?? null) as string | number | boolean | null,
		)}`,
	);
}
