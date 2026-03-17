import { createFileRoute, redirect } from "@tanstack/react-router";
import { defaultLocale, getDocsPath } from "@/lib/i18n";

export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({
			to: getDocsPath(defaultLocale),
		});
	},
});
