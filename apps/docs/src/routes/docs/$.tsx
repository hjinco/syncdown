import { createFileRoute } from "@tanstack/react-router";
import {
	DocsPageContent,
	docsServerLoader,
	preloadDocsContent,
} from "@/components/docs-page";
import { defaultLocale } from "@/lib/i18n";

export const Route = createFileRoute("/docs/$")({
	component: Page,
	loader: async ({ params }) => {
		const slugs = params._splat?.split("/") ?? [];
		const data = await docsServerLoader({
			data: {
				locale: defaultLocale,
				slugs,
			},
		});
		await preloadDocsContent(data.path);
		return data;
	},
});

function Page() {
	return <DocsPageContent data={Route.useLoaderData()} />;
}
