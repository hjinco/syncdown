# syncdown

언어: [English](../../README.md) | **한국어** | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md)

`syncdown`은 외부 서비스 데이터를 로컬 파일 시스템의 Markdown으로 동기화하는 인터랙티브 CLI입니다.

많은 AI 워크플로우는 MCP나 각 서비스 API를 통해 Notion, Gmail, Google Calendar 같은 도구에 직접 연결합니다. 이런 방식은 유연하지만, 같은 정보를 반복해서 원격 조회할수록 속도가 느려지고 응답 편차가 커지며 토큰도 더 많이 쓰기 쉽습니다.

`syncdown`은 먼저 데이터를 로컬 Markdown으로 가져오는 방식을 택합니다. 이렇게 만들어 둔 로컬 지식 베이스는 검색, 백업, 버전 관리, 개인 워크플로우 연동에 쓰기 쉽고, 필요하면 [qmd](https://github.com/tobi/qmd) 같은 로컬 인덱서로 후처리할 수도 있습니다. 여러 서비스에 흩어진 정보를 한 곳에서 관리할 수 있다는 점도 장점입니다.

## Install

사전 빌드된 바이너리는 GitHub Releases에 다음 플랫폼용으로 게시됩니다.

```text
darwin-arm64
darwin-x64
linux-x64
windows-x64
```

macOS 및 Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hjinco/syncdown/main/scripts/install.ps1 | iex
```

수동 다운로드는
[GitHub Releases page](https://github.com/hjinco/syncdown/releases)에서도 가능합니다.

## Quick Start

### 1. syncdown 실행

인터랙티브 터미널에서 `syncdown`을 실행합니다.

```sh
syncdown
```

기본 진입점은 전체 화면 TUI를 열고, 여기서 설정과 일상적인 동기화 제어를 할 수 있습니다.

### 2. 출력 디렉터리 선택

TUI에서 **Output**을 열고 Markdown 출력 위치를 선택합니다.

`syncdown`은 동기화된 파일을 이 디렉터리 아래에 저장하고, 설정, 시크릿, 동기화 상태는 별도의 로컬 앱 데이터 디렉터리에 관리합니다.

이 출력 트리 아래의 Markdown 파일과 커넥터 폴더는 `syncdown`이 관리하는 출력물로 보는 편이 좋습니다. 생성된 `.md` 파일이나 폴더를 직접 수정하거나, 이름을 바꾸거나, 이동하거나, 구조를 다시 정리하는 것은 권장하지 않습니다. 이후 동기화나 전체 재동기화 과정에서 다시 생성되거나 덮어써지거나 삭제될 수 있습니다.

### 3. 소스 연결

**Connectors**를 열고 지원되는 소스를 하나 이상 설정합니다.

- **Notion**: 사용자가 Notion 연결에 접근을 허용한 페이지와 데이터베이스 동기화
- **Gmail**: Google OAuth 기반 `Primary` 받은편지함 동기화
- **Google Calendar**: 공유 Google OAuth 계정으로 선택한 캘린더 동기화

### 4. 첫 동기화 실행

TUI 홈 화면에서 **Sync**를 열고 다음 중 하나를 실행합니다.

- **Run all**
- **Run Notion**
- **Run Gmail**
- **Run Google Calendar**

최소한의 헤드리스 설정은 CLI로도 가능합니다.

```sh
syncdown config set outputDir /path/to/output
syncdown config set notion.enabled true
printf '%s' "$NOTION_TOKEN" | syncdown config set notion.token --stdin
syncdown run
```

CLI에서 활성화된 모든 커넥터를 계속 다시 실행하려면 watch 모드를 사용합니다.

```sh
syncdown run --watch
syncdown run --watch --interval 5m
```

`--interval`을 생략하면 기본값은 `1h`입니다.

### 5. 결과 확인

출력 디렉터리에서 커넥터 기준으로 정리된 Markdown 파일을 확인합니다.

현재 상태 확인에는 다음 명령이 유용합니다.

```sh
syncdown status
syncdown connectors
syncdown doctor
```

## How It Works

`syncdown`은 크게 다음 순서로 동작합니다.

1. 로컬 설정을 로드합니다.
2. 암호화된 로컬 시크릿 저장소에서 커넥터 자격 증명을 읽습니다.
3. 활성화된 연동에서 데이터를 가져옵니다.
4. 출력 디렉터리에 Markdown을 렌더링합니다.

렌더링된 파일은 커넥터 기준으로 정리됩니다. 예시는 다음과 같습니다.

```text
notion/pages/project-plan-<source-id>.md
notion/databases/tasks/task-item-<source-id>.md
gmail/account-example-com/2026/03/weekly-update-<message-id>.md
```

렌더링된 Markdown에는 커넥터 메타데이터와 소스별 필드가 YAML frontmatter로 함께 들어가므로, 동기화된 데이터는 읽기용 본문과 구조화된 메타데이터 둘 다로 활용할 수 있습니다.

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

비대화형 설정에는 `syncdown config set <key> <value>` 와 `syncdown config unset <key>` 를 사용합니다.

동기화된 Markdown 출력은 그대로 둔 채 로컬 앱 데이터만 초기화하려면:

```sh
syncdown reset --yes
```

## Connectors

현재 `syncdown`이 지원하는 소스는 다음과 같습니다.

- **Notion**: token 또는 OAuth 인증
- **Gmail**: Google OAuth 및 증분 inbox 동기화

커넥터별 설정 방법, 지원 동작, 현재 제약은 별도 문서에 정리되어 있습니다.

- [Notion connector](./apps/docs/content/docs/connectors/notion.mdx)
- [Gmail connector](./apps/docs/content/docs/connectors/gmail.mdx)

## Docs

더 자세한 가이드는 다음 문서를 참고하세요.

- [Getting Started](./apps/docs/content/docs/getting-started.mdx)
- [Configuration](./apps/docs/content/docs/configuration.mdx)
- [CLI reference](./apps/docs/content/docs/cli.mdx)

문서 앱은 현재 영어 콘텐츠를 기본으로 사용합니다. 한국어 로케일 라우트와 UI는 이미 지원되며, 일부 상세 페이지 콘텐츠는 번역본이 추가되기 전까지 영어 원문을 그대로 사용할 수 있습니다.

## Developing syncdown

소스에서 `syncdown`을 실행하거나, 워크스페이스를 개발하거나, 릴리스 바이너리를 만들려면 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.

이 문서에는 로컬 선행 조건, 핵심 워크스페이스 명령, 패키지 구성, 릴리스 워크플로가 정리되어 있습니다.

## 라이선스

이 저장소는 Apache License 2.0으로 배포됩니다. 자세한 내용은 [LICENSE](./LICENSE)를 참고하세요.

제3자 서비스 약관, 상표, 그리고 사용자가 동기화한 콘텐츠의 권리는 각각 별도의 해당 약관과 권리 체계를 따릅니다.
