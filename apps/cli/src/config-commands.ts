import {
	createBuiltinConnectorPlugins,
	createConnectorAliasMap,
} from "@syncdown/connectors";
import type { AppIo, SecretsStore, SyncdownConfig } from "@syncdown/core";
import {
	EXIT_CODES,
	ensureAppDirectories,
	ensureConfig,
	resolveAppPaths,
	validateManagedOutputDirectory,
	writeConfig,
} from "@syncdown/core";
import { createSecretsStore } from "@syncdown/secrets";

async function readValueFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

async function loadConfig(): Promise<{
	config: SyncdownConfig;
	paths: ReturnType<typeof resolveAppPaths>;
}> {
	const paths = resolveAppPaths();
	await ensureAppDirectories(paths);
	const config = await ensureConfig(paths, createBuiltinConnectorPlugins());
	return { config, paths };
}

function getConfigAliases(platform: NodeJS.Platform = process.platform) {
	return createConnectorAliasMap(createBuiltinConnectorPlugins(platform));
}

export function getConfigSetKeys(
	platform: NodeJS.Platform = process.platform,
): string[] {
	return ["outputDir", ...getConfigAliases(platform).keys()];
}

function printConfigSetUsage(io: AppIo): void {
	io.error(
		`Usage: syncdown config set <${getConfigSetKeys().join("|")}> <value|--stdin>`,
	);
}

function printConfigUnsetUsage(io: AppIo): void {
	io.error(
		"Usage: syncdown config unset <outputDir|notion.token|notion.oauth.clientId|notion.oauth.clientSecret|notion.oauth.refreshToken|google.clientId|google.clientSecret|google.refreshToken>",
	);
}

export function printConfigHelp(io: AppIo): void {
	for (const line of [
		"Usage:",
		"  syncdown config set <key> <value>",
		"  syncdown config set <key> --stdin",
		"  syncdown config unset <key>",
		"",
		"Use `syncdown` to launch the interactive TUI.",
	]) {
		io.error(line);
	}
}

async function handleOutputDirSet(
	io: AppIo,
	config: SyncdownConfig,
	paths: ReturnType<typeof resolveAppPaths>,
	value: string,
): Promise<number> {
	const nextValue = value.trim();
	if (!nextValue) {
		io.error("outputDir cannot be empty.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const validationError = await validateManagedOutputDirectory(nextValue);
	if (validationError) {
		io.error(validationError);
		return EXIT_CODES.CONFIG_ERROR;
	}

	config.outputDir = nextValue;
	await writeConfig(paths, config);
	io.write(`Set outputDir=${config.outputDir}`);
	return EXIT_CODES.OK;
}

async function handleConfigSet(
	io: AppIo,
	argv: string[],
	secrets: SecretsStore,
): Promise<number> {
	const key = argv[4];
	const rawValue = argv[5];
	if (!key || !rawValue) {
		printConfigSetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const value = rawValue === "--stdin" ? await readValueFromStdin() : rawValue;
	const { config, paths } = await loadConfig();

	if (key === "outputDir") {
		return handleOutputDirSet(io, config, paths, value);
	}

	const alias = getConfigAliases().get(key);
	if (!alias) {
		io.error(`Unknown config key: ${key}`);
		printConfigSetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	try {
		const message = await alias.setValue(
			{
				config,
				io,
				paths,
				secrets,
			},
			value,
		);
		if (!alias.secret) {
			await writeConfig(paths, config);
		}
		io.write(message);
		return EXIT_CODES.OK;
	} catch (error) {
		io.error(error instanceof Error ? error.message : `Failed to set ${key}.`);
		return EXIT_CODES.CONFIG_ERROR;
	}
}

async function handleConfigUnset(
	io: AppIo,
	argv: string[],
	secrets: SecretsStore,
): Promise<number> {
	const key = argv[4];
	if (!key) {
		printConfigUnsetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const { config, paths } = await loadConfig();
	if (key === "outputDir") {
		delete config.outputDir;
		await writeConfig(paths, config);
		io.write("Removed outputDir.");
		return EXIT_CODES.OK;
	}

	const alias = getConfigAliases().get(key);
	if (!alias?.unsetValue) {
		io.error(`Unknown config key: ${key}`);
		printConfigUnsetUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	try {
		const message = await alias.unsetValue({
			config,
			io,
			paths,
			secrets,
		});
		if (!alias.secret) {
			await writeConfig(paths, config);
		}
		io.write(message);
		return EXIT_CODES.OK;
	} catch (error) {
		io.error(
			error instanceof Error ? error.message : `Failed to unset ${key}.`,
		);
		return EXIT_CODES.CONFIG_ERROR;
	}
}

export async function handleConfigCommand(
	io: AppIo,
	argv: string[],
	secrets: SecretsStore = createSecretsStore(),
): Promise<number> {
	const subcommand = argv[3];
	if (subcommand === "set") {
		return handleConfigSet(io, argv, secrets);
	}
	if (subcommand === "unset") {
		return handleConfigUnset(io, argv, secrets);
	}

	printConfigHelp(io);
	return EXIT_CODES.CONFIG_ERROR;
}
