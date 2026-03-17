import type {
	ConnectorId,
	MarkdownRenderer,
	RenderedDocument,
	SourceSnapshot,
} from "@syncdown/core";

import { stringifyFrontmatter } from "./frontmatter.js";
import { buildRelativePath } from "./path-builder.js";
import { MARKDOWN_RENDERER_VERSIONS } from "./versions.js";

class DefaultMarkdownRenderer implements MarkdownRenderer {
	getVersion(connectorId: ConnectorId): string {
		return MARKDOWN_RENDERER_VERSIONS[connectorId];
	}

	render(document: SourceSnapshot): RenderedDocument {
		return {
			sourceId: document.sourceId,
			title: document.title,
			relativePath: buildRelativePath(document),
			contents: `${stringifyFrontmatter(document)}${document.bodyMd}\n`,
			sourceHash: document.sourceHash,
		};
	}
}

export function createMarkdownRenderer(): MarkdownRenderer {
	return new DefaultMarkdownRenderer();
}
