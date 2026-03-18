export function withHomeDirectory<T>(homeDir: string, run: () => T): T {
	const previousHome = Bun.env.HOME;
	const restore = () => {
		if (previousHome === undefined) {
			delete Bun.env.HOME;
		} else {
			Bun.env.HOME = previousHome;
		}
	};

	Bun.env.HOME = homeDir;

	try {
		const result = run();
		if (
			result &&
			typeof result === "object" &&
			"then" in result &&
			typeof result.then === "function"
		) {
			return (result as Promise<Awaited<T>>).finally(restore) as T;
		}

		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
}
