import type { SyncIntervalPreset } from "./types.js";

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export interface AppRuntime {
	now(): Date;
	sleep(ms: number): Promise<void>;
	setInterval(
		handler: () => void | Promise<void>,
		ms: number,
	): ReturnType<typeof setInterval>;
	clearInterval(handle: ReturnType<typeof setInterval>): void;
	addSignalListener(signal: NodeJS.Signals, handler: () => void): () => void;
}

export interface SignalWaiter {
	isRequested(): boolean;
	promise: Promise<void>;
	dispose(): void;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function intervalPresetToMs(interval: SyncIntervalPreset): number {
	switch (interval) {
		case "5m":
			return 5 * 60 * 1_000;
		case "15m":
			return 15 * 60 * 1_000;
		case "1h":
			return 60 * 60 * 1_000;
		case "6h":
			return 6 * 60 * 60 * 1_000;
		case "24h":
			return 24 * 60 * 60 * 1_000;
	}
}

export function createRuntime(overrides: Partial<AppRuntime> = {}): AppRuntime {
	return {
		now: overrides.now ?? (() => new Date()),
		sleep: overrides.sleep ?? sleep,
		setInterval: overrides.setInterval ?? globalThis.setInterval,
		clearInterval: overrides.clearInterval ?? globalThis.clearInterval,
		addSignalListener:
			overrides.addSignalListener ??
			((signal, handler) => {
				process.once(signal, handler);
				return () => {
					process.removeListener(signal, handler);
				};
			}),
	};
}

export function createSignalWaiter(runtime: AppRuntime): SignalWaiter {
	let requested = false;
	let resolveSignal: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveSignal = resolve;
	});
	const removeListeners = SHUTDOWN_SIGNALS.map((signal) =>
		runtime.addSignalListener(signal, () => {
			if (requested) {
				return;
			}

			requested = true;
			resolveSignal?.();
		}),
	);

	return {
		isRequested(): boolean {
			return requested;
		},
		promise,
		dispose(): void {
			for (const removeListener of removeListeners) {
				removeListener();
			}
		},
	};
}
