import type { ConnectorId } from "@syncdown/core";

export const MARKDOWN_RENDERER_VERSIONS: Record<ConnectorId, string> = {
	notion: "1",
	gmail: "1",
	"google-calendar": "1",
};
