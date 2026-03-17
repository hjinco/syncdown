# syncdown

言語: [English](../../README.md) | [한국어](./README.ko.md) | **日本語** | [简体中文](./README.zh-CN.md)

`syncdown` は、外部サービスのデータをローカルファイルシステム上の Markdown に同期する対話型 CLI です。

Notion や Gmail のようなツールを接続し、ローカルに Markdown のコピーを保持することで、検索、バックアップ、バージョン管理、自分のワークフローへの組み込みに使えます。

## Install

ビルド済みバイナリは GitHub Releases で次のプラットフォーム向けに配布されます。

```text
darwin-arm64
darwin-x64
linux-x64
windows-x64
```

macOS と Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.ps1 | iex
```

手動ダウンロードは
[GitHub Releases page](https://github.com/hjinco/syncdown/releases)
からも利用できます。

インストールスクリプトは次の環境変数をサポートします。

- `SYNCDOWN_VERSION`: `0.1.0` や `v0.1.0` のような特定バージョンを指定
- `SYNCDOWN_INSTALL_DIR`: インストール先ディレクトリを上書き

## Quick Start

### 1. syncdown を起動

対話型ターミナルで `syncdown` を起動します。

```sh
syncdown
```

デフォルトの起動方法では、設定と日常的な同期操作を行うためのフルスクリーン TUI が開きます。

### 2. 出力ディレクトリを選ぶ

TUI で **Output** を開き、Markdown の出力先を選択します。

`syncdown` は同期したファイルをそのディレクトリ配下に保存し、設定、シークレット、同期状態は別のローカルアプリデータディレクトリに保持します。

この出力ツリー配下の Markdown ファイルとコネクタごとのフォルダは、`syncdown` が管理する出力として扱うのが無難です。生成済みの `.md` ファイルやフォルダを手で編集したり、名前変更・移動・構成の整理し直しをしたりすることは推奨されません。以後の同期やフル再同期で再生成・上書き・削除されることがあります。

### 3. ソースを接続

**Connectors** を開き、対応しているソースを 1 つ以上設定します。

- **Notion**: 共有ページとデータソースの内容を同期
- **Gmail**: Google OAuth を使って `Primary` 受信トレイを同期

### 4. 最初の同期を実行

TUI のホーム画面で **Sync** を開き、次のいずれかを実行します。

- **Run all**
- **Run Notion**
- **Run Gmail**

最小限のヘッドレス設定は CLI からも行えます。

```sh
syncdown config set outputDir /path/to/output
syncdown config set notion.enabled true
printf '%s' "$NOTION_TOKEN" | syncdown config set notion.token --stdin
syncdown run
```

### 5. 結果を確認

出力ディレクトリで、コネクタごとに整理された Markdown ファイルを確認します。

状態確認には次のコマンドが便利です。

```sh
syncdown status
syncdown connectors
syncdown doctor
```

## How It Works

`syncdown` は大まかに次の流れで動作します。

1. ローカル設定を読み込む
2. 暗号化されたローカルシークレットストアからコネクタ認証情報を解決する
3. 有効な連携先からデータを取得する
4. 出力ディレクトリへ Markdown をレンダリングする

生成されるファイルは、コネクタごとに整理されます。典型的なパスは次のとおりです。

```text
notion/pages/project-plan-<source-id>.md
notion/databases/tasks/task-item-<source-id>.md
gmail/account-example-com/2026/03/weekly-update-<message-id>.md
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

非対話型の設定には `syncdown config set <key> <value>` と `syncdown config unset <key>` を使います。

## Connectors

現在 `syncdown` が対応しているソースは次のとおりです。

- **Notion**: token または OAuth 認証
- **Gmail**: Google OAuth と増分 inbox 同期

コネクタごとの設定方法、対応動作、現在の制限事項は別ドキュメントにあります。

- [Notion connector](./apps/docs/content/docs/connectors/notion.mdx)
- [Gmail connector](./apps/docs/content/docs/connectors/gmail.mdx)

## Docs

より詳しいガイドは次を参照してください。

- [Getting Started](./apps/docs/content/docs/getting-started.mdx)
- [Installation](./apps/docs/content/docs/installation.mdx)
- [Configuration](./apps/docs/content/docs/configuration.mdx)
- [CLI reference](./apps/docs/content/docs/cli.mdx)

詳細ドキュメントの本文は現時点では英語が基準です。日本語の docs UI ルートは利用できますが、翻訳済みページがない箇所は英語コンテンツにフォールバックします。

## Developing syncdown

ソースから `syncdown` を実行したい場合、ワークスペースを開発したい場合、またはリリースバイナリを作成したい場合は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

このガイドには、ローカル前提条件、主要なワークスペースコマンド、パッケージ構成、リリースワークフローがまとまっています。

## ライセンス

このリポジトリは Apache License 2.0 の下で提供されます。詳細は [LICENSE](./LICENSE) を参照してください。

サードパーティサービスの利用規約、商標、およびユーザーが同期したコンテンツの権利は、それぞれ別個の適用条件と権利に従います。
