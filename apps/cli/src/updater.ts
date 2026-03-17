import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdtemp,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SelfUpdater } from "@syncdown/core";

import cliPackageJson from "../package.json" with { type: "json" };

const RELEASE_REPO = "hjinco/syncdown";
const CLI_RELEASE_TAG_PREFIX = "cli-v";
const SOURCE_UNAVAILABLE_REASON = "Self-update unavailable in source/dev run.";
const PLATFORM_UNSUPPORTED_REASON = "Self-update unavailable on this platform.";

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface ReleasePayload {
	tag_name?: string;
	draft?: boolean;
	prerelease?: boolean;
	assets?: ReleaseAsset[];
}

interface ReleaseTarget {
	displayName: "darwin-arm64" | "darwin-x64" | "linux-x64" | "windows-x64";
	archiveExt: ".tar.gz" | ".zip";
	binaryName: "syncdown" | "syncdown.exe";
}

interface RuntimeEnvironment {
	platform: NodeJS.Platform;
	arch: string;
	execPath: string;
}

interface ReleaseDownload {
	release: ReleasePayload;
	target: ReleaseTarget;
	tag: string;
	archiveName: string;
	archiveBytes: Uint8Array;
}

interface CreateCliSelfUpdaterOptions {
	fetchImpl?: typeof fetch;
	currentVersion?: string;
	runtime?: Partial<RuntimeEnvironment>;
	now?: () => Date;
	downloadReleaseImpl?: (
		fetchImpl: typeof fetch,
		runtime: RuntimeEnvironment,
		latestVersion: string,
	) => Promise<ReleaseDownload>;
	installUnixReleaseImpl?: (
		tmpRoot: string,
		archivePath: string,
		execPath: string,
		target: ReleaseTarget,
	) => Promise<void>;
	scheduleWindowsInstallImpl?: (
		tmpRoot: string,
		archivePath: string,
		execPath: string,
		binaryName: string,
	) => Promise<void>;
}

export function createCliSelfUpdater(
	options: CreateCliSelfUpdaterOptions = {},
): SelfUpdater {
	const fetchImpl = options.fetchImpl ?? fetch;
	const currentVersion = options.currentVersion ?? cliPackageJson.version;
	const runtime: RuntimeEnvironment = {
		platform: options.runtime?.platform ?? process.platform,
		arch: options.runtime?.arch ?? process.arch,
		execPath: options.runtime?.execPath ?? process.execPath,
	};
	const now = options.now ?? (() => new Date());
	const downloadReleaseImpl = options.downloadReleaseImpl ?? downloadRelease;
	const installUnixReleaseImpl =
		options.installUnixReleaseImpl ?? installUnixRelease;
	const scheduleWindowsInstallImpl =
		options.scheduleWindowsInstallImpl ?? scheduleWindowsInstall;

	return {
		getCurrentVersion() {
			return currentVersion;
		},
		supportsSelfUpdate() {
			return getSelfUpdateSupport(runtime).canSelfUpdate;
		},
		async checkForUpdate() {
			const release = await fetchLatestRelease(fetchImpl);
			const latestVersion = normalizeVersion(release.tag_name ?? "");
			const support = getSelfUpdateSupport(runtime);

			return {
				currentVersion,
				latestVersion,
				hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
				canSelfUpdate: support.canSelfUpdate,
				reason: support.reason,
				checkedAt: now().toISOString(),
			};
		},
		async applyUpdate() {
			const status = await this.checkForUpdate();
			if (!status.canSelfUpdate) {
				throw new Error(status.reason ?? SOURCE_UNAVAILABLE_REASON);
			}

			if (!status.hasUpdate) {
				return {
					applied: false,
					version: status.currentVersion,
					message: `Already up to date: ${formatVersion(status.currentVersion)}.`,
				};
			}

			const download = await downloadReleaseImpl(
				fetchImpl,
				runtime,
				status.latestVersion ?? status.currentVersion,
			);
			const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "syncdown-update-"));

			try {
				const archivePath = path.join(tmpRoot, download.archiveName);
				await writeFile(archivePath, download.archiveBytes);

				if (runtime.platform === "win32") {
					await scheduleWindowsInstallImpl(
						tmpRoot,
						archivePath,
						runtime.execPath,
						download.target.binaryName,
					);
					return {
						applied: true,
						version: normalizeVersion(download.tag),
						message: `Update installed for ${formatVersion(normalizeVersion(download.tag))}. Restart syncdown.`,
					};
				}

				await installUnixReleaseImpl(
					tmpRoot,
					archivePath,
					runtime.execPath,
					download.target,
				);
				return {
					applied: true,
					version: normalizeVersion(download.tag),
					message: `Update installed for ${formatVersion(normalizeVersion(download.tag))}. Restart syncdown.`,
				};
			} catch (error) {
				throw new Error(formatUpdateError(error));
			} finally {
				if (runtime.platform !== "win32") {
					await rm(tmpRoot, { recursive: true, force: true });
				}
			}
		},
	};
}

