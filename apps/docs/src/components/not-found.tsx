import { HomeLayout } from "fumadocs-ui/layouts/home";
import { DefaultNotFound } from "fumadocs-ui/layouts/home/not-found";
import { useCurrentLocale } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";

export function NotFound() {
	const locale = useCurrentLocale();

	return (
		<HomeLayout {...baseOptions(locale)}>
			<DefaultNotFound />
		</HomeLayout>
	);
}
