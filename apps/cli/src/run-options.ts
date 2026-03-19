import { createBuiltinConnectorPlugins } from "@syncdown/connectors";
import type {
	AppIo,
	ConnectorId,
	RunOptions,
	SyncIntervalPreset,
} from "@syncdown/core";

const INTERVAL_PRESETS: SyncIntervalPreset[] = ["5m", "15m", "1h", "6h", "24h"];

export const DEFAULT_WATCH_INTERVAL: SyncIntervalPreset = "1h";

export function getSupportedRunConnectorIds(
	platform: NodeJS.Platform = process.platform,
): ConnectorId[] {
	return createBuiltinConnectorPlugins(platform).map((plugin) => plugin.id);
}

function isSupportedRunConnectorId(
	value: string,
	platform: NodeJS.Platform = process.platform,
): value is ConnectorId {
	return getSupportedRunConnectorIds(platform).includes(value as ConnectorId);
}

function isSyncIntervalPreset(value: string): value is SyncIntervalPreset {
	return INTERVAL_PRESETS.includes(value as SyncIntervalPreset);
}

export function getRunUsageLine(
	platform: NodeJS.Platform = process.platform,
): string {
	return `Usage: syncdown run [--connector <${getSupportedRunConnectorIds(platform).join("|")}>|--integration <integration-id>] [--reset] [--watch] [--interval <5m|15m|1h|6h|24h>]`;
}

function printRunUsage(io: AppIo): void {
	io.error(getRunUsageLine());
}

export function parseRunOptions(args: string[], io: AppIo): RunOptions | null {
	let watch = false;
	let watchInterval: SyncIntervalPreset | undefined;
	let target: RunOptions["target"];
	let resetState = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		if (arg === "--watch") {
			watch = true;
			continue;
		}

		if (arg === "--interval") {
			const value = args[index + 1];
			if (!value || !isSyncIntervalPreset(value)) {
				io.error(
					value
						? `--interval must be one of: ${INTERVAL_PRESETS.join(", ")}`
						: "--interval requires a value.",
				);
				printRunUsage(io);
				return null;
			}

			watchInterval = value;
			index += 1;
			continue;
		}

		if (arg === "--connector") {
			const value = args[index + 1];
			const validConnectors = getSupportedRunConnectorIds();
			if (!value || !isSupportedRunConnectorId(value)) {
				io.error(
					value
						? `--connector must be one of: ${validConnectors.join(", ")}`
						: "--connector requires a value.",
				);
				printRunUsage(io);
				return null;
			}

			if (target) {
				io.error("--connector cannot be used together with --integration.");
				printRunUsage(io);
				return null;
			}

			target = { kind: "connector", connectorId: value };
			index += 1;
			continue;
		}

		if (arg === "--integration") {
			const value = args[index + 1]?.trim();
			if (!value) {
				io.error("--integration requires a value.");
				printRunUsage(io);
				return null;
			}

			if (target) {
				io.error("--integration cannot be used together with --connector.");
				printRunUsage(io);
				return null;
			}

			target = { kind: "integration", integrationId: value };
			index += 1;
			continue;
		}

		if (arg === "--reset") {
			resetState = true;
			continue;
		}

		io.error(`Unknown run option: ${arg}`);
		printRunUsage(io);
		return null;
	}

	if (watchInterval && !watch) {
		io.error("--interval can only be used together with --watch.");
		printRunUsage(io);
		return null;
	}

	if (watch && target) {
		io.error(
			"--connector and --integration are only supported for one-shot runs.",
		);
		printRunUsage(io);
		return null;
	}

	if (watch && resetState) {
		io.error("--reset can only be used for one-shot runs.");
		printRunUsage(io);
		return null;
	}

	if (!watch) {
		return {
			target,
			resetState,
		};
	}

	return {
		watch: true,
		watchInterval: watchInterval ?? DEFAULT_WATCH_INTERVAL,
	};
}
