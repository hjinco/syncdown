# Contributing to syncdown

This repository is a Bun workspace managed with Turborepo and TypeScript path aliases that point directly at workspace source.

## Prerequisites

- Bun `1.3.10`
- Zig for OpenTUI source builds

Prebuilt release binaries do not require Zig at runtime. Zig is only needed when developing or building the workspace from source.

## Local Development

Install dependencies:

```sh
bun install
```

Common workspace commands:

```sh
bun run build
bun run lint
bun run check
bun run typecheck
bun run test
```

GitHub Actions CI uses Turborepo remote cache via the repository secrets `TURBO_TOKEN` and `TURBO_TEAM`.

Local development does not require Turbo login or a remote cache token. If you later want local runs to participate in the shared remote cache, configure the same Turborepo credentials in your shell environment.

`bun run build` builds packages that emit real artifacts. In this workspace that currently means the docs app.

`bun run typecheck` validates workspace source without emitting a `dist` directory.

For package-scoped runs, use Turbo from the repository root:

```sh
bun run turbo run build --filter=docs
bun run turbo run typecheck --filter=@syncdown/core
bun run turbo run test --filter=@syncdown/connector-notion
bun run turbo run test --filter=@syncdown/connector-gmail
```

## Workspace Overview

- `apps/cli`: CLI entrypoint and command routing
- `apps/docs`: product documentation site content and app
- `packages/tui`: interactive setup and sync dashboard
- `packages/core`: orchestration, config loading, and shared types
- `packages/connector-notion`: Notion sync adapter
- `packages/connector-gmail`: Gmail sync adapter
- `packages/renderer-md`: normalized document-to-Markdown rendering
- `packages/sink-fs`: filesystem write adapter
- `packages/state-sqlite`: SQLite-backed sync state
- `packages/secrets`: encrypted local secret storage

## Release Workflow

User-visible CLI changes should include a changeset:

```sh
bun run changeset
```

Select `@syncdown/cli`, choose the bump type, and summarize the user-facing change.

CLI releases are now published through a Changesets-managed release PR flow on `main`.

Typical flow:

```sh
# feature PR
bun run changeset
git push origin <branch>

# after merge to main
# Changesets opens/updates a release PR
# merging that PR creates a CLI GitHub Release tagged cli-vX.Y.Z
```

The release workflow bumps `apps/cli/package.json`, creates a `cli-vX.Y.Z` tag, builds platform binaries, smoke-tests them, and uploads the release assets.

For local release verification:

```sh
bun run release:binary:local
bun run release:binary:smoke
```

Release binaries are written to `artifacts/release`.
