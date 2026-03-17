import { redirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { defaultLocale, isLocale, stripLocalePrefix } from "@/lib/i18n";

function rewriteLlmPath(pathname: string) {
	const match = /^\/(?:(?<locale>[^/]+)\/)?docs\/(?<path>.*)\.mdx$/.exec(
		pathname,
	);
	if (!match?.groups) return null;

	const locale = isLocale(match.groups.locale)
		? match.groups.locale
		: defaultLocale;
	const path = match.groups.path;
	const nextPath =
		path.length > 0 ? `/llms.mdx/docs/${path}` : "/llms.mdx/docs/";
	const params = new URLSearchParams({ locale });

	return `${nextPath}?${params.toString()}`;
}

const canonicalLocaleMiddleware = createMiddleware().server(
	({ next, request }) => {
		const url = new URL(request.url);
		const segments = url.pathname.split("/").filter(Boolean);
		const firstSegment = segments[0];

		if (firstSegment === defaultLocale) {
			const nextUrl = new URL(url);
			nextUrl.pathname = stripLocalePrefix(url.pathname);
			throw redirect(nextUrl);
		}

		return next();
	},
);

const llmMiddleware = createMiddleware().server(({ next, request }) => {
	const url = new URL(request.url);
	const path = rewriteLlmPath(url.pathname);

	if (path) {
		throw redirect(new URL(path, url));
	}

	return next();
});

export const startInstance = createStart(() => {
	return {
		requestMiddleware: [canonicalLocaleMiddleware, llmMiddleware],
	};
});
