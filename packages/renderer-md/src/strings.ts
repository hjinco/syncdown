export function slugifySegment(input: string): string {
	return (
		input
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "untitled"
	);
}

export function normalizeFrontmatterKey(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
}
