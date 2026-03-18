# syncdown

语言: [English](../../README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | **简体中文**

`syncdown` 是一个 CLI，用于将外部服务中的数据同步为本地文件系统中的 Markdown。

很多 AI 工作流会通过 MCP 或各服务自己的 API 直接连接 Notion、Gmail、Google Calendar 等工具。这种方式很灵活，但当你反复远程读取同一批信息时，通常会更慢、结果更不稳定，也更容易消耗更多 token。

`syncdown` 选择先把这些内容拉到本地 Markdown。这样得到的本地知识库更适合搜索、备份、版本管理和接入个人工作流；如果需要，也可以再交给 [qmd](https://github.com/tobi/qmd) 这样的本地索引工具做后处理。另一个优势是，你可以把原本分散在多个服务里的信息集中到一个地方管理。

## Install

GitHub Releases 提供以下平台的预构建二进制文件：

```text
darwin-arm64
darwin-x64
linux-x64
windows-x64
```

macOS 和 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.ps1 | iex
```

也可以从
[GitHub Releases page](https://github.com/hjinco/syncdown/releases)
手动下载。

## Quick Start

### 1. 启动 syncdown

在交互式终端中启动 `syncdown`：

```sh
syncdown
```

默认入口会打开全屏 TUI，用于完成初始设置和日常同步控制。

### 2. 选择输出目录

在 TUI 中打开 **Output**，选择 Markdown 输出目录。

`syncdown` 会将同步后的文件写入该目录下，并将配置、密钥和同步状态保存在单独的本地应用数据目录中。

建议将这个输出树下的 Markdown 文件和各 connector 目录视为由 `syncdown` 管理的输出。通常不建议手动编辑、重命名、移动或重新整理其中生成的 `.md` 文件和文件夹，因为后续同步或完整重同步时，它们可能会被重新生成、覆盖或删除。

### 3. 连接数据源

打开 **Connectors**，配置一个或多个支持的数据源：

- **Notion**：同步你已授权 Notion 连接访问的页面和数据库
- **Gmail**：通过 Google OAuth 同步 `Primary` 收件箱
- **Google Calendar**：通过共享 Google OAuth 账号同步所选日历

### 4. 执行第一次同步

在 TUI 首页打开 **Sync**，运行以下任一操作：

- **Run all**
- **Run Notion**
- **Run Gmail**
- **Run Google Calendar**

你也可以通过 CLI 完成最小化的无界面配置：

```sh
syncdown config set outputDir /path/to/output
syncdown config set notion.enabled true
printf '%s' "$NOTION_TOKEN" | syncdown config set notion.token --stdin
syncdown run
```

如果你想通过 CLI 持续重新运行所有已启用的 connector，可以使用 watch 模式：

```sh
syncdown run --watch
syncdown run --watch --interval 5m
```

如果省略 `--interval`，默认值是 `1h`。

### 5. 确认结果

检查输出目录中按 connector 组织的 Markdown 文件。

以下命令适合查看当前状态：

```sh
syncdown status
syncdown connectors
syncdown doctor
```

## How It Works

`syncdown` 的整体流程如下：

1. 读取本地配置
2. 从加密的本地密钥存储中解析 connector 凭证
3. 从已启用的集成中抓取数据
4. 将 Markdown 渲染到输出目录

生成的文件会按 connector 分组。典型路径如下：

```text
notion/pages/project-plan-<source-id>.md
notion/databases/tasks/task-item-<source-id>.md
gmail/account-example-com/2026/03/weekly-update-<message-id>.md
```

渲染后的 Markdown 会包含 YAML frontmatter，其中包括 connector 元数据和各数据源特有的字段，因此同步后的数据既可作为可读正文使用，也可作为结构化元数据使用。

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
syncdown reset --yes
syncdown update --check
```

如需非交互式配置，可使用 `syncdown config set <key> <value>` 和 `syncdown config unset <key>`。

如果你想在保留已同步 Markdown 输出的同时，仅重置本地应用数据：

```sh
syncdown reset --yes
```

## Connectors

当前 `syncdown` 支持：

- **Notion**：token 或 OAuth 认证
- **Gmail**：Google OAuth 和增量 inbox 同步

各 connector 的配置方式、支持行为和当前限制见单独文档：

- [Notion connector](./apps/docs/content/docs/connectors/notion.mdx)
- [Gmail connector](./apps/docs/content/docs/connectors/gmail.mdx)

## Docs

更详细的指南请参考：

- [Getting Started](./apps/docs/content/docs/getting-started.mdx)
- [Configuration](./apps/docs/content/docs/configuration.mdx)
- [CLI reference](./apps/docs/content/docs/cli.mdx)

详细文档内容目前仍以英文为主。简体中文 docs UI 路由已经可用，在尚未提供翻译页面的地方，会回退到英文内容。

## Developing syncdown

如果你想从源码运行 `syncdown`、参与工作区开发或构建发布二进制文件，请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。

该文档包含本地前置条件、核心工作区命令、包结构以及发布流程。

## 许可证

本仓库采用 Apache License 2.0 许可。详见 [LICENSE](./LICENSE)。

第三方服务条款、商标，以及用户同步内容的权利，仍分别受其各自适用的条款与权利约束。
