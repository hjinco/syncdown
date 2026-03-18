import { useRouterState } from "@tanstack/react-router";
import { defineI18n } from "fumadocs-core/i18n";
import { defaultTranslations, defineI18nUI } from "fumadocs-ui/i18n";

export const locales = ["en", "ko", "ja", "zh-CN"] as const;
export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "en";

const appMetadata = {
	en: {
		title: "syncdown Docs",
		description:
			"User documentation for syncdown, a CLI that syncs Notion, Gmail, and Google Calendar into local Markdown.",
	},
	ko: {
		title: "syncdown 문서",
		description:
			"Notion, Gmail, Google Calendar를 로컬 Markdown으로 동기화하는 CLI syncdown의 사용자 문서입니다.",
	},
	ja: {
		title: "syncdown ドキュメント",
		description:
			"Notion、Gmail、Google Calendar をローカル Markdown に同期する CLI、syncdown のユーザードキュメントです。",
	},
	"zh-CN": {
		title: "syncdown 文档",
		description:
			"syncdown 用户文档。syncdown 是一个可将 Notion、Gmail 和 Google Calendar 同步到本地 Markdown 的 CLI。",
	},
} satisfies Record<AppLocale, { title: string; description: string }>;

export const docsI18n = defineI18n({
	languages: [...locales],
	defaultLanguage: defaultLocale,
	hideLocale: "default-locale",
	parser: "dot",
	fallbackLanguage: defaultLocale,
});

export const docsI18nUI = defineI18nUI(docsI18n, {
	translations: {
		en: {
			displayName: "English",
		},
		ko: {
			...defaultTranslations,
			displayName: "한국어",
			search: "검색",
			searchNoResult: "검색 결과가 없습니다",
			toc: "이 페이지에서",
			tocNoHeadings: "제목이 없습니다",
			lastUpdate: "마지막 업데이트",
			chooseLanguage: "언어 선택",
			nextPage: "다음 문서",
			previousPage: "이전 문서",
			chooseTheme: "테마 선택",
			editOnGithub: "GitHub에서 수정",
		},
		ja: {
			...defaultTranslations,
			displayName: "日本語",
			search: "検索",
			searchNoResult: "検索結果がありません",
			toc: "このページ内",
			tocNoHeadings: "見出しがありません",
			lastUpdate: "最終更新",
			chooseLanguage: "言語を選択",
			nextPage: "次のドキュメント",
			previousPage: "前のドキュメント",
			chooseTheme: "テーマを選択",
			editOnGithub: "GitHubで編集",
		},
		"zh-CN": {
			...defaultTranslations,
			displayName: "简体中文",
			search: "搜索",
			searchNoResult: "没有搜索结果",
			toc: "本页内容",
			tocNoHeadings: "没有标题",
			lastUpdate: "最后更新",
			chooseLanguage: "选择语言",
			nextPage: "下一篇文档",
			previousPage: "上一篇文档",
			chooseTheme: "选择主题",
			editOnGithub: "在 GitHub 上编辑",
		},
	},
});

const localeSet = new Set<string>(locales);
const reservedLocalizedPrefixes = [
	"/api",
	"/llms",
	"/llms.txt",
	"/llms-full.txt",
];

export function isLocale(value: string | undefined): value is AppLocale {
	return value !== undefined && localeSet.has(value);
}

export function getLocaleFromPathname(pathname: string): AppLocale {
	const firstSegment = pathname.split("/").filter(Boolean)[0];
	return isLocale(firstSegment) ? firstSegment : defaultLocale;
}

export function stripLocalePrefix(pathname: string): string {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length === 0) return "/";
	if (isLocale(segments[0])) {
		const next = segments.slice(1).join("/");
		return next.length > 0 ? `/${next}` : "/";
	}

	return pathname || "/";
}

function splitPathSuffix(path: string) {
	const match = /^([^?#]*)(.*)$/.exec(path);
	return {
		pathname: match?.[1] || "/",
		suffix: match?.[2] || "",
	};
}

function shouldBypassLocalization(pathname: string): boolean {
	return reservedLocalizedPrefixes.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

export function localizePath(path: string, locale: AppLocale): string {
	const { pathname, suffix } = splitPathSuffix(path);
	if (!pathname.startsWith("/") || shouldBypassLocalization(pathname))
		return path;

	const canonicalPath = stripLocalePrefix(pathname);
	if (locale === defaultLocale) return `${canonicalPath}${suffix}`;
	if (canonicalPath === "/") return `/${locale}${suffix}`;

	return `/${locale}${canonicalPath}${suffix}`;
}

export function getDocsPath(locale: AppLocale, slug?: string): string {
	const basePath = slug && slug.length > 0 ? `/docs/${slug}` : "/docs";
	return localizePath(basePath, locale);
}

export function getHomePath(locale: AppLocale): string {
	return localizePath("/", locale);
}

export function getAppMetadata(locale: AppLocale) {
	return appMetadata[locale];
}

export function getMarkdownPath(locale: AppLocale, slugs: string[]): string {
	const params = new URLSearchParams({ locale });
	const slugPath = slugs.join("/");
	const basePath =
		slugPath.length > 0 ? `/llms.mdx/docs/${slugPath}` : "/llms.mdx/docs/";

	return `${basePath}?${params.toString()}`;
}

export function useCurrentLocale(): AppLocale {
	return useRouterState({
		select: (state) => getLocaleFromPathname(state.location.pathname),
	});
}
