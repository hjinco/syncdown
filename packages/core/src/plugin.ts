import type { Connector, ConnectorPlugin, SyncdownServices } from "./types.js";

export function defineConnectorPlugin<TPlugin extends ConnectorPlugin>(
	plugin: TPlugin,
): TPlugin {
	return plugin;
}

function isConnectorPlugin(
	connector: Connector | ConnectorPlugin,
): connector is ConnectorPlugin {
	return "manifest" in connector && "render" in connector;
}

export function toConnectorPlugin(
	connector: Connector | ConnectorPlugin,
): ConnectorPlugin {
	if (isConnectorPlugin(connector)) {
		return connector;
	}

	return defineConnectorPlugin({
		...connector,
		manifest: {
			id: connector.id,
			label: connector.label,
			setupMethods: [...connector.setupMethods],
		},
		render: {
			version: "1",
		},
	});
}

export function getServicePlugins(
	services: Pick<SyncdownServices, "plugins" | "connectors">,
): ConnectorPlugin[] {
	if (services.plugins) {
		return [...services.plugins];
	}

	return (services.connectors ?? []).map((connector) =>
		toConnectorPlugin(connector),
	);
}
