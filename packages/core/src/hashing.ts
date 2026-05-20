export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				sorted[k] = (v as Record<string, unknown>)[k];
			}
			return sorted;
		}
		return v;
	});
}
