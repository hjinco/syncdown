import { expect, test } from "bun:test";
import type {
	AppIo,
	SecretsStore,
	SelfUpdater,
	SyncdownApp,
	SyncSession,
} from "@syncdown/core";
import { EXIT_CODES } from "@syncdown/core";

import { launchConfigTui, resolveDocsBaseUrl } from "./index.js";

function createIo() {
	const errors: string[] = [];
	const writes: string[] = [];
	const io: AppIo = {
		write(line) {
			writes.push(line);
		},
		error(line) {
			errors.push(line);
		},
	};

	return { io, errors, writes };
}

function createSecrets(): SecretsStore {
	return {
		async hasSecret() {
			return false;
		},
		async getSecret() {
			return null;
		},
		async setSecret() {},
		async deleteSecret() {},
		describe() {
			return "memory";
		},
	};
}

function createApp(): SyncdownApp {
	return {
		async inspect() {
			throw new Error("should not be called");
		},
		async openSession() {
			return createSession();
		},
		async run() {
			throw new Error("should not be called");
		},
		async reset() {
			throw new Error("should not be called");
		},
		async listConnectors() {
			throw new Error("should not be called");
		},
		async doctor() {
			throw new Error("should not be called");
		},
	};
}

function createSession(): SyncSession {
	return {
		getSnapshot() {
			return {
				status: "idle",
				watch: {
					active: false,
					strategy: null,
					startedAt: null,
				},
				lastRunTarget: null,
				lastRunStartedAt: null,
				lastRunFinishedAt: null,
				lastRunExitCode: null,
				lastRunError: null,
				integrations: [],
				logs: [],
			};
		},
		subscribe() {
			return () => {};
		},
		async runNow() {},
		async startWatch() {},
		async stopWatch() {},
		async cancelActiveRun() {},
		async dispose() {},
	};
}

function createUpdater(supportsSelfUpdate: boolean): SelfUpdater {
	return {
		getCurrentVersion() {
			return "0.1.0";
		},
		supportsSelfUpdate() {
			return supportsSelfUpdate;
		},
		checkForUpdate() {
			return new Promise(() => {});
		},
		async applyUpdate() {
			throw new Error("unused");
		},
	};
}

test("resolveDocsBaseUrl prefers explicit request, then env, then runtime default", () => {
	const previousDocsBaseUrl = process.env.DOCS_BASE_URL;

	try {
		expect(
			resolveDocsBaseUrl({
				app: createApp(),
				io: createIo().io,
				secrets: createSecrets(),
				session: createSession(),
				updater: createUpdater(true),
				docsBaseUrl: "https://custom.example.com",
			}),
		).toBe("https://custom.example.com");

		process.env.DOCS_BASE_URL = "https://env.example.com";
		expect(
			resolveDocsBaseUrl({
				app: createApp(),
				io: createIo().io,
				secrets: createSecrets(),
				session: createSession(),
				updater: createUpdater(false),
			}),
		).toBe("https://env.example.com");

		delete process.env.DOCS_BASE_URL;
		expect(
			resolveDocsBaseUrl({
				app: createApp(),
				io: createIo().io,
				secrets: createSecrets(),
				session: createSession(),
				updater: createUpdater(false),
			}),
		).toBe("http://localhost:3000");
		expect(
			resolveDocsBaseUrl({
				app: createApp(),
				io: createIo().io,
				secrets: createSecrets(),
				session: createSession(),
				updater: createUpdater(true),
			}),
		).toBe("https://syncdown.dev");
	} finally {
		if (previousDocsBaseUrl === undefined) {
			delete process.env.DOCS_BASE_URL;
		} else {
			process.env.DOCS_BASE_URL = previousDocsBaseUrl;
		}
	}
});

test("launchConfigTui rejects non-interactive terminals", async () => {
	const { io, errors } = createIo();
	const stdinDescriptor = Object.getOwnPropertyDescriptor(
		process.stdin,
		"isTTY",
	);
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(
		process.stdout,
		"isTTY",
	);

	Object.defineProperty(process.stdin, "isTTY", {
		configurable: true,
		value: false,
	});
	Object.defineProperty(process.stdout, "isTTY", {
		configurable: true,
		value: false,
	});

	try {
		const exitCode = await launchConfigTui({
			app: createApp(),
			io,
			secrets: createSecrets(),
			session: createSession(),
		});

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toEqual(["`syncdown` requires an interactive terminal."]);
	} finally {
		if (stdinDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
		}
		if (stdoutDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
		}
	}
});