export function detectReleaseTarget(
	platform: NodeJS.Platform,
	arch: string,
): ReleaseTarget | null {
	if (platform === "darwin" && arch === "arm64") {
		return {
			displayName: "darwin-arm64",
			archiveExt: ".tar.gz",
			binaryName: "syncdown",
		};
	}

	if (platform === "darwin" && arch === "x64") {
		return {
			displayName: "darwin-x64",
			archiveExt: ".tar.gz",
			binaryName: "syncdown",
		};
	}

	if (platform === "linux" && arch === "x64") {
		return {
			displayName: "linux-x64",
			archiveExt: ".tar.gz",
			binaryName: "syncdown",
		};
	}

	if (platform === "win32" && arch === "x64") {
		return {
			displayName: "windows-x64",
			archiveExt: ".zip",
			binaryName: "syncdown.exe",
		};
	}

	return null;
}

export function compareVersions(left: string, right: string): number {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);

	for (
		let index = 0;
		index < Math.max(leftParts.length, rightParts.length);
		index += 1
	) {
		const leftValue = leftParts[index] ?? 0;
		const rightValue = rightParts[index] ?? 0;
		if (leftValue !== rightValue) {
			return leftValue > rightValue ? 1 : -1;
		}
	}

	return 0;
}

function parseVersion(version: string): number[] {
	const normalized = normalizeVersion(version);
	if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
		throw new Error(`Invalid release version: ${version}`);
	}
	return normalized.split(".").map((value) => Number(value));
}

