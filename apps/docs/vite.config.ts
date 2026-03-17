import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
	server: {
		port: 3000,
	},
	plugins: [
		mdx(await import("./source.config")),
		tailwindcss(),
		tanstackStart({
			prerender: {
				enabled: true,
			},
		}),
		react(),
		// please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
		nitro({
			preset: "cloudflare_module",
			compatibilityDate: "2026-03-17",
			cloudflare: {
				deployConfig: true,
				nodeCompat: true,
				wrangler: {
					name: "syncdown-docs",
				},
			},
		}),
	],
	resolve: {
		tsconfigPaths: true,
		alias: {
			tslib: "tslib/tslib.es6.js",
		},
	},
});
