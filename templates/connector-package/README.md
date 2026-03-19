# Connector Package Template

이 템플릿은 새 first-party connector를 추가할 때 시작점으로 쓰기 위한 스캐폴드입니다.

절차:

1. `templates/connector-package`를 `packages/connector-<id>`로 복사합니다.
2. `<id>`, `<label>`, `<connection-kind>`, `<connection-id>` placeholder를 실제 값으로 치환합니다.
3. `packages/connectors/src/index.ts`에 새 plugin factory를 export 목록에 추가합니다.
4. 필요한 auth alias와 config alias를 manifest에 추가합니다.
5. connector 전용 테스트를 작성한 뒤 `bun lint:fix`와 관련 테스트를 실행합니다.
