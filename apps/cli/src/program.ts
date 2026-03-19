import { createBuiltinConnectorPlugins } from "@syncdown/connectors";
import type {
	AppIo,
	ApplyUpdateResult,
	SelfUpdater,
	SyncdownApp,
	UpdateStatus,
} from "@syncdown/core";
import { createStdIo, createSyncdownApp, EXIT_CODES } from "@syncdown/core";
import { createMarkdownRenderer } from "@syncdown/renderer-md";
import { createSecretsStore } from "@syncdown/secrets";
import { createFileSystemSink } from "@syncdown/sink-fs";
import { createStateStore } from "@syncdown/state-sqlite";
import { launchConfigTui } from "@syncdown/tui";

import {
	getConfigSetKeys as getConfigCommandSetKeys,
	handleConfigCommand,
} from "./config-commands.js";
import { printOverview } from "./overview.js";
import {
	DEFAULT_WATCH_INTERVAL,
	getSupportedRunConnectorIds,
	parseRunOptions,
} from "./run-options.js";
import { createCliSelfUpdater } from "./updater.js";

function getConfigSetKeys(
	platform: NodeJS.Platform = process.platform,
): string[] {
	return getConfigCommandSetKeys(platform);
}

function getHelpLines(): string[] {
	const connectorUsage = getSupportedRunConnectorIds().join("|");
	return [
		"syncdown",
		"",
		"Usage:",
		"  syncdown",
		"  syncdown status",
		"  syncdown config set <key> <value>",
		"  syncdown config set <key> --stdin",
		"  syncdown config unset <key>",
		"  syncdown run",
		`  syncdown run --connector <${connectorUsage}>`,
		"  syncdown run --integration <integration-id>",
		`  syncdown run --reset [--connector <${connectorUsage}>|--integration <integration-id>]`,
		"  syncdown run --watch [--interval <5m|15m|1h|6h|24h>]",
		"  syncdown reset --yes",
		"  syncdown connectors",
		"  syncdown doctor",
		"  syncdown update",
		"  syncdown update --check",
		"",
		"Interactive:",
		"  syncdown                    Launch the TUI with settings plus the sync dashboard.",
		"",
		"Headless config:",
		"  syncdown config set ...     Set config values non-interactively.",
		"  syncdown config unset ...   Remove config values non-interactively.",
		"",
		"Config keys:",
		...getConfigSetKeys().map((key) => `  ${key}`),
		"",
		"Run exit codes:",
		`  ${EXIT_CODES.OK} success`,
		`  ${EXIT_CODES.CONFIG_ERROR} configuration error`,
		`  ${EXIT_CODES.LOCKED} another sync is already running`,
		`  ${EXIT_CODES.VALIDATION_ERROR} connector validation failed`,
		`  ${EXIT_CODES.SYNC_ERROR} connector sync failed`,
	];
}

function writeLines(output: (line: string) => void, lines: string[]): void {
	for (const line of lines) {
		output(line);
	}
}

export function printHelp(
	output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): void {
	writeLines(output, getHelpLines());
}

interface CliDependencies {
	app?: SyncdownApp;
	io?: AppIo;
	secrets?: ReturnType<typeof createSecretsStore>;
	launchConfig?: typeof launchConfigTui;
	updater?: SelfUpdater;
}

function printUpdateUsage(io: AppIo): void {
	io.error("Usage: syncdown update [--check]");
}

function printResetUsage(io: AppIo): void {
	io.error("Usage: syncdown reset --yes");
}

