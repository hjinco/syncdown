import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
	MarkdownCopyButton,
	ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { getMDXComponents } from "@/components/mdx";
import { type AppLocale, getMarkdownPath } from "@/lib/i18n";
import { baseOptions, gitConfig } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export const docsServerLoader = createServerFn({
	method: "GET",
})
	.inputValidator((value: { locale: AppLocale; slugs: string[] }) => value)
	.handler(async ({ data }) => {
		const page = source.getPage(data.slugs, data.locale);
		if (!page) throw notFound();

		return {
			locale: data.locale,
			slugs: page.slugs,
			path: page.path,
			pageTree: await source.serializePageTree(source.getPageTree(data.locale)),
		};
	});

const clientLoader = browserCollections.docs.createClientLoader({
	component(
		{ toc, frontmatter, default: MDX },
		{
			markdownUrl,
			path,
		}: {
			markdownUrl: string;
			path: string;
		},
	) {
		const mdxComponents = getMDXComponents();

		return (
			<DocsPage toc={toc}>
				<DocsTitle>{frontmatter.title}</DocsTitle>
				<DocsDescription>{frontmatter.description}</DocsDescription>
				<div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
					<MarkdownCopyButton markdownUrl={markdownUrl} />
					<ViewOptionsPopover
						markdownUrl={markdownUrl}
						githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${path}`}
					/>
				</div>
				<DocsBody>
					<MDX components={mdxComponents} />
				</DocsBody>
			</DocsPage>
		);
	},
});

export function preloadDocsContent(path: string) {
	return clientLoader.preload(path);
}

export function DocsPageContent({
	data,
}: {
	data: Awaited<ReturnType<typeof docsServerLoader>>;
}) {
	const { locale, path, pageTree, slugs } = useFumadocsLoader(data);
	const markdownUrl = getMarkdownPath(locale as AppLocale, slugs);

	return (
		<DocsLayout {...baseOptions(locale as AppLocale)} tree={pageTree}>
			<Suspense>
				{clientLoader.useContent(path, { markdownUrl, path })}
			</Suspense>
		</DocsLayout>
	);
}
