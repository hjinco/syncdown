import type {
	ConnectorPlugin,
	MarkdownRenderer,
	RenderedDocument,
	SourceSnapshot,
} from "@syncdown/core";

import { stringifyFrontmatter } from "./frontmatter.js";
import { buildRelativePath } from "./path-builder.js";

class DefaultMarkdownRenderer implements MarkdownRenderer {
	getVersion(plugin: ConnectorPlugin): string {
		return plugin.render.version;
	}

	render(document: SourceSnapshot, plugin: ConnectorPlugin): RenderedDocument {
		const extraFrontmatter = plugin.render.extendFrontmatter?.(document);
		return {
			sourceId: document.sourceId,
			title: document.title,
			relativePath:
				plugin.render.buildRelativePath?.(document) ??
				buildRelativePath(document),
			contents: `${stringifyFrontmatter(document, extraFrontmatter)}${document.bodyMd}\n`,
			sourceHash: document.sourceHash,
		};
	}
}

export function createMarkdownRenderer(): MarkdownRenderer {
	return new DefaultMarkdownRenderer();
}
