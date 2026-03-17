import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { type AppLocale, docsI18n } from "@/lib/i18n";

export const gitConfig = {
	user: "hjinco",
	repo: "syncdown",
	branch: "main",
};

export function baseOptions(_locale: AppLocale): BaseLayoutProps {
	return {
		i18n: docsI18n,
		nav: {
			title: "syncdown",
		},
		githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
	};
}
