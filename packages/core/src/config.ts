import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { createDefaultConfig, normalizeConfig } from "./config-model.js";
import type {
	AppIo,
	AppPaths,
	ConnectorPlugin,
	SyncdownConfig,
} from "./types.js";

interface PathResolutionRuntime {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
}

export function createStdIo(): AppIo {
	return {
		write(line) {
			process.stdout.write(`${line}\n`);
		},
		error(line) {
			process.stderr.write(`${line}\n`);
		},
	};
}

export function createNullIo(): AppIo {
	return {
		write() {},
		error() {},
	};
}

export function resolveAppPaths(
	runtime: Partial<PathResolutionRuntime> = {},
): AppPaths {
	const platform = runtime.platform ?? process.platform;
	const env = runtime.env ?? process.env;
	const home = resolveHomeDirectory(platform, env);
	const pathApi = platform === "win32" ? path.win32 : path;

	if (platform === "win32") {
		const configRoot = env.APPDATA ?? pathApi.join(home, "AppData", "Roaming");
		const dataRoot = env.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local");

		return {
			configDir: pathApi.join(configRoot, "syncdown"),
			dataDir: pathApi.join(dataRoot, "syncdown"),
			configPath: pathApi.join(configRoot, "syncdown", "config.json"),
			statePath: pathApi.join(dataRoot, "syncdown", "state.db"),
			secretsPath: pathApi.join(dataRoot, "syncdown", "secrets.enc"),
			masterKeyPath: pathApi.join(dataRoot, "syncdown", "master.key"),
			lockPath: pathApi.join(dataRoot, "syncdown", "sync.lock"),
		};
	}

	const configRoot = env.XDG_CONFIG_HOME ?? pathApi.join(home, ".config");
	const dataRoot = env.XDG_DATA_HOME ?? pathApi.join(home, ".local", "share");

	return {
		configDir: pathApi.join(configRoot, "syncdown"),
		dataDir: pathApi.join(dataRoot, "syncdown"),
		configPath: pathApi.join(configRoot, "syncdown", "config.json"),
		statePath: pathApi.join(dataRoot, "syncdown", "state.db"),
		secretsPath: pathApi.join(dataRoot, "syncdown", "secrets.enc"),
		masterKeyPath: pathApi.join(dataRoot, "syncdown", "master.key"),
		lockPath: pathApi.join(dataRoot, "syncdown", "sync.lock"),
	};
}

function resolveHomeDirectory(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string {
	const pathApi = platform === "win32" ? path.win32 : path;
	const home =
		env.HOME ??
		env.USERPROFILE ??
		(env.HOMEDRIVE && env.HOMEPATH
			? pathApi.join(env.HOMEDRIVE, env.HOMEPATH)
			: undefined);

	if (!home) {
		throw new Error(
			"Unable to resolve the user home directory from the environment",
		);
	}

	return home;
}

export async function readConfig(
	paths: AppPaths,
	plugins: readonly ConnectorPlugin[] = [],
): Promise<SyncdownConfig> {
	const configFile = Bun.file(paths.configPath);
	if (!(await configFile.exists())) {
		return structuredClone(createDefaultConfig(plugins));
	}

	const raw = await configFile.text();
	const parsed = JSON.parse(raw) as Partial<SyncdownConfig>;
	return normalizeConfig(parsed, plugins);
}

export async function ensureConfig(
	paths: AppPaths,
	plugins: readonly ConnectorPlugin[] = [],
): Promise<SyncdownConfig> {
	const configFile = Bun.file(paths.configPath);
	if (await configFile.exists()) {
		return readConfig(paths, plugins);
	}

	const config = createDefaultConfig(plugins);
	await writeConfig(paths, config);
	return config;
}

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
	await mkdir(paths.configDir, { recursive: true });
	await mkdir(paths.dataDir, { recursive: true });
}

export async function writeConfig(
	paths: AppPaths,
	config: SyncdownConfig,
): Promise<void> {
	await ensureAppDirectories(paths);
	const serialized = JSON.stringify(config, null, 2);
	await Bun.write(paths.configPath, `${serialized}\n`);
}

export async function validateManagedOutputDirectory(
	outputDir: string,
): Promise<string | null> {
	try {
		const target = await stat(outputDir);
		if (!target.isDirectory()) {
			return "Output folder must be an empty directory.";
		}

		const entries = await readdir(outputDir);
		if (entries.length > 0) {
			return "Output folder must be completely empty before syncdown can use it.";
		}

		return null;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}

		return "Failed to inspect the output folder.";
	}
}

export async function describeOutputDirectory(
	outputDir: string | undefined,
): Promise<string> {
	if (!outputDir) {
		return "missing";
	}

	try {
		await mkdir(outputDir, { recursive: true });
		await access(outputDir, fsConstants.R_OK | fsConstants.W_OK);
		return outputDir;
	} catch {
		return `${outputDir} (not writable)`;
	}
}
