import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getDocsPath, isLocale } from "@/lib/i18n";

export const Route = createFileRoute("/$lang/")({
	beforeLoad: ({ params }) => {
		if (!isLocale(params.lang)) throw notFound();

		throw redirect({
			to: getDocsPath(params.lang),
		});
	},
});