function normalizeVersion(version: string): string {
	const trimmed = stripReleaseTagPrefix(version.trim());
	if (!trimmed) {
		throw new Error("Missing release version.");
	}
	return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function formatVersion(version: string): string {
	return `v${normalizeVersion(version)}`;
}

function formatReleaseTag(version: string): string {
	return `${CLI_RELEASE_TAG_PREFIX}${normalizeVersion(version)}`;
}

function stripReleaseTagPrefix(version: string): string {
	const matched = version.match(/^[a-z][a-z0-9-]*-(v.+)$/u);
	return matched?.[1] ?? version;
}

function getSelfUpdateSupport(runtime: RuntimeEnvironment): {
	canSelfUpdate: boolean;
	reason: string | null;
} {
	const target = detectReleaseTarget(runtime.platform, runtime.arch);
	if (!target) {
		return {
			canSelfUpdate: false,
			reason: PLATFORM_UNSUPPORTED_REASON,
		};
	}

	const executable = (
		runtime.platform === "win32"
			? path.win32.basename(runtime.execPath)
			: path.basename(runtime.execPath)
	).toLowerCase();
	const expected = target.binaryName.toLowerCase();
	if (executable !== expected) {
		return {
			canSelfUpdate: false,
			reason: SOURCE_UNAVAILABLE_REASON,
		};
	}

	return { canSelfUpdate: true, reason: null };
}

async function fetchLatestRelease(
	fetchImpl: typeof fetch,
): Promise<ReleasePayload> {
	let response: Response;
	try {
		response = await fetchImpl(
			`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`,
			{
				headers: {
					accept: "application/vnd.github+json",
				},
			},
		);
	} catch {
		throw new Error("Failed to reach GitHub Releases.");
	}

	if (!response.ok) {
		throw new Error(
			`Failed to fetch CLI release metadata: HTTP ${response.status}.`,
		);
	}

	const payload = (await response.json()) as ReleasePayload[];
	const release = payload
		.filter(
			(entry) =>
				!entry.draft &&
				!entry.prerelease &&
				typeof entry.tag_name === "string" &&
				entry.tag_name.startsWith(CLI_RELEASE_TAG_PREFIX),
		)
		.sort((left, right) =>
			compareVersions(right.tag_name ?? "", left.tag_name ?? ""),
		)[0];

	if (!release?.tag_name) {
		throw new Error("No stable CLI release metadata was found.");
	}

	return release;
}

async function downloadRelease(
	fetchImpl: typeof fetch,
	runtime: RuntimeEnvironment,
	latestVersion: string,
): Promise<ReleaseDownload> {
	const target = detectReleaseTarget(runtime.platform, runtime.arch);
	if (!target) {
		throw new Error(PLATFORM_UNSUPPORTED_REASON);
	}

	const release = await fetchLatestRelease(fetchImpl);
	const tag = release.tag_name ?? formatReleaseTag(latestVersion);
	const archiveName = `syncdown-${tag}-${target.displayName}${target.archiveExt}`;
	const checksumName = `syncdown-${tag}-SHA256SUMS.txt`;
	const assets = release.assets ?? [];
	const archiveAsset = assets.find((asset) => asset.name === archiveName);
	const checksumAsset = assets.find((asset) => asset.name === checksumName);

	if (!archiveAsset) {
		throw new Error(`Release asset missing: ${archiveName}.`);
	}
	if (!checksumAsset) {
		throw new Error(`Release checksum asset missing: ${checksumName}.`);
	}

	const [archiveBytes, checksumText] = await Promise.all([
		fetchBytes(fetchImpl, archiveAsset.browser_download_url, archiveName),
		fetchText(fetchImpl, checksumAsset.browser_download_url, checksumName),
	]);

	verifyChecksum(archiveBytes, checksumText, archiveName);

	return {
		release,
		target,
		tag,
		archiveName,
		archiveBytes,
	};
}

async function fetchBytes(
	fetchImpl: typeof fetch,
	url: string,
	name: string,
): Promise<Uint8Array> {
	let response: Response;
	try {
		response = await fetchImpl(url);
	} catch {
		throw new Error(`Failed to download ${name}.`);
	}

	if (!response.ok) {
		throw new Error(`Failed to download ${name}: HTTP ${response.status}.`);
	}

	return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(
	fetchImpl: typeof fetch,
	url: string,
	name: string,
): Promise<string> {
	let response: Response;
	try {
		response = await fetchImpl(url);
	} catch {
		throw new Error(`Failed to download ${name}.`);
	}

	if (!response.ok) {
		throw new Error(`Failed to download ${name}: HTTP ${response.status}.`);
	}

	return await response.text();
}

function verifyChecksum(
	archiveBytes: Uint8Array,
	checksumText: string,
	archiveName: string,
): void {
	const expected = checksumText
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.match(/^(?<hash>[a-fA-F0-9]+)\s+(?<file>.+)$/u))
		.find((match) => match?.groups?.file === archiveName)
		?.groups?.hash?.toLowerCase();

	if (!expected) {
		throw new Error(`Missing checksum entry for ${archiveName}.`);
	}

	const actual = createHash("sha256")
		.update(archiveBytes)
		.digest("hex")
		.toLowerCase();
	if (expected !== actual) {
		throw new Error(`Checksum mismatch for ${archiveName}.`);
	}
}

async function installUnixRelease(
	tmpRoot: string,
	archivePath: string,
	execPath: string,
	target: ReleaseTarget,
): Promise<void> {
	await runCommand(
		"tar",
		["-xzf", archivePath, "-C", tmpRoot],
		"Failed to extract update archive.",
	);

	const extractedBinaryPath = path.join(tmpRoot, target.binaryName);
	const executableDir = path.dirname(execPath);
	const stagedPath = path.join(executableDir, `${target.binaryName}.next`);

	await stat(extractedBinaryPath).catch(() => {
		throw new Error(`Extracted update did not contain ${target.binaryName}.`);
	});
	await chmod(extractedBinaryPath, 0o755);
	await copyFile(extractedBinaryPath, stagedPath);
	await chmod(stagedPath, 0o755);
	await rename(stagedPath, execPath);
}

async function scheduleWindowsInstall(
	tmpRoot: string,
	archivePath: string,
	execPath: string,
	binaryName: string,
): Promise<void> {
	const extractDir = path.join(tmpRoot, "expanded");
	const helperPath = path.join(tmpRoot, "apply-update.ps1");
	const helperScript = [
		'$ErrorActionPreference = "Stop"',
		"param(",
		"  [string]$ArchivePath,",
		"  [string]$DestinationPath,",
		"  [string]$ExtractDir,",
		"  [string]$BinaryName",
		")",
		"",
		"for ($attempt = 0; $attempt -lt 120; $attempt += 1) {",
		"  try {",
		"    if (Test-Path -LiteralPath $ExtractDir) {",
		"      Remove-Item -LiteralPath $ExtractDir -Recurse -Force",
		"    }",
		"    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null",
		"    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractDir -Force",
		"    Copy-Item -LiteralPath (Join-Path $ExtractDir $BinaryName) -Destination $DestinationPath -Force",
		"    Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue",
		"    Remove-Item -LiteralPath $ExtractDir -Recurse -Force -ErrorAction SilentlyContinue",
		"    exit 0",
		"  } catch {",
		"    Start-Sleep -Seconds 1",
		"  }",
		"}",
		"",
		'throw "Timed out waiting for syncdown.exe to exit."',
	].join("\n");

	await writeFile(helperPath, helperScript, "utf8");

	const child = spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			helperPath,
			"-ArchivePath",
			archivePath,
			"-DestinationPath",
			execPath,
			"-ExtractDir",
			extractDir,
			"-BinaryName",
			binaryName,
		],
		{
			detached: true,
			stdio: "ignore",
		},
	);
	child.unref();
}

async function runCommand(
	command: string,
	args: string[],
	failureMessage: string,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
		});

		child.once("error", (error) => {
			reject(new Error(`${failureMessage} ${error.message}`));
		});
		child.once("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`${failureMessage} ${command} exited with code ${code ?? "unknown"}.`,
				),
			);
		});
	});
}

function formatUpdateError(error: unknown): string {
	if (error instanceof Error) {
		if ("code" in error && (error as NodeJS.ErrnoException).code === "EACCES") {
			return "Permission denied while installing the update.";
		}
		if ("code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
			return "Operation not permitted while installing the update.";
		}
		return error.message;
	}

	return "Unknown update failure.";
}
