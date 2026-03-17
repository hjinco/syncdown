import { mkdir, open, rename, rm } from "node:fs/promises";
import type { AppRuntime } from "./runtime.js";
import type { AppPaths } from "./types.js";

const RUN_LOCK_STALE_MS = 6 * 60 * 60 * 1_000;
const RUN_LOCK_HEARTBEAT_MS = 60_000;

interface LockPayload {
	pid?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface RunLockHandle {
	refresh(): Promise<void>;
	release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		return nodeError.code !== "ESRCH";
	}
}

function getLockTimestamp(payload: LockPayload | null): number {
	const rawValue = payload?.updatedAt ?? payload?.createdAt;
	return rawValue ? Date.parse(rawValue) : Number.NaN;
}

async function writeLockPayload(
	paths: AppPaths,
	payload: Required<Pick<LockPayload, "pid" | "createdAt" | "updatedAt">>,
): Promise<void> {
	const tempPath = `${paths.lockPath}.${process.pid}.tmp`;
	await Bun.write(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
	await rename(tempPath, paths.lockPath);
}

export async function acquireRunLock(
	paths: AppPaths,
	runtime: AppRuntime,
): Promise<RunLockHandle> {
	await mkdir(paths.dataDir, { recursive: true });

	while (true) {
		try {
			const now = runtime.now().toISOString();
			const handle = await open(paths.lockPath, "wx");
			await handle.writeFile(
				`${JSON.stringify(
					{
						pid: process.pid,
						createdAt: now,
						updatedAt: now,
					},
					null,
					2,
				)}\n`,
			);
			await handle.close();

			let released = false;
			const createdAt = now;

			return {
				async refresh(): Promise<void> {
					if (released) {
						return;
					}

					await writeLockPayload(paths, {
						pid: process.pid,
						createdAt,
						updatedAt: runtime.now().toISOString(),
					});
				},
				async release(): Promise<void> {
					if (released) {
						return;
					}

					released = true;
					await rm(paths.lockPath, { force: true });
				},
			};
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== "EEXIST") {
				throw error;
			}

			let lockPayload: LockPayload | null = null;
			try {
				const raw = await Bun.file(paths.lockPath).text();
				lockPayload = JSON.parse(raw) as LockPayload;
			} catch {
				// Treat unreadable lock files as stale and replace them.
			}

			const lockTimestamp = getLockTimestamp(lockPayload);
			const hasFreshTimestamp =
				Number.isFinite(lockTimestamp) &&
				runtime.now().getTime() - lockTimestamp < RUN_LOCK_STALE_MS;
			const activePid =
				typeof lockPayload?.pid === "number" && isProcessAlive(lockPayload.pid)
					? lockPayload.pid
					: null;

			if (
				hasFreshTimestamp &&
				(activePid !== null || lockPayload?.pid === undefined)
			) {
				const createdAt =
					lockPayload?.updatedAt ?? lockPayload?.createdAt ?? "unknown";
				const pid = activePid ?? lockPayload?.pid ?? "unknown";
				const lockError = new Error(
					`Another sync is already running (pid=${pid}, started=${createdAt})`,
				);
				lockError.name = "RunLockError";
				throw lockError;
			}

			await rm(paths.lockPath, { force: true });
		}
	}
}

export function startLockHeartbeat(
	lock: RunLockHandle,
	runtime: AppRuntime,
): () => Promise<void> {
	let refreshing = false;
	let refreshPromise: Promise<void> | null = null;
	const handle = runtime.setInterval(async () => {
		if (refreshing) {
			return;
		}

		refreshing = true;
		refreshPromise = (async () => {
			try {
				await lock.refresh();
			} finally {
				refreshing = false;
				refreshPromise = null;
			}
		})();
		await refreshPromise;
	}, RUN_LOCK_HEARTBEAT_MS);

	return async () => {
		runtime.clearInterval(handle);
		await refreshPromise;
	};
}
