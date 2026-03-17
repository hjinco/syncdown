import Link from "fumadocs-core/link";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { AnchorHTMLAttributes } from "react";
import { localizePath, useCurrentLocale } from "@/lib/i18n";

function MdxLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
	const locale = useCurrentLocale();
	const localizedHref =
		typeof href === "string" ? localizePath(href, locale) : href;

	return <Link href={localizedHref} {...props} />;
}

export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		a: MdxLink,
		...components,
	} satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
	type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
