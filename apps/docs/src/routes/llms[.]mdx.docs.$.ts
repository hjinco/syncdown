import { createFileRoute, notFound } from "@tanstack/react-router";
import { defaultLocale, isLocale } from "@/lib/i18n";
import { getLLMText, source } from "@/lib/source";

export const Route = createFileRoute("/llms.mdx/docs/$")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const url = new URL(request.url);
				const slugs = params._splat?.split("/") ?? [];
				const requestedLocale = url.searchParams.get("locale") ?? undefined;
				const locale = isLocale(requestedLocale)
					? requestedLocale
					: defaultLocale;
				const page = source.getPage(slugs, locale);
				if (!page) throw notFound();

				return new Response(await getLLMText(page), {
					headers: {
						"Content-Type": "text/markdown",
					},
				});
			},
		},
	},
});
