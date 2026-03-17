import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";
import { defaultLocale, getLocaleFromPathname, isLocale } from "@/lib/i18n";
import { source } from "@/lib/source";

export const Route = createFileRoute("/llms.txt")({
	server: {
		handlers: {
			GET({ request }) {
				const url = new URL(request.url);
				const requestedLocale = url.searchParams.get("locale");
				const locale = isLocale(requestedLocale ?? undefined)
					? requestedLocale
					: defaultLocale;

				return new Response(
					llms(source).index(locale ?? getLocaleFromPathname(url.pathname)),
				);
			},
		},
	},
});
