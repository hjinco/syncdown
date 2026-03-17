import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const targetPlatformMap = {
	"darwin-arm64": "darwin-arm64",
	"darwin-x64": "darwin-x64",
	"linux-x64": "linux-x64",
	"win32-x64": "windows-x64",
} as const;

const currentTarget =
	targetPlatformMap[
		`${process.platform}-${process.arch}` as keyof typeof targetPlatformMap
	];

if (!currentTarget) {
	throw new Error(
		`Unsupported local smoke target: ${process.platform}-${process.arch}`,
	);
}

const binaryName = process.platform === "win32" ? "syncdown.exe" : "syncdown";
const binaryPath = path.join(
	rootDir,
	"artifacts",
	"release",
	currentTarget,
	binaryName,
);

function run(binaryArgs: string[], env: NodeJS.ProcessEnv): void {
	const result = Bun.spawnSync({
		cmd: [binaryPath, ...binaryArgs],
		cwd: rootDir,
		env: {
			...Bun.env,
			...env,
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	if (result.exitCode !== 0) {
		throw new Error(
			`Smoke command failed: ${binaryPath} ${binaryArgs.join(" ")}`,
		);
	}
}

const tempRoot = await mkdtemp(
	path.join(resolveTempDirectory(), "syncdown-release-smoke-"),
);
const env = {
	XDG_CONFIG_HOME: path.join(tempRoot, "config"),
	XDG_DATA_HOME: path.join(tempRoot, "data"),
};

try {
	await mkdir(path.join(tempRoot, "output"), { recursive: true });
	run(["--help"], env);
	run(["doctor"], env);
	run(["config", "set", "outputDir", path.join(tempRoot, "output")], env);
	run(["config", "set", "notion.enabled", "true"], env);
	run(["status"], env);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

function resolveTempDirectory(): string {
	return (
		Bun.env.TMPDIR ??
		Bun.env.TMP ??
		Bun.env.TEMP ??
		(process.platform === "win32"
			? Bun.env.LOCALAPPDATA
				? path.join(Bun.env.LOCALAPPDATA, "Temp")
				: undefined
			: undefined) ??
		"/tmp"
	);
}
