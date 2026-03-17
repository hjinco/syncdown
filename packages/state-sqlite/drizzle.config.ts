import path from "node:path";

import { defineConfig } from "drizzle-kit";

function resolveStatePath(): string {
	const home =
		process.env.HOME ??
		process.env.USERPROFILE ??
		(process.env.HOMEDRIVE && process.env.HOMEPATH
			? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
			: undefined);

	if (!home) {
		throw new Error(
			"Unable to resolve the user home directory from the environment",
		);
	}

	const dataRoot =
		process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
	return path.join(dataRoot, "syncdown", "state.db");
}

export default defineConfig({
	schema: "./src/schema.ts",
	out: "./drizzle",
	dialect: "sqlite",
	dbCredentials: {
		url: resolveStatePath(),
	},
	strict: true,
	verbose: true,
});
