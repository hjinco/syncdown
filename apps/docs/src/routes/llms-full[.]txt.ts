import { createFileRoute } from "@tanstack/react-router";
import { defaultLocale, isLocale } from "@/lib/i18n";
import { getLLMText, source } from "@/lib/source";

export const Route = createFileRoute("/llms-full.txt")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const requestedLocale = url.searchParams.get("locale") ?? undefined;
				const locale = isLocale(requestedLocale)
					? requestedLocale
					: defaultLocale;
				const scan = source.getPages(locale).map(getLLMText);
				const scanned = await Promise.all(scan);
				return new Response(scanned.join("\n\n"));
			},
		},
	},
});
