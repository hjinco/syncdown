import { chmod, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const cliDir = path.join(rootDir, "apps", "cli");
const releaseRoot = path.join(rootDir, "artifacts", "release");
const version = JSON.parse(
	await Bun.file(path.join(cliDir, "package.json")).text(),
).version as string;
const releaseLabel = `cli-v${version}`;
const targetPlatform =
	Bun.env.SYNCDOWN_TARGET_PLATFORM ?? `${process.platform}-${process.arch}`;

const TARGETS = {
	"darwin-arm64": {
		bunTarget: "bun-darwin-arm64",
		archiveExt: ".tar.gz",
		binaryName: "syncdown",
		displayName: "darwin-arm64",
	},
	"darwin-x64": {
		bunTarget: "bun-darwin-x64",
		archiveExt: ".tar.gz",
		binaryName: "syncdown",
		displayName: "darwin-x64",
	},
	"linux-x64": {
		bunTarget: "bun-linux-x64",
		archiveExt: ".tar.gz",
		binaryName: "syncdown",
		displayName: "linux-x64",
	},
	"windows-x64": {
		bunTarget: "bun-windows-x64",
		archiveExt: ".zip",
		binaryName: "syncdown.exe",
		displayName: "windows-x64",
	},
	"win32-x64": {
		bunTarget: "bun-windows-x64",
		archiveExt: ".zip",
		binaryName: "syncdown.exe",
		displayName: "windows-x64",
	},
} as const;

const target = TARGETS[targetPlatform as keyof typeof TARGETS];

if (!target) {
	throw new Error(`Unsupported release target: ${targetPlatform}`);
}

const targetDir = path.join(releaseRoot, target.displayName);
const binaryPath = path.join(targetDir, target.binaryName);
const archiveName = `syncdown-${releaseLabel}-${target.displayName}${target.archiveExt}`;
const archivePath = path.join(targetDir, archiveName);
const checksumPath = path.join(targetDir, `${archiveName}.sha256`);

function run(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): void {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd: options.cwd ?? rootDir,
		env: options.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	if (result.exitCode !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}`);
	}
}

async function createArchive(): Promise<void> {
	if (target.archiveExt === ".zip") {
		run("powershell.exe", [
			"-NoProfile",
			"-Command",
			`Compress-Archive -LiteralPath '${binaryPath}' -DestinationPath '${archivePath}' -Force`,
		]);
		return;
	}

	run("tar", ["-czf", archivePath, "-C", targetDir, target.binaryName]);
}

async function sha256(filePath: string): Promise<string> {
	return new Bun.CryptoHasher("sha256")
		.update(await Bun.file(filePath).bytes())
		.digest("hex");
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const buildArgs = [
	"build",
	"--compile",
	...(target.displayName === "windows-x64" ? ["--windows-hide-console"] : []),
	"--target",
	target.bunTarget,
	"--outfile",
	binaryPath,
	path.join(cliDir, "src", "bin.ts"),
];

run("bun", buildArgs);

if (target.displayName !== "windows-x64") {
	await chmod(binaryPath, 0o755);
}

await createArchive();
await Bun.write(checksumPath, `${await sha256(archivePath)}  ${archiveName}\n`);

const binaryStats = await stat(binaryPath);
process.stdout.write(
	`${JSON.stringify(
		{
			target: target.displayName,
			releaseLabel,
			archivePath,
			checksumPath,
			binaryPath,
			binarySize: binaryStats.size,
		},
		null,
		2,
	)}\n`,
);
