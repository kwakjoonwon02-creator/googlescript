# 테스트

`src/` 의 파일을 그대로 읽어서 검증합니다. 빌드 단계가 없고 코드 사본도
없으므로, 여기서 통과한 것은 실제로 배포되는 코드입니다.

```bash
cd tests
npm install          # Playwright (브라우저 스위트에만 필요)
npm test             # 전체
npm run test:fast    # Node 전용 스위트만 (브라우저 불필요)
node run.js server   # 스위트 하나만
```

## 스위트

| 스위트 | 대상 | 브라우저 |
|---|---|---|
| `engine` | SRS 회전·킥, 7-bag, 라인 클리어, T-스핀 판정, 공격 테이블, 가비지 삽입/상쇄/상한/지연, 탑아웃, Zen, 직렬화, 봇 완주 | 불필요 |
| `rating` | Glicko-2 (Glickman 2013 논문 예제 대조), RD 수렴, 업셋 보상, TR 변환 단조성 | 불필요 |
| `server` | 계정/토큰, 매칭 페어링과 밴드 확장, 방 상태머신, 연결 끊김, 공격 릴레이, FT3 정산 1회성, 재대결, 방 권한, 백분위 랭크 | 불필요 |
| `template` | `doGet` 이 만드는 페이지를 HtmlService 와 같은 규칙으로 렌더링: 스크립틀릿 잔여물, include 해석과 순서, 모든 `<script>` 블록 파싱, 매니페스트, RPC 목록 일치 | 불필요 |
| `browser` | 실제 Chromium에서 부팅 → 솔로 완주 → CPU 대전 → 랭킹/설정/키 리바인드 → 방 생성 | 필요 |
| `online` | 탭 두 개가 공유 백엔드로 실제 대전: 시드 일치, 가비지 전달, 라운드 판정, TR 정산 | 필요 |

## 어떻게 동작하나

Apps Script 서비스(`SpreadsheetApp`, `CacheService`, `LockService`,
`PropertiesService`)를 `lib/gas-sandbox.js` 에서 메모리 구현으로 대체하고,
`src/*.gs` 를 Node VM 컨텍스트에서 실행합니다. 클라이언트는
`lib/client-sandbox.js` 가 `<script>` 블록을 추출해 같은 방식으로 올립니다.

브라우저 스위트는 `lib/build-page.js` 로 클라이언트를 단일 HTML로 묶습니다.
이 경로는 Apps Script 템플릿을 거치지 않으므로, 템플릿 자체는
`lib/gas-template.js` 가 `<?= ?>` / `<?!= ?>` 규칙을 그대로 흉내 내어
`template` 스위트에서 따로 검사합니다.

- `local` — 목 서버가 페이지 안에서 함께 돌아 탭 하나로 완결됩니다.
- `shared` — RPC가 `serve.js` 로 나가므로 탭 두 개가 한 백엔드를 공유합니다.

시계는 실제 시간으로 흐르되(운영과 동일) 테스트가 오프셋을 밀어
카운트다운과 라운드 간격을 건너뛸 수 있습니다.

## 목 서버로 직접 플레이

```bash
node tests/serve.js       # PORT=xxxxx 출력
```
출력된 포트를 브라우저에서 두 개 열면 배포 없이 대전을 확인할 수 있습니다.
데이터는 메모리에만 있으므로 서버를 끄면 사라집니다.
