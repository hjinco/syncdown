# syncdown

Languages: **English** | [한국어](./docs/readme/README.ko.md) | [日本語](./docs/readme/README.ja.md) | [简体中文](./docs/readme/README.zh-CN.md)

`syncdown` is an interactive CLI that syncs external service data into Markdown on your local filesystem.

Many AI workflows connect directly to services like Notion, Gmail, or Google Calendar through MCP or provider APIs. That works, but repeated remote retrieval is often slower, less predictable, and more token-expensive than working from a prepared local knowledge base.

`syncdown` takes a different approach: pull that content into local Markdown first, then browse it, search it, back it up, commit it, or index it with local tools such as [qmd](https://github.com/tobi/qmd). The result is a faster, more portable knowledge base that keeps information from multiple services in one place.

## Install

Prebuilt binaries are published on GitHub Releases for:

```text
darwin-arm64
darwin-x64
linux-x64
windows-x64
```

On macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.ps1 | iex
```

Manual downloads are also available from the
[GitHub Releases page](https://github.com/hjinco/syncdown/releases).

## Quick Start

### 1. Launch syncdown

Start `syncdown` in an interactive terminal:

```sh
syncdown
```

The default entrypoint opens the full-screen TUI for setup and day-to-day sync control.

### 2. Choose an output directory

In the TUI, open **Output** and choose where rendered Markdown should be written.

Treat the Markdown files and connector folders under that output tree as `syncdown`-managed output. It is best not to manually edit, rename, move, or reorganize generated `.md` files or folders there, because later syncs or full resyncs may recreate, overwrite, or remove them.

### 3. Connect a source

Open **Connectors** and set up one or both of the supported sources:

- **Notion** for pages and databases you've allowed the Notion connection to access
- **Gmail** for `Primary` inbox sync through Google OAuth
- **Google Calendar** for selected calendars through the shared Google OAuth account

### 4. Run your first sync

From the TUI home screen, open **Sync** and run:

- **Run all**
- **Run Notion**
- **Run Gmail**
- **Run Google Calendar**

You can also do a minimal headless setup from the CLI:

```sh
syncdown config set outputDir /path/to/output
syncdown config set notion.enabled true
printf '%s' "$NOTION_TOKEN" | syncdown config set notion.token --stdin
syncdown run
```

To keep re-running all enabled connectors from the CLI, use watch mode:

```sh
syncdown run --watch
syncdown run --watch --interval 5m
```

If you omit `--interval`, the default is `1h`.

### 5. Confirm the result

Check your output directory for Markdown files grouped by connector.

These commands are useful for verifying the current state:

```sh
syncdown status
syncdown connectors
syncdown doctor
```

## How It Works

At a high level, `syncdown`:

1. loads your local config
2. loads saved connector credentials
3. fetches data from enabled integrations
4. renders Markdown into your output directory

Rendered files are grouped by connector. Typical paths look like this:

```text
notion/pages/project-plan-<source-id>.md
notion/databases/tasks/task-item-<source-id>.md
gmail/account-example-com/2026/03/weekly-update-<message-id>.md
google-calendar/primary/2026/03/team-sync-<event-id>.md
```

Rendered Markdown includes YAML frontmatter with connector metadata and source-specific fields, so synced data stays available as both readable content and structured metadata.

```md
---
title: "Project Plan"
source: "https://www.notion.so/..."
created: "2026-03-17T01:23:45.000Z"
updated: "2026-03-17T04:56:00.000Z"
database: "Tasks"
status: "In Progress"
due_date: "2026-03-20"
---

# Project Plan

- Confirm scope
- Assign owners
- Track due dates
```

## Common Commands

```sh
syncdown
syncdown status
syncdown connectors
syncdown doctor
syncdown run
syncdown run --watch
syncdown update --check
```

Use `syncdown config set <key> <value>` and `syncdown config unset <key>` for non-interactive configuration.

## Connectors

`syncdown` currently supports:

- **Notion** with token or OAuth auth
- **Gmail** with Google OAuth and incremental inbox sync
- **Google Calendar** with shared Google OAuth and selected-calendar incremental sync

Connector-specific setup details, supported behavior, and current limits are documented separately:

- [Notion connector](./apps/docs/content/docs/connectors/notion.mdx)
- [Gmail connector](./apps/docs/content/docs/connectors/gmail.mdx)
- [Google Calendar connector](./apps/docs/content/docs/connectors/google-calendar.mdx)

## Docs

For more detailed guides, see:

- [Getting Started](./apps/docs/content/docs/getting-started.mdx)
- [Installation](./apps/docs/content/docs/installation.mdx)
- [Configuration](./apps/docs/content/docs/configuration.mdx)
- [CLI reference](./apps/docs/content/docs/cli.mdx)

The docs app defaults to English content today. Locale-aware docs routes now exist for English, Korean, Japanese, and Simplified Chinese, with English content fallback until translated pages are available.

## Developing syncdown

If you want to run `syncdown` from source, work on the workspace, or cut release binaries, see [CONTRIBUTING.md](./CONTRIBUTING.md).

That guide covers local prerequisites, core workspace commands, the package layout, and the Changesets-driven release workflow.

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](./LICENSE).

Third-party service terms, trademarks, and user-synced content remain subject to their own applicable terms and rights.
