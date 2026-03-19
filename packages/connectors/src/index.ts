import { createAppleNotesConnectorPlugin } from "@syncdown/connector-apple-notes";
import { createGmailConnectorPlugin } from "@syncdown/connector-gmail";
import { createGoogleCalendarConnectorPlugin } from "@syncdown/connector-google-calendar";
import { createNotionConnectorPlugin } from "@syncdown/connector-notion";
import type { ConnectorCliAlias, ConnectorPlugin } from "@syncdown/core";

export function createBuiltinConnectorPlugins(
	platform: NodeJS.Platform = process.platform,
): ConnectorPlugin[] {
	return [
		createNotionConnectorPlugin(),
		createGmailConnectorPlugin(),
		createGoogleCalendarConnectorPlugin(),
		...(platform === "darwin" ? [createAppleNotesConnectorPlugin()] : []),
	];
}

export function createConnectorAliasMap(
	plugins: readonly ConnectorPlugin[],
): Map<string, ConnectorCliAlias> {
	const aliases = new Map<string, ConnectorCliAlias>();
	for (const plugin of plugins) {
		for (const alias of plugin.manifest.cliAliases ?? []) {
			if (!aliases.has(alias.key)) {
				aliases.set(alias.key, alias);
			}
		}
	}
	return aliases;
}
