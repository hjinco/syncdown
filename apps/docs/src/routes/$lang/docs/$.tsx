import { createFileRoute, notFound } from "@tanstack/react-router";
import {
	DocsPageContent,
	docsServerLoader,
	preloadDocsContent,
} from "@/components/docs-page";
import { isLocale } from "@/lib/i18n";

export const Route = createFileRoute("/$lang/docs/$")({
	component: LocalizedDocsPage,
	loader: async ({ params }) => {
		if (!isLocale(params.lang)) throw notFound();

		const data = await docsServerLoader({
			data: {
				locale: params.lang,
				slugs: params._splat?.split("/") ?? [],
			},
		});
		await preloadDocsContent(data.path);

		return data;
	},
});

function LocalizedDocsPage() {
	return <DocsPageContent data={Route.useLoaderData()} />;
}