function isInteractiveTerminal(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function formatVersion(version: string): string {
	return version.startsWith("v") ? version : `v${version}`;
}

function writeUpdateStatus(io: AppIo, status: UpdateStatus): void {
	io.write(`current: ${formatVersion(status.currentVersion)}`);
	io.write(
		`latest: ${status.latestVersion ? formatVersion(status.latestVersion) : "unknown"}`,
	);
	io.write(
		`self-update: ${status.canSelfUpdate ? "available" : "unavailable"}`,
	);
	if (status.reason) {
		io.write(`reason: ${status.reason}`);
	}
	if (status.hasUpdate) {
		io.write(
			`update available: ${formatVersion(status.currentVersion)} -> ${status.latestVersion ? formatVersion(status.latestVersion) : "unknown"}`,
		);
	} else {
		io.write(`already up to date: ${formatVersion(status.currentVersion)}`);
	}
}

function writeApplyResult(io: AppIo, result: ApplyUpdateResult): void {
	io.write(result.message);
}

async function handleUpdateCommand(
	io: AppIo,
	args: string[],
	updater: SelfUpdater,
): Promise<number> {
	const checkOnly = args[0] === "--check";
	if (args.length > 1 || (args.length === 1 && !checkOnly)) {
		printUpdateUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	let status: UpdateStatus;
	try {
		status = await updater.checkForUpdate();
	} catch (error) {
		io.error(
			error instanceof Error ? error.message : "Unknown update check failure.",
		);
		return EXIT_CODES.GENERAL_ERROR;
	}

	writeUpdateStatus(io, status);
	if (checkOnly) {
		return EXIT_CODES.OK;
	}

	if (!status.canSelfUpdate) {
		io.error(status.reason ?? "Self-update is unavailable.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	if (!status.hasUpdate) {
		return EXIT_CODES.OK;
	}

	try {
		const result = await updater.applyUpdate();
		writeApplyResult(io, result);
		return EXIT_CODES.OK;
	} catch (error) {
		io.error(
			error instanceof Error ? error.message : "Unknown update failure.",
		);
		return EXIT_CODES.GENERAL_ERROR;
	}
}

async function handleResetCommand(
	io: AppIo,
	args: string[],
	app: SyncdownApp,
): Promise<number> {
	if (args.length !== 1 || args[0] !== "--yes") {
		printResetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	return app.reset(io);
}

function shouldRunAutoUpdateCheck(command: string | undefined): boolean {
	return (
		command !== undefined &&
		command !== "update" &&
		command !== "--help" &&
		command !== "-h"
	);
}

function startBestEffortUpdateCheck(io: AppIo, updater: SelfUpdater): void {
	void updater
		.checkForUpdate()
		.then((status) => {
			if (!status.canSelfUpdate || !status.hasUpdate || !status.latestVersion) {
				return;
			}
			io.error(
				`Update available: ${formatVersion(status.currentVersion)} -> ${formatVersion(status.latestVersion)}. Run \`syncdown update\`.`,
			);
		})
		.catch(() => {});
}

export async function runCli(
	argv = process.argv,
	dependencies: CliDependencies = {},
): Promise<number> {
	const io = dependencies.io ?? createStdIo();
	const secrets = dependencies.secrets ?? createSecretsStore();
	const app =
		dependencies.app ??
		createSyncdownApp({
			plugins: createBuiltinConnectorPlugins(),
			renderer: createMarkdownRenderer(),
			sink: createFileSystemSink(),
			state: createStateStore(),
			secrets,
		});
	const launchConfig = dependencies.launchConfig ?? launchConfigTui;
	const updater = dependencies.updater ?? createCliSelfUpdater();

	const command = argv[2];
	if (shouldRunAutoUpdateCheck(command)) {
		startBestEffortUpdateCheck(io, updater);
	}

	switch (command) {
		case "config": {
			return handleConfigCommand(io, argv, secrets);
		}
		case "status":
			return printOverview(io, app, {
				defaultWatchInterval: DEFAULT_WATCH_INTERVAL,
				interactiveTerminal: isInteractiveTerminal(),
				secrets,
			});
		case "run": {
			const runOptions = parseRunOptions(argv.slice(3), io);
			if (!runOptions) {
				return EXIT_CODES.CONFIG_ERROR;
			}
			return app.run(io, runOptions);
		}
		case "reset":
			return handleResetCommand(io, argv.slice(3), app);
		case "connectors":
			return app.listConnectors(io);
		case "doctor":
			return app.doctor(io);
		case "update":
			return handleUpdateCommand(io, argv.slice(3), updater);
		case "--help":
		case "-h":
			printHelp();
			return EXIT_CODES.OK;
		case undefined:
			if (!isInteractiveTerminal()) {
				printHelp(io.error);
				return EXIT_CODES.CONFIG_ERROR;
			}
			return launchConfig({
				app,
				io,
				secrets,
				session: await app.openSession(),
				updater,
			});
		default:
			io.error(`Unknown command: ${command}`);
			printHelp();
			return EXIT_CODES.GENERAL_ERROR;
	}
}
