#!/usr/bin/env bun

import { runCli } from "./program.js";

void runCli().then(
	(exitCode) => {
		process.exit(exitCode);
	},
	(error) => {
		const message =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	},
);
