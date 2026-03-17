# docs

`apps/docs` is the TanStack Start + Fumadocs documentation app for `syncdown`.
It builds with Nitro and deploys to Cloudflare Workers.

## Local development

Run the Vite dev server:

```bash
bun run --cwd apps/docs dev
```

## Production build

Build the Cloudflare Worker bundle and generated Wrangler config:

```bash
bun run --cwd apps/docs build
```

The build output is written to `.output/`, including:

- `.output/public` for static assets
- `.output/server/index.mjs` for the Worker entrypoint
- `.output/server/wrangler.json` for deployment and local preview

## Local preview

Preview the built Worker through Wrangler:

```bash
bun run --cwd apps/docs preview
```

## Manual deploy

Set these environment variables first:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

Then deploy:

```bash
bun run --cwd apps/docs deploy
```

The default Worker name is `syncdown-docs`.

## GitHub Actions deploy

Production deploys run from `.github/workflows/docs-deploy.yml` via manual
`workflow_dispatch` only.

Repository secrets required by the workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Custom domains

Custom domains, routes, and any future Cloudflare bindings should be managed in
Cloudflare configuration. The app does not commit a root `wrangler.json`; Nitro
generates the deployment config during the build.
