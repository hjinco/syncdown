import { expect, test } from "bun:test";

import {
	compareVersions,
	createCliSelfUpdater,
	detectReleaseTarget,
} from "./updater.js";

function createJsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			"content-type": "application/json",
		},
	});
}

function createTextResponse(body: string): Response {
	return new Response(body, { status: 200 });
}

function createBinaryResponse(body: string): Response {
	return new Response(new TextEncoder().encode(body), { status: 200 });
}

test("detectReleaseTarget maps supported platforms", () => {
	expect(detectReleaseTarget("darwin", "arm64")?.displayName).toBe(
		"darwin-arm64",
	);
	expect(detectReleaseTarget("linux", "x64")?.displayName).toBe("linux-x64");
	expect(detectReleaseTarget("win32", "x64")?.displayName).toBe("windows-x64");
	expect(detectReleaseTarget("linux", "arm64")).toBeNull();
});

test("compareVersions sorts semantic versions", () => {
	expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
	expect(compareVersions("cli-v0.2.0", "v0.1.9")).toBeGreaterThan(0);
	expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
	expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
});

test("checkForUpdate reports source-mode installs as unavailable", async () => {
	const updater = createCliSelfUpdater({
		currentVersion: "0.1.0",
		runtime: {
			platform: "darwin",
			arch: "arm64",
			execPath: "/opt/homebrew/bin/bun",
		},
		fetchImpl: (async () =>
			createJsonResponse([
				{
					tag_name: "desktop-v9.9.9",
					prerelease: false,
					assets: [],
				},
				{
					tag_name: "cli-v0.2.0",
					prerelease: false,
					assets: [],
				},
			])) as unknown as typeof fetch,
	});

	const status = await updater.checkForUpdate();
	expect(status.latestVersion).toBe("0.2.0");
	expect(status.hasUpdate).toBe(true);
	expect(status.canSelfUpdate).toBe(false);
	expect(status.reason).toBe("Self-update unavailable in source/dev run.");
});

test("applyUpdate rejects checksum mismatches before install", async () => {
	let installCalls = 0;
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = `${input}`;
		if (url.includes("/releases?per_page=100")) {
			return createJsonResponse([
				{
					tag_name: "desktop-v3.0.0",
					prerelease: false,
					assets: [],
				},
				{
					tag_name: "cli-v0.2.0",
					prerelease: false,
					assets: [
						{
							name: "syncdown-cli-v0.2.0-linux-x64.tar.gz",
							browser_download_url:
								"https://example.test/syncdown-cli-v0.2.0-linux-x64.tar.gz",
						},
						{
							name: "syncdown-cli-v0.2.0-SHA256SUMS.txt",
							browser_download_url:
								"https://example.test/syncdown-cli-v0.2.0-SHA256SUMS.txt",
						},
					],
				},
			]);
		}
		if (url.endsWith(".tar.gz")) {
			return createBinaryResponse("archive-bytes");
		}
		if (url.endsWith("SHA256SUMS.txt")) {
			return createTextResponse(
				"deadbeef  syncdown-cli-v0.2.0-linux-x64.tar.gz\n",
			);
		}
		throw new Error(`unexpected url: ${url}`);
	}) as typeof fetch;

	const updater = createCliSelfUpdater({
		currentVersion: "0.1.0",
		runtime: {
			platform: "linux",
			arch: "x64",
			execPath: "/usr/local/bin/syncdown",
		},
		fetchImpl,
		installUnixReleaseImpl: async () => {
			installCalls += 1;
		},
	});

	await expect(updater.applyUpdate()).rejects.toThrow(/Checksum mismatch/);
	expect(installCalls).toBe(0);
});

test("applyUpdate uses the unix installer on non-Windows targets", async () => {
	let unixCalls = 0;
	let windowsCalls = 0;
	const updater = createCliSelfUpdater({
		currentVersion: "0.1.0",
		runtime: {
			platform: "linux",
			arch: "x64",
			execPath: "/usr/local/bin/syncdown",
		},
		fetchImpl: (async () =>
			createJsonResponse([
				{
					tag_name: "cli-v0.2.0",
					prerelease: false,
					assets: [],
				},
			])) as unknown as typeof fetch,
		downloadReleaseImpl: async () => ({
			release: {
				tag_name: "cli-v0.2.0",
				prerelease: false,
				assets: [],
			},
			target: {
				displayName: "linux-x64",
				archiveExt: ".tar.gz",
				binaryName: "syncdown",
			},
			tag: "cli-v0.2.0",
			archiveName: "syncdown-cli-v0.2.0-linux-x64.tar.gz",
			archiveBytes: new Uint8Array([1, 2, 3]),
		}),
		installUnixReleaseImpl: async () => {
			unixCalls += 1;
		},
		scheduleWindowsInstallImpl: async () => {
			windowsCalls += 1;
		},
	});

	const result = await updater.applyUpdate();
	expect(result.applied).toBe(true);
	expect(unixCalls).toBe(1);
	expect(windowsCalls).toBe(0);
});

test("applyUpdate uses the windows installer on win32 targets", async () => {
	let unixCalls = 0;
	let windowsCalls = 0;
	const updater = createCliSelfUpdater({
		currentVersion: "0.1.0",
		runtime: {
			platform: "win32",
			arch: "x64",
			execPath: "C:\\syncdown\\syncdown.exe",
		},
		fetchImpl: (async () =>
			createJsonResponse([
				{
					tag_name: "cli-v0.2.0",
					prerelease: false,
					assets: [],
				},
			])) as unknown as typeof fetch,
		downloadReleaseImpl: async () => ({
			release: {
				tag_name: "cli-v0.2.0",
				prerelease: false,
				assets: [],
			},
			target: {
				displayName: "windows-x64",
				archiveExt: ".zip",
				binaryName: "syncdown.exe",
			},
			tag: "cli-v0.2.0",
			archiveName: "syncdown-cli-v0.2.0-windows-x64.zip",
			archiveBytes: new Uint8Array([1, 2, 3]),
		}),
		installUnixReleaseImpl: async () => {
			unixCalls += 1;
		},
		scheduleWindowsInstallImpl: async () => {
			windowsCalls += 1;
		},
	});

	const result = await updater.applyUpdate();
	expect(result.applied).toBe(true);
	expect(unixCalls).toBe(0);
	expect(windowsCalls).toBe(1);
});

test("checkForUpdate ignores prerelease and non-cli releases", async () => {
	const updater = createCliSelfUpdater({
		currentVersion: "0.1.0",
		runtime: {
			platform: "linux",
			arch: "x64",
			execPath: "/usr/local/bin/syncdown",
		},
		fetchImpl: (async () =>
			createJsonResponse([
				{
					tag_name: "desktop-v9.9.9",
					prerelease: false,
					assets: [],
				},
				{
					tag_name: "cli-v0.3.0",
					prerelease: true,
					assets: [],
				},
				{
					tag_name: "cli-v0.2.0",
					prerelease: false,
					assets: [],
				},
			])) as unknown as typeof fetch,
	});

	const status = await updater.checkForUpdate();
	expect(status.latestVersion).toBe("0.2.0");
	expect(status.hasUpdate).toBe(true);
});
