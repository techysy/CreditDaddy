# 변경 로그 (한국어)

최근 릴리스의 한국어 번역. 전체 기록(중국어)은 [CHANGELOG.md](./CHANGELOG.md) 참조.

---

## [1.8.5] (2026-11-27)

테마:**4개 라인 통합 정식 버전——QuWork 제품 라인 신규 + Croli 복구 + AutoClaw(즈푸/AutoGLM) 전면 연결 + mirasim 할당을现行的 '건별 만료' 기준으로 전환. 프록시 끊김 프로세스 단위 가드 완료(issue #72) / 테스트 인스턴스가 사용자 패널을 가로채지 않음(포트 은폐 수정) / 패널 '읽을 수 없음 ≠ 없음' 경험 수정 / 공지 동봉 폴백과 스테이징 게이트 마감**.

- **QuWork 제품 라인 신규(quwork.cn,RenRenZu QurWork 데스크톱과 동일한 계정 체계)**: 프로토콜은 10Router `open-sse/shared/quwork`(quwork-auth@0.1.0 MIT, 10R 실운영 중)에서 그대로 가져왔고本机 실측 교차 검증. 단일 라인으로 국제/국내 구분 없음——
  - **본머신 수확(읽기 전용)**: `%APPDATA%\qurwork-desktop\qurwork-desktop.sqlite`의 `auth_session` 평문 스냅샷(accessToken JWT 30일 + llmToken sk- + 사용자 정보)을 `node:sqlite` 읽기 전용으로 직접 읽음. 클라이언트 실행 중에는 DB 잠금이 걸려 라이브러리 전체 복사 폴백. 계정명(휴대폰 번호)은 마스킹, device identifier는 uid로 결정적으로 파생. `QUWORK_DATA_DIR`과 테스트 주입 훅으로 실머신 라이브러리를 격리(qwenwork 사고와 같은 규율).
  - **매일 체크인**: `/api/user/daily-reward/status|claim`은 **status 게이팅 3태**——`can_claim`일만 수령, `claimed=true / can_claim=false`는 수령 완료, `wechat_required`는 별도 분류로 안내. **claim을 막 때리지 않음**(10R `quworkClaimDailyReward`와 같은 규율). `/api/user/refresh`는 구 access를 새 token으로 교체(비회전: 실측상 갱신 후에도 구 token이 자체 exp까지 유효——복사본 둘이各自 갱신해도 서로 무효화하지 않음).
  - **초대 코드**: `/api/invite/summary`로 자기 코드와 사용 진척도를 얻고, 계정 행에 '입력 / 내 코드' 두 버튼.
  - **중국 대륙 외 IP는 일괄 405**: 알리클라우드 WAF 차단. 오류는 사람이 읽는 말로 바꾸고 아웃바운드 프록시를 안내.
  - **10Router 동기화**: 10R 기본 내장 quwork 채널(registry `authModes:['oauth']`, apikey 채널은 400——qwenwork 교훈대로, 패널 비밀번호 경유의 transfer 채널로만 연결 생성). 내보낼 때 accessToken을 10R의 `refreshToken` 칸에 복사(QuWork엔 별도 rt가 없고 구 access 자체가 갱신 자격). 할당 카드는 push 안 함(10R 연결이 자체 발급). 추론용 llmToken은 10R에 넣지 않음. **동기화 계정은 `accountSync.providers` 화이트리스트도 통과해야** 하므로, 옛 설정의 비어 있지 않은 체크 스냅샷이 새 채널을 조용히 제외하는 문제(qwenwork 0 연결과 동일 유형)를 막고자 채널 목록을 **v3**로 올려 quwork를 병합.
  - 패널 연결 지점 일식(내비 + cnt, VIEWS, PROD_ICONS, PRODUCTS/COMPONENTS, PROV, CHECKIN_PRODUCTS, CLIENT_LABEL, EMPTY_TIP / LOCAL_HINT, 계정 행 두 버튼, '내 초대 코드' 모달, desktop `open-quwork-client` IPC). i18n 4개 사전 +54 항목, `test/quwork.test.js` 16 케이스.
  - ⚠ **출시 전에 잡은 잠재 회귀**: AutoClaw 라인 병합 시 충돌 처리가 `quwork: 'quwork'` 맵핑 행을 통째로 삼켰는데 패널은 여전히 '동기화 가능'으로 표시——동기화가 제품 라인 전체를 오류 없이 조용히 건너뛰는 상태(당시 croli가 채널 화이트리스트에 막힌 사고와 동일 유형). 원형대로 복원하고 맵핑 테이블에 croli / quwork 명시 어서션을 추가(`src/tenrouterAccounts.js:38`).
- **Croli 제품 라인 복구(1.8.4-test.21 은퇴에서 복귀)**: test.28 설치 파일은 커된 브랜치에서 패키징되어 Croli 구현一式(은퇴 커밋에서 삭제 후 재커 안 됨)이包里 없었고, 반면 패널 VIEWS엔 croli가 남아 있어——오래된 croli 계정을 열면 '할당 읽기 실패: 해당 제품 라인은 은퇴됨'(daemon 410), 그런데 체크인 배지는 본지 이력으로照常 점등. 반은 좋고 반은 나빠 보여 인터페이스 문제로 오인하기 쉬웠다.本版에서 라인 전체를 재커하고 복구:
  - **본머신 수확과 하드 전환**: `%APPDATA%\Croli\auth.json` 평문 직접 읽기(공식 sidecar 자동 갱신) + Clerk JWT `sub`로 계정 귀속 + 하드 전환(셸과 sidecar 종료 → auth.json 원자적 쓰기 → 지연 재확인). Loomy / DuMate와 같은 규율.
  - **Clerk OAuth PKCE 데스크톱 로그인**: `clerk.croli.net/oauth/authorize` + `/oauth/token`, loopback 콜백. Google 로그인 슬롯 공유(4개 라인 공유: croli / trae-intl / minimax-global / qoder).
  - **체크인 / 할당 / 초대 코드**: `ds.croli.net/credits` 프로토콜(`ops/home`에서 daily-checkin 행을 찾은 뒤 claim, `status=claimed`면 막 때리지 않고 즉시 already. 잔액 + trial 할당 구조. 초대 코드는 `rotate:false`로 읽기 전용, 회전 없음. redeem으로 코드 입력).
  - **10Router 동기화**: 10R 기본 croli 채널(#156) 정식 개방(그동안 패널은 '순수 로컬'로 표시해 10R와 기준이 충돌)——채널 목록 v1→v2로 옛 설정 화이트리스트에 양 라인 병합, access-only 동기화(Clerk rt는 단일 회전, 복사본 둘은 반드시 서로 무효화) + 30분마다 access 자동 재push. 할당 카드는 push 안 함(10R 연결이 자체 발급, 이중 계산 없음).
  - **사용량 동기화**: croli를 일곱 번째 소스로 추가(`token_usage_turn` 턴 단위 장부), sourcesVersion 4.
  - 연결 지점은 accounts / constants / providers / daemon 라우트 / checkin / authDevice / panel / transfer를 망라. 'Croli 은퇴' 공지 조항 삭제(온라인 소스 쪽은 대외 동작이라 별도 처리). `scripts/stage-bundle.js`도 동시入库(아래 참조). '은퇴' 테스트는 복구 상태로 반전화 + tenrouter 사례.
- **AutoClaw(즈푸/AutoGLM 데스크톱) 제품 라인 신규**: 10Router의 양 라인 기준으로 연결(프로토콜 단일 진실 출처 = `10router/open-sse/shared/autoclaw/`, 자체 엔드포인트 없음). 두 provider를 한 페이지로 통일: `autoclaw`(국제판, Z.AI 계정, `autoglm-api.autoglm.ai`)와 `autoclaw-cn`(국내판, +86 SMS 계정, `autoglm-api.zhipuai.cn`)——서로 독립인 두 계정 체계, token은 도메인을 넘지 않음. 귀속은 자격증명 JWT의 `source_id`(`agent*` = 국내).
  - **본머신 가져오기(읽기 전용)**: `%APPDATA%\autoclaw\auth.json`의 Electron safeStorage 자격을 복호화(`qoderApp.safeStorageCodec`의 Local State + DPAPI + v10 AES-256-GCM을 재사용, 두 번째 구현 없음). 읽기 전용, 클라이언트 파일에 쓰지 않음. `_setDetectForTests` / `_setCodecForTests` 추가——AutoClaw를 설치한 머신에서 테스트해도 실머신 디렉터리에 전혀 손대지 않음(qwenwork 사고와 같은 가드레일).
  - **매일 체크인**: 태스크 면 `POST …/proxy/autoclaw-task-complete`(`task_id: daily_signin`, 서버 측 멱등). 3태는 기존 체크인 기준에 대응(checked-in + 포인트 + 연속일 / already / failed), 성공 시 `balanceAfter`(지갑 총액)을 기존 저장 경로로 write-back. 업무일은 북경시간 0시 기준 날짜 갱신(상류와 일치).
  - **할당**: 순수 포인트 장부로 총량도 리셋 주기도 없음. 주 행은 지갑 `total_balance`, 0 아닌 분류 지갑(보너스/매일/구독/추가팩/기타)은 상세 행, task-list를 읽을 땐 체크인 상태 행 추가. **읽 못 하면 반드시 오류, 0으로 보고하지 않음**(10R와 같은 기준).
  - **자격 규율(이 라인에서 가장 중요)**: refresh token은 단일 회전식이고, 본머신 AutoClaw 클라이언트도 같은 체인을 갱신함. 값 취득 순서 = 계정 저장소 access가 미만료면 그대로 → 만료면 **본머신 auth.json 재읽기**로 클라이언트의 최신 쌍에 맞춤(부작용 0, rt 태우지 않음) → 둘 다 만료일 때만 CD가 대리 갱신('데스크톱은 다음 갱신 시 재로그인을 요구합니다'를 정직하게 안내). **클라이언트 파일에는 절대 write-back하지 않음.** 귀속 검증도 추가——클라이언트가 다른 계정으로 전환한 뒤 B의 자격이 A의 계정 행에 이어지는 일 없음.
  - **10Router 동기화(2026-11-26 기준 (a) 확정)**: **CD가 SMS 직접 로그인으로 만든 전용 보조 계정만** 동기화——그 계정은 데스크톱 클라이언트에 로그인되어 있지 않아 rt 보유자가 CD 하나뿐이므로, croli와 같은 'rt 제거 후 access만 push + 30분 자동 재push'(`resyncAutoclawAccess` / `startAutoclawResyncWatch`, 계정 저장소만 읽고 상류엔 절대 요청 안 함). **본머신 수확 계정은 일체 동기화하지 않음**(사용자가 세 선택지 '동기화 안 함 / access-only / 완전 rt 쌍' 중 첫 항목을 결정, 이유는 여전히 유효: rt 단일 회전 + 데스크톱 + CD + 10R 세 복사본은 필연히 서로 무효화——meoo 사건보다 CD가 관리 못 하는 사본이 하나 더 많음). 합격 판정은 `canSyncAutoclawAccount()`에 집중, 동기화 그룹 루프에서 하드 차단하고 이유를 summary에 기록. 채널 동기화 표(`AM_CHANNELS`)는 양 라인을 올리되 `pushable:false`(할당 카드는 10R 연결 자체에서 발급).
  - **국내판 SMS 직접 로그인(신규 `src/autoclawAuth.js`)**: `agent-send-code` → `agent-login/`(인증코드는 숫자로 전송, 엔드포인트에 꼬리 슬래시 필수, 10R `autoclaw-cn.js`와同源). **device_id 철칙**: 실측상 본머신 `auth.json.deviceId`와 자격증명 JWT의 `device_id` claim이 바이트 단위로 동일. 따라서 CD 로그인은 자체 파생(MachineGuid + 고정 네임스페이스)하여 저장 후 재사용해야 함——본머신 것을 쓰면 같은 기기에서 두 계정 로그인이 되어 데스크톱 클라이언트 세션을 밀어냄. 같은 uid에 본머신 수확 계정이 있으면 **병합 거부**(그렇지 않으면 uid 중복 검사가 본머신 계정을 그 자리에서 '동기화 가능'으로改写). 국제판 OAuth는 하지 않음: 알리클라우드 슬라이더 영수증은 브라우저에서만 생성되고, 콜백 `localhost:18432`이 데스크톱 클라이언트와 포트를争.
  - **초대 코드(클라이언트 app.asar 역분석으로 실제 엔드포인트 확보, 'API 기준 없음' 전제를 뒤집음)**: `fission-v2/status`(자기 코드 + 바인딩 상태 + 남은 슬롯 + 이벤트 창), `fission-v2/online-activity-info`, `fission-v2/bind`. 읽기 전용 실측으로 자기 코드와 보너스 기준 확보(초대자 1000 포인트 × 제한 15명 × 30일, 초대받은 쪽은 상류 설정 0). 패널 문구는 사실대로 쓰고 Loomy의 '양쪽 +5000'을 옮겨 적지 않음. ⚠ 상류 `bind_inviter_reward_event="bind_and_query"`: status 읽기도 보너스 정산에 관여하므로 모달 열 때만 읽고 폴링에 절대 넣지 않음. `bind`는 부작용 있고 계정당 1회. 코드는 준비됐지만 실제 상류엔 발사한 적 없음. 추천 풀 `AUTOCLAW_INVITE_POOL`은 첫 버전 일부러 비움(AutoClaw 코드는 8자 + `CN` 접두로 Loomy의 6자와 형태가 다름).
  - **하지 않는 것**: QR / 웹 세션 캡처, 패널 계정 전환(`switchTo`는 안내와 함께 오류 고정——전환은 클라이언트에서 로그인 후 재가져오기. 읽기 전용에서는 write-back이 클라이언트 종료 시 메모리의 구 로그인에 덮어써짐), 본머신 사용량 동기화 소스.
  - 패널 연결 지점 일식: 내비 버튼 + cnt, VIEWS, PROD_ICONS, PRODUCTS/COMPONENTS, PROV 양 라인, CHECKIN_PRODUCTS, EMPTY_TIP, LOCAL_HINT, AM_CHANNELS, 페이지 머리 '클라이언트 열기'(desktop IPC `open-autoclaw-client` 포함), 계정 카드 초대 코드 두 버튼, 'AutoClaw 휴대폰 로그인' 탭. 머리 위 두 줄 긴 설명은 한 줄 요약 + '설명' 모달로簡略화(사용자 피드백으로过长). 아이콘 세 지점(내비 inline img / PROD_ICONS / prodIcons.json)은 `src/assets/providers/autoclaw.png`와 바이트 일치(공식 주황 집게발은 클라이언트 app.asar에서 추출). i18n 신규 93 항목을 en/ja/ko/zh-TW에 동기화(게이트 클린).
  - 회귀: `test/autoclaw.test.js` 48 케이스(프로토콜 순수 함수, 체크인 3태, refresh의 400002 퇴로와 dual host 판정, 할당 형태와 '읽 못 하면 0 아님', 임시 디렉터리 + 주입 codec 수확, 귀속 검증, 자격 오케스트레이션 3태, 초대 코드 세 엔드포인트와 normalize, SMS 2단계와 device_id 파생, **안전선 두 케이스**: 본머신 계정은 동기화 집합에 절대 안 들어감 / 같은 uid 본머신 계정은 병합 거부로 원 행 그대로, 등록 지점 일식). 타당성 보고는 `docs/autoclaw-login-invite-sync-feasibility.md`.
- **mirasim 계정 할당을现行 기준(건별 만료)으로 변경**: mirasim은 더 이상 '5h 롤링 창 / 7d 전역 상한 / 모델별 상한'으로 할당을 지급하지 않는데 CD 쪽은 여전히 구 `/v1/limits` 구조를 읽어 패널에 구 요금제를 보여 주고, 30d 풀의 자리채움 `reset_at`(2126년)을 '36492일 후 리셋'으로 계산했다. mirasim 설정 › 할당 페이지를 기준으로 다시 만듦:
  - **주 데이터 소스**를 relay `/v1/credits/activity`의 `balance.lots`로 변경——건별 유효기간, 만료 빠른 것부터 소진. 인터페이스의 '분' 단위는 ÷100으로 표시하고, 건별 잔여와 만료일이 mirasim 할당 페이지와 자릿수 단위로 일치.
  - **공간 할당**은 `/v2/machines/:nodeId/credit`에서 읽음(nodeId는 클라이언트 setting.json의 cloudAttachState 유래). `me.remaining`이 null이면 무제한.
  - **각 에이전트 개별 설정의 할당 소스**는 본머신 `collab/person-agent-routes.json`(uid별, 값은 local/cloud만, 호스트 검증 기준과 일치)에서 읽고, 카드에 '…등 N개가 개별 할당 소스 설정'으로 나열.
  - `/v1/limits`는 폴백 신호로 강등: 단일 풀은 budget-used를 잔액으로, 다중 창은 창 행만. 5h/7d 아닌 창은 resetAt을 출력하지 않음(자리채움 카운트다운 제거).
  - 마지막 건을 초과 소진하면 서버 잔액이 음수(실측 -2.27 분): 표시는 0으로 클램프하고 소진 상태는 `exhausted`로 표현.
  - '본머신 계정' 수와 사용량에 **대외 인터페이스 없음**(후보 경로 모두 404, 호스트는 websocket 프레임만). 설명 문구는 읽을 수 없음을 정직하게 표기. 4개 언어 동기화.
- **사용량 동기화 두 건 수정(mirasim 소스, 실측된 공급 중단 해소)**:
  - **이중 쓰기 중복 제거가 계정을 삼킴(11-18 이후 이 소스에서 1행도 못 나감)**: mirasim은 2026-11-18 이후 중계 호출마다 먼저 0-token 자리채움 행, 이어서 같은 id의 확정 행을 씀. `collectMirasim`의 옛 '먼저 온 것 우선' id 중복 제거는 자리채움 행이 자리를 차지해 0-token 필터로 걸러지고, 확정 행은 중복로 버려졌다(실측 usage 파일 relay 181행, 전송 가능 0행). **같은 id를 먼저 대표 행으로 병합(token 합 최대, 동률이면 앞선 것)한 뒤 필터**로 변경, 타임스탬프와 10R 행 서명은 확정 행 기준. 'viaRelay 행만 동기화' 기준은 불변. 수정 후 11월은 84행 / 4367만 token 전송 가능, 8〜10월 월별 행수는 불변(513/5873/5236). 소급 보충은 워터마크 2일 소회로 자동, 수동 정리 불필요. 테스트의 `us.collectMirasim ? … : null` 조용 생략도 직접 어서션으로 변경——이번 공급 중단을 놓친 원인이 바로 그것.
  - **antigravity 직접 연결을 동기화에 예외 채택**: 'viaRelay 행만 동기화'의 전제는 직접 연결 행의 상류가 본머신 10Router이고 10R이 이미 자체 장부化处理한다는 것. antigravity에선 이 전제가 성립하지 않음——mirasim 내장 에이전트로, `agy.exe`가 Google 공식에 직접 연결(`cloudcode-pa` / `generativelanguage.googleapis.com`). mirasim 클라우드 중계도 10R도 거치지 않음(NAS에도 본머신 인스턴스에도 gemini 채널 없음). 양쪽 모두 자국 없음 = 안 보내면 영구 누락(실측 64행 / 2.4억 token, 11-09 이후에도 계속 증가). 채택 판정은 **`provider==='antigravity'`**(agent는 쓰지 않음——다른 에이전트의 직접 연결 행을 연좌시키지 않도록). 0-token 필터와 SETTLE 창은 기존대로 유효. 장래 10R에 gemini 채널이 생기면 그 행은 10R의 upstreamHost를 띄어 `isSelfHostedUpstream`이 먼저 걸러 이중 장부화하지 않음. **이 기준을 건드리기 전에 반드시 물을 것: 이 장부가 10R 쪽에 기록되어 있는가.**
- **프록시 끊김으로 데몬이 죽지 않게 됨(issue #72, PR #73 + PR #74)**: `src/zcodeClient.js`의 `fetchViaProxy()`에 있던 "'error'를 받는 사람이 없음 → Node가 Unhandled 'error' event로 프로세스 종료" 위험 지점을 모두 막았다——① 스트리밍 응답의 `PassThrough`(상류가 body 도중 끊으면 `pass.destroy(err)`가 호출자의 body 읽기보다 먼저 'error'를 발생. 1.8.3은 운영에서 3연속 크래시, 최장 19시간 정지. 10Router의 zcode/trae/minimax-free 채널이 전부 `ECONNREFUSED 127.0.0.1:47860`이 됨); ② CONNECT 터널을 `https.request`에 넘기기 직전의 `tlsSocket`(같은 함수 내 같은 유형 창, 보고자가 기록한 2026-10-05 크래시가 여기); ③ `connectTunnel()`이 resolve하는 맨 socket(CONNECT 성공에서 TLS 인수 사이에 `await`로 마이크로태스크를 넘기는 틈이 있고, 이때 프록시가 끊겨도同樣 프로세스가 죽음. PR #74). 세 곳 모두 프로세스 단위 상승만 막고, 오류는 기존대로 호출자에게 던짐(실패해야 할 요청은 여전히 실패)——시맨틱 불변. 또한 PR #74에서 `tlsSocket`을 **핸드셰이크 완료까지 await**로 변경——핸드셰이크 실패는 일반적인 request 오류로서 즉시 호출자에게(`fetchJsonRace`는 기존대로 다른 경로로 폴백). 핸드셰이크 구간이 외부 취소의 관리 아래에 들어, 그동안 request 미생성으로 signal도 timeout도 연결돼 있지 않아 블랙홀 프록시가 호출 사슬 전체를 걸어둘 수 있었던 구멍이 막힘. 회귀: `test/zcode-proxy-stream.test.js`는 본머신 가짜 프록시로 결정적으로 재현(body 절반 쓰고 끊기 / CONNECT 후 끊기 / 터널 안 TLS 정경로와 자기서명 부경로 / **핸드셰이크 고착을 abort로 끊기**). mock 없이 실제 `fetchViaProxy`를 돌리고 오프라인 실행 가능. NAS(fnOS node v24.22.3, 보고자와 동일 런타임) 실측: 1.8.3 실제 모듈 + 가짜 프록시 끊기로 exit 1, 운영 크래시 스택 재현. `zcodeClient.js` 파일 하나만 핫 스왑하면 exit 0으로 생존. 1.8.3 + 핫 스왑 파일로 실제 daemon을 0.0.0.0 바인딩해 LAN 밖에서 운영 경로 트리거——패널 응답 지속, pid 불변. 투고·보고해 주신 @susheelg1197께 감사.
- **포트 은폐와 `startDaemon(0)` 포트 강탈 수정('메인 프로그램이你们的 테스트 환경으로 바뀜 / 잠시 깜빡임' 근본 원인)**: 두 겹 중첩——① `startDaemon(0)`의 0이 `Number(port) || DEFAULT_PORT`에서 47860으로 뭉개짐. 테스트 패밀리는(daemon-listen / cookiesites / announcements / qoder-current-token / quota-refresh / hardening / croli-retired) 'OS에 빈 포트 맡기기' 의도였는데 실제로는 전부 정식 설치판의 기본 포트를抢占. `requested === 0`일 때 0을 그대로 listen에 넘기는(ephemeral) 방식으로 수정. ② Windows에선 같은 포트에 0.0.0.0 와일드카드 바인드와 127.0.0.1 정확 바인드가 **공존 가능**(양방향 모두 성공하고 EADDRINUSE 발생 안 함)하고, 루프백 트래픽은 정확 바인드 쪽에 귀속. 정식 인스턴스가 LAN 게이트웨이 열면 0.0.0.0:47860(실 데이터 디렉터리), 테스트 인스턴스는 127.0.0.1:47860(%TEMP%)을 조용히 잡아 본머신 패널 트래픽을 통째로 가로챔(타이틀바의 데이터 디렉터리가 Temp가 되고 계정은 테스트 스텁만). 종전 버전 자가 프로브는 `/api/status`의 version 의존이었는데 패널 접근 비밀번호를 켜면 401에 version이 없어——방어선이 실명. daemon.json의 단일 인스턴스 가드는 데이터 디렉터리로 생존 인스턴스를 찾으니 디렉터리가 다른 둘은 서로 못 봄. 수정: listen 성공 후 netstat으로 같은 포트의 다른 PID를 셈(`foreignListenerPids`, 비동기 execFile로 Electron 본체 얼리지 않음. 판정 기준은 인증과 무관하고 상대 응답에도 의존 안 함). 있으면 양보해 포트 변경——**같은 포트 이중 제공 절대 안 함**. 회귀 `test/daemon-port-shadow.test.js`(5 케이스, 프로세스 간 은폐 재현 포함).
- **패널 '읽을 수 없음 ≠ 없음' 경험 수정(10Router 설정이 삭제된 것으로 오인)**: 패널 접근 비밀번호 미설정 시 daemon은 fail-closed——본머신 socket 외는 일괄 403, Host가 본머신 NIC 표에 없는 경우(본머신 IP가 바뀌었는데 구 주소로 페이지 열면)도 403. 이때 패널의 `/api/*`가 전멸하는데 종전엔 오류를 조용히 삼켜——10Router 페이지는 '10Router 연결' 가이드로, 대시보드 10Router 카드는 통째로 사라지고, 내비 카운트는 `–`, '10Router 설정' 모달은 세 칸이 다 빈 채——사용자는 설정이 삭제된 것으로 오인(실물은 `~/.creditdaddy/tenrouter.json`에 온전히 존재). 현재는:
  - 실패 이유를 분류해 보존(`accessNote`: 거부 denied / 비밀번호 key / 네트워크와 서버 other). `accessNoticeHtml`로 강한 안내를 일관 렌더——**데이터는 삭제되지 않았음**을 명시, 인터페이스 원시 오류 첨부. denied엔 두 가지 실행 경로(본머신 `http://127.0.0.1:47860`에서 열기. '패널 설정 → 일반 → 패널 접근 비밀번호' 설정 후 '다시 읽기' 누름——전체 페이지 갱신 불필요).
  - 10Router 페이지는 블록 전체로 안내(가이드 페이지에도 할당 로딩에도 머무르지 않음). 대시보드 카드는 보존하고 '읽을 수 없음' 표시, 내비 카운트는 `!`로. '10Router 설정' '사용량 동기화' 모달에 읽을 수 없음 주석(**여기 저장하면 기존 설정 덮어씀** 경고 포함). 계정 목록 / 계정 세션 사이트 / 패널 설정의 같은 유형 '읽기 실패를 빈 상태로 보여주는' 문제도 일괄 수정. 현재 읽을 수 없는 모든 블록을 모은 상단 배너도 추가.
  - '먼저 10Router 설정을 저장해 주세요' 세 지점은 `trReadyOrTip()`에 집중——읽을 수 없으면 '현재 접근 방식으로는 읽을 수 없습니다(설정은 삭제되지 않았습니다)'로 바꿔 말함. PUT/DELETE 성공 후 `tr.loadError`를 지워, 복구 뒤에도 '읽을 수 없음'이 계속 뜨는 상태를 방지.
  - i18n: 중국어 25 항목을 en/ja/ko/zh-TW에 동기화(이번 신규분은 누락 0).
  - 회귀: `scripts/panel-boot-smoke.cjs`에 fail-closed 2라운드(fetch 스텁 전부 403) 추가. 안내到位와, 가이드 페이지 / 로딩 / 빈 상태가 **다시 나타나지 않음**을 어서션하고, 역방향 프로브로 어서션이 헛돌지 않는 것도 확인.
- **공지 동봉 폴백과 패키징 스테이징 게이트 마감(1.8.4-test.25 '공지 없음' 사고의 정리)**:
  - **빈 결과로 공지 캐시를 덮어쓰지 않음**: 온라인 소스가 잠정 고장(미push / 전 미러 404)이고 동봉 폴백도 빈 상태일 때, 패널은 빈 배열을 써서 사용자가 본 공지를 통째로 지웠다. `persistAnnouncementsFeed` 신설——모달과 백그라운드 자동 동기화 양 경로에서 items가 비고 로컬 캐시가 비어 있지 않으면 구 캐시 보존, '캐시 모드'로 렌더, '최근 캐시 표시 중' 안내. 캐시와 소스 둘 다 빈 상태일 때만 '공지 없음'. 회귀 네 가지(빈 소스에서 캐시 보존 / 비면 정상 덮어쓰기 / 둘 다 빈 상태 / 백그라운드 동기화도 덮어쓰지 않음).
  - **스테이징 목록 단일 진실 출처**: `scripts/stage-bundle.js`가 로컬과 CI 공용 복사 목록을 장악(**`cp -r`을 손으로 치지 말 것**——test.25 사고는まさに runbook의 손 목록에 `announcements.json`이 없었고, CI의 줄엔 있고 로컬엔 없어 동봉 폴백이 전멸). `npm run dist` / `dist:mac`은 자동 호출. 별도로 `npm run stage --prefix desktop`. 먼저 지운 뒤 복사(삭제·이름 변경 잔해가 패키지에 들어가지 않게), build.json 자동 생성, 스테이징 후 자가 점검.
  - **출시 점검 11번 항목에 3층 게이트**: `scripts/release-check.sh`가 소스 트ree / 스테이징 디렉터리 / 패키징 산출물(`desktop/dist/win-unpacked/resources/creditdaddy/`)의 announcements.json을 층별로 대조, 하나라도 없으면 차단. 테스트 프리릴리스(`-test.N`)는 fnos manifest 버전 번호와 CHANGELOG 단독 항목에 대해 관례상 면제(테스트판은 fpk를 만들지 않고, 변경은 정식판에 통합 아카이브). 회귀 `test/stage-bundle.test.js` 5 케이스(목록이 CI와 일치 / 폴백 누락·비정상은 반드시 오류 / 소스 변경 후 재스테이징 누름 포착 / 실제 스테이징이 정상 디렉터리 생성).
- **테스트 기간 갈고닦기와 수정(1.8.4 이후〜本版 확정까지의 변경은本版에 함께 출시)**:
  - **Doubao 제품 라인**: 본머신 데스크톱 클라이언트 자격 복호화와 자동 체크인·할당 감시——`%LOCALAPPDATA%\Doubao\User Data`의 Local State(DPAPI로 32바이트 AES-256 마스터 키 도출) + `<Profile>\Network\Cookies`(Chromium v10/v11 AES-256-GCM, 평문 앞 32바이트는 Chrome 130+의 Binding 해시 헤더). 클라이언트 실행 중 Chromium NetworkService가 배타 락을 거니 **DuplicateHandle 무감지 핫 추출**(<50ms, 클라이언트 안 닫아도 됨). 키와 평문 Cookie는 본머신에서만 순환하고 로그에 남기지 않음. 체크인 엔드포인트는 `item/reward/claim`로 이전하고 `biz_error` 처리. 랜딩 페이지와 체크인 복구, active한 `multi_sids`로 uid 매칭도 수정.
  - **ZCode 4.0 로그인 체계 적응**: `src/zcrypto.js`에 `enc:v2:os:<keyFingerprint>:<nonce>.<tag>.<암문>`(ZCode 4.0 신규 형식, AES-256-GCM + OS 키링 마스터 키와 캐시) 추가. `enc:v2:env`와 구 `enc:v1`에도 호환. 채널 배지는 `zai_cn` / 즤푸 바인딩 완료를 구분, 스캔 후보 회显 적응, 기존 계정은 비고명 상속.
  - **10Router 계정 동기화 채널 목록 버전 마이그레이션**: `accountSync.providers`는 옛 설정의 체크 스냅샷이라, 새 채널 출시 다음 날 10R 쪽 0 연결이 됐다(qwenwork 양 라인 실측: 할당 카드는 정상, 카드만 있고 연결 없음——화이트리스트 후 필터로 계정이 1개도 못 들어감). `ACCOUNT_SYNC_MIGRATIONS`는 **추가 전용, 되돌리지 않음**: savedVersion이 행 버전보다 낮으면 빠진 채널 병합 후 providersVersion write-back. 빈 목록(체크 미실시 = 전 채널)은 마이그레이션 안 함. 현 버전 설정은 건드리지 않음(사용자가 수동로 푼 채널을 부활시키지 않음).本版는 croli / AutoClaw / QuWork로 v2.
  - **패널 세부**: WorkBuddy 페이지 머리 단행화(이 페이지는 다른 제품보다 경로 필터가 한 조 더 있어 총 폭이 한계를 넘어 동작 버튼이 둘째 줄로 밀림——머리 여백 체계 조임, 통계 라벨 간소화, 가져오기/내보내기 아이콘 버튼화). Doubao 계정 행 재생 버튼 중복 제거(카드 우측 상단에 이미 '더우바오 열기', 계정 행은 체크인/재탐지/삭제만 남겨 다른 사이트와 통일). Google 로그인 슬롯은 워크스페이스 메뉴 모달로. '공지' 모달은 항시 단렬, 폭 720 → 480px로 창 작은 데 대응(글자 수도 한 단계 조임). 우측 상단 아이콘 순서는 공지 → 후원 → 테마 → 패널 설정으로(통합 메뉴는 최우측).
  - **대시보드**: 계정 세션 카드에서 복수 사이트 체크인 진척 집계.
  - **CI**: `node:sqlite` 관련 테스트를 런타임 가용성으로 게이트(해당 모듈 없는 Node에선 실패가 아니라 스킵).
- **i18n**:本版 누적 신규 en/ja/ko/zh-TW 항목——QuWork +54, AutoClaw +93, mirasim 할당 기준과 fail-closed 안내 +25, Croli 라인 잔여 32건(사전 밖 중국어 문자열 13 + 라인 함께 19)을 4개 언어에 동기화. `node scripts/check-i18n.js`는 **누락 0**(4개 언어 key 집합 일치 + 사전 밖 중국어 스캔의 이중 게이트).
- **자체 검증과 인수**: 전량 `npm test` **647 케이스 전부 통과**(1.8.3 베이스라인 502에서 145 증가. quwork 16 / autoclaw 48 / croli 7 / stage-bundle 5 / daemon-port-shadow 5 / zcode-proxy-stream 5 등). `scripts/panel-boot-smoke.cjs`는 두 라운드 모두 통과(정상 상태 + fail-closed 전 403 상태). test.31 / test.32 테스트 패키지는 사용자 실머신 인수 완료(4개 라인 통합, 52 계정 전부 건재, croli + AutoClaw access 자동 재push watch 정상, 공식 주황 집게발 아이콘 세 지점 일치).

## [1.8.2] (2026-11-20)

테마:**계정 자격증명 정적 암호화(AES-256-GCM + safeStorage/DPAPI, "자격증명 하베스트" 오탐 논의에 대한 응답) + 이중 인스턴스 이중 서비스 방어 + CLI 시스템 트레이(10Router 정렬) + 세션 풀 수정 확정(하이픈 사이트 ID / 슬롯 9→6 / 슬롯 1 배지)**.

- **계정 자격증명 정적 암호화(심층 방어. 2026-11-19 사용자 발안. "자격증명 하베스트" 오탐 논의에 대한 응답)**：데스크톱에서 accounts.json이 "0600 평문"에서 AES-256-GCM 엔벨로프로 승급——32B 무작위 키를 safeStorage(Windows=DPAPI, 현재 시스템 사용자에 바인딩)로 암호화해 userData/secret.key에 저장하고, 평문은 메모리에만 존재. 셸과 동일 프로세스의 daemon이 store.js 모듈 인스턴스를 공유하므로 한 번의 주입으로 전 경로가 활성화. CLI/NAS 인스턴스에는 키원이 없음: 암호문을 읽으면 명시적 오류로 안내하고(조용히 지우거나 데이터를 잃지 않음), 쓰기는 평문 현상 유지로 회귀 제로. 과거 평문 파일은 호환 읽기(첫 저장 시 엔벨로프로 승급). .bak 백업은 메인 파일과 동일 형태(암호화 환경에서 두 번째 평문을 만들지 않음). GCM 인증 태그로 무결성 보호(변조는 반드시 실패). 정직한 보안 프레임: 머신이 침해되면 모든 암호화는 무의미——이 강화는 "파일 반출" 대책이지 시스템 보안의 대체가 아님.
- **이중 인스턴스 이중 서비스 방어(2026-11-19 작성자 머신에서 실제 발생한 사고의 구조적 수정)**：제거 전, 0.9.1 npm 글로벌 daemon과 1.8.2-test.1 데스크톱 빌드가 공존——Windows에서는 0.0.0.0 와일드카드 바인드와 127.0.0.1 특정 바인드가 **EADDRINUSE 없이 공존**하여, 두 세대가 같은 포트로 서비스하고 같은 데이터 디렉터리에 혼합 기록(트레이는 v0.9.1, 패널은 test.1을 표시하는 기괴한 현상의 원인). daemon은 listen 직후 **루프백을 자기 프로브**：응답자의 version이 자신과 다르면 = 포트를 이기 버전 인스턴스가 점유 중이므로 즉시 다음 포트로 재시도(100회 한도 + 무작위 포트 폴백). 이중 서비스는 결코 하지 않음. 데스크톱 셸은 포트 드리프트 시 알림("구버전 인스턴스 공존 의심, 제거 권장"). E2E 검증: 가짜 0.9.1 점거 → 새 daemon이 자동 +1 드리프트하고 자기 버전으로 응답.
- **CLI 시스템 트레이(npm 설치 형태를 10Router와 정렬. 사용자 제안)**：`creditdaddy daemon` 포그라운드 실행 또는 `--tray`로 시스템 트레이 마운트——메뉴: 패널 열기 / **지금 모두 수령**(/api/checkin 직행) / 자동 시작 토글 / 종료. Windows는 **PowerShell NotifyIcon**(바이너리 제로, AV 친화적. 작업 표시줄 아이콘은 시스템 밝/어두운 테마에 따라 모노크롬 글리프 전환), macOS/Linux는 systray2를 데이터 디렉터리 runtime/에 지연 설치(배포 npm 패키지는 서명된 Go 바이너리를 포함하지 않음——같은 AV 오탐 방어. 실패 시 트레이는 조용히 축소되고 daemon은 계속). 자동 시작은 세 플랫폼 구현(Windows 스타트업 VBS 숨김 실행 / macOS LaunchAgent plist는 launchd 자기킬 회피 포함 / Linux XDG autostart). 10Router 형제 구현에서 이식(AGPL-3.0, 양방향 이식은 라이선스 기장 불필요), CD 측 ESM 화 + i18n은 패널 4개 언어 사전에 통합. 트레이는 확장 기능: 초기화 실패는 1줄 로그만 남기고 daemon에 영향 없음.
- **ZCode 만료 리소스 팩 표시 중단(사용자 실측 "만료됐으면 표시하면 안 되는데, 가끔 수령 완료로 표시")**：서버의 balances는 만료 행을 정리하지 않음(expire_at이 지났아도 remaining=3억 반환)——패널은 죽은 할애를 계속 표시하고 오래된 "수령 완료" 배지가 붙기도 했음. expire_at이 지난 one_time 팩은 필터(balances와 plans 파생 양 경로 동일); recurring 팩의 period_end는 재설정 시점이지 만기가 아니므로 유지. empty 의미는 "상류에 활동 없음" 유지——필터된 카드는 공백 대신 "사용 가능한 할애 없음" 표시. 회귀 핀: 만료 제거 / 유효 유지 / recurring 유지 / 파생 동일 필터.
- **세션 풀: 하이픈 사이트 ID 수정——모든 수확이 슬롯 1로(사용자 실측)**：IPC persistKey 화이트리스트 정규식 `[a-z0-9]+`는 하이픈 포함 사이트 ID를 받지 않음——`cookie-site-xiaomi-mimo-s2`는 조용히 불법 판정되어 로그인 창은 실제로 무작위 시크릿 파티션에서 열리고 수확 슬롯은 모두 기본 1로. MiMo 같은 하이픈 ID 사이트는 모든 슬롯이 하나의 시크릿 파티션을 공유하여 슬롯 2/3 로그인 계정이 모두 슬롯 1로. 하이픈 없는 사이트(modelscope 등)만 정상. id 세그먼트를 `[a-z0-9-]`로 확장하고 전표 회귀 핀(모든 사이트 ID의 슬롯 1/2/5/9 키가 IPC 화이트리스트 통과) 추가.
- **세션 풀 슬롯 상한 9 → 6(사용자 확정 "9은 너무 많다. 6이 적절")**：패널 풀 렌더링 / 피커 후보 / 경계 정규화, daemon capture 엔드포인트 가드(slot>6은 1로), 데스크톱 persistKey 화이트리스트와 슬롯 파싱(-s[2-6])을 양측 동기 축소. 기존 슬롯 7~9 행은 초과 기준으로 자연히 슬롯 1로(슬롯 1과 자리 교대)——마이그레이션 부담 없음. 회귀 핀: 전표 2/5/6 경계 + 슬롯 7 명시적 폴백 단언.
- **Meoo 잔액 "정기 리프레시"(사용자 실측 "모두 수동 수령+수동 리프레시. 정기 리프레시가 없음")**：출석 스케줄러는 이미 meoo를 커버(E2E 검증). 결핍은 잔액 스냅샷——meoo는 카드를 푸시하지 않아(no10rSync, 10R 측 자가 소비로 발급) 백그라운드 푸시 루프에서 제외되었고, 스냅샷은 캡처 시점과 수동 리프레시 두 시점에만 갱신되어 정기 라운드로 얻은 포인트가 표시에 반영되지 않음. Lingxi와 같은 기준의 "가져오기만 하고 푸시하지 않는" 신선도 유지 패스를 푸시 루프에 추가: live로 entitlement API를 끌어 quotaSnapshot + grants 명세 + 프로브 흔적 저장(dead 저빈도 재시도 동일). 잔액은 루프 주기(기본 60분)로 자동 신선 유지——수동 리프레시 불필요. 회귀 핀: 생존 계정 스냅샷 갱신+프로브 녹색, 사망 계정 프로브 적색+스냅샷 무접촉.
- **슬롯 1 배지도 표시(사용자 실측 "슬롯 1에 배지가 없음")**：daemon 측은 구행을 cookieSlot=1로 정규화했지만 패널의 ">1만 표시" 조건 때문에 메인 계정 슬롯만 무표기——세션 풀이 명시적 기능이 된 지금, 슬롯 1도 신원. 웹 세션 페이지와 무료 잔액 페이지 양 조건을 ≥1로 통일.
- **1.8.1 변경면 로버스트니스 청소(2026-11-19 감사)**：
  - 자동 획득 다이얼로그의 "매일 예약" 토글에 **인플라이트 가드**——빠른 토글로 PUT가 겹치면 응답 순서 역전이 스위치를 손가락에서 다시 끌어당기는 문제 방지. 비행 중 두 컨트롤 비활성화, `finally`로 반드시 복원；
  - "웹 버전" 로그인 창과 세션 삭제의 **IPC 호출에 try/catch**——await하지 않는 호출점에서 IPC 예외는 renderer의 미처리 rejection으로 무음이었음；
  - "지금 실행"의 **빈 입력 가드**——시간 필드를 비우면 `Number('') = 0`은 우연히도 정당값 "수동 중지까지 실행"이 되어, 조용히 끝나지 않는 창을 열 수 있음. 간격/시간은 로컬 검증, 문안은 서버와 동일 문자열；
  - zcode-tick에 **nextRunAt 의미론 회귀 핀**(1.8.1에서 수정한 "20:00 설정, 패널은 13:03 표시"에 테스트가 없었음)：미도달→오늘 목표와 정확히 일치, 과거 미실행→≤1h 보완, 금일 실행→내일 같은 시각, 비활성→null. 전량 473/473.
  - 감사에서 변경 불필요 확인: 요청 본문 413 한도와 JSON 가드, dailyClaimPlan 읽기 정규화(잘못된 설정도 NaN 핫루프 불가), 간격/시간 서버 클램프, 수확 체인의 층별 catch, HTTP 외측 가드.


- **수령 시점에 잔액 즉시 저장(2026-11-20 사용자 질문 "이 로그인 수령이 실제 완료된 것인가")**：meoo 수령은 balanceAfter를 반환하지만 스냅샷이 갱신되지 않아, "금일 수령 +2,000" 배지와 "잔액 1,990"이 나란히 있어 입금을 의심하게 했음. 출석 라운드는 balanceAfter를 반환하는 제품(meoo)의 잔액 스냅샷을 라운드와 함께 저장하여 배지와 잔액이 같은 프레임에서 신뢰 가능. 회귀 핀: +2000 수령 → 스냅샷 1990.

- **수확 후 목록 새로고침 지연 수정(2026-11-20 사용자 실측 "수확 성공했는데 목록 반영까지 약 30초")**：수확 푸시 핸들러가 풀/무료 페이지 재렌더를 `Promise.allSettled([loadCookieSites, refreshAccountList, loadTrQuotas(true)])`에 걸어 두어 최고 느린 `loadTrQuotas(true)`에 끌렸음——해 API는 force=1 시 서버가 먼저 `pushQuotaCards()` 한 바퀴를 인라인 실행(모든 무료 사이트 잔액을 live로 끌어 카드 푸시, 수십 초). 체인 분할: cookie-site 표면은 `loadCookieSites`만 대기(1초 미만), 계정 목록과 10R 경로는 병행 마감 후 각자 자기 표면을 재렌더.

## [1.8.1] (2026-11-18)

테마:**라이선스를 10Router에 맞춰 AGPL-3.0으로 전환(v1.8.0 이하는 MIT 유지, 소급 없음) + 웹 세션 "세션 풀"(Chrome 멀티 프로필식 로그인 슬롯) + ZCode 자동 획득 매일 예약과 계정 보호 백오프 + daemon 비정상 요청 라인 내성**.

- **라이선스 변경(issue #69)**: 10Router에 맞춰 **AGPL-3.0-only**로 전환, 1.8.1부터 적용. v1.8.0 이하는 MIT 유지, 소급 없음. LICENSE 본문은 10Router와 한 글자까지 동일(동족 상호 인증), 헤더는 techysy + decolua 계보 서명. README 아키텍처 설명에 AGPL §13 네트워크 서비스 조항 논거 추가(로컬 게이트웨이 경유 호출은 인터랙션에 해당, 소스 제공 의무 발동). 의존성 감사는 GPL 오염 제로, 전부 호환.
- **웹 세션 "세션 풀"**: Chrome 멀티 프로필식 자격증명 관리——사이트마다 9개 로그인 슬롯(슬롯 1 = 메인 Google/GitHub 계정, 슬롯 2~9 = 서브 계정). Chromium 파티션 `persist:cookie-site-<id>`(슬롯 1) / `persist:cookie-site-<id>-sN`(슬롯 2~9)으로 Cookie가 섞이지 않음. 계정 귀속 키에 슬롯을 편입(동일 신원+동일 슬롯은 1행, 동일 신원+타 슬롯은 별도 행). "웹 버전"을 열 때 사이트에 활성 세션이 2개 이상이면 먼저 세션 선택 팝업(Chrome 프로필 전환과 동일)을 띄운 뒤 창을 엶. 로그인 창 제목에 "로그인(세션 N · 재사용)/(시크릿 창)" 주석. 풀 관리는 슬롯별 열기/지우기/이름 변경 지원(이름 변경은 계정 비고에 영구화). 사이트 안내 문안은 2줄 이내로 통일(초과분 생략 + hover 전문).
- **ZCode 자동 획득 · 매일 예약**: 매일 HH:MM에 자동으로 1회 획득 창을 시작(수동 활성화와 같은 체인——예약은 그 버튼을 시각에 자동으로 눌러줄 뿐). daemon 시계는 자동 획득 스위치에 영향받지 않고 프로세스 재시작 후에도 그대로 진행. 동 영업일 중복 트리거 방지. 패널은 "예약됨 · 다음 <로컬 시각>"을 전 구간 표시——nextRunAt이 기존 타이머 기상 시각(1시간 클램프)을 저장하고 프런트가 UTC 문자열을 직접 슬라이스하던 문제 수정(사용자가 20:00을 설정해도 패널은 13:03을 표시해 "저장 안 됨"으로 오독). 실제 트리거 시각을 저장하도록 개선하고 `fmtTime`으로 로컬화 통일. daemon GET/PUT은 /api/status의 30초 캐시를 거치지 않고 시계를 직접 읽어 저장 직후 실배정 시각이 보임.
- **ZCode 자동 획득 · 계정 보호 삼건(사용자 실측 "캡차 실패인데 재시도 반복" / "획득 불가한데 반복 시도——BAN 위험")**: 캡차 2연패 후 지수 백오프 30분 → 1시간 → 2시간 → 6시간 상한(고빈도 실패 프로파일에 의한 리스크 판정 방지), 성공 또는 1003 시 즉시 클리어. 수동 획득은 스누즈와 백오프를 바이패스(사용자의 손을 결코 막지 않음——수동을 말없이 삼키는 것이 한 번 더 claim보다 신뢰를 해침). 수동 비활성화는 매일 예약도 함께 끔(daemon과 패널이 같은 요청으로 연동, 밤넘어 부활로 API 연타 방지).
- **ZCode 자동 획득 다이얼로그 개편(사용자 실측 "여전히 '저장 후 활성화'해야 예약이 저장된다고 오해")**: 단회 실행 창과 매일 예약을 2개의 독립 카드로 나눠 각자 저장. 매일 예약은 모던 토글로——**스위치 즉시 저장**(켜기=현재 시각으로 예약 등록, 끄기=예약 취소. 실패 시 daemon 측 실상태를 다시 렌더링). "정시 저장"은 시각 변경 전용. 상태 배지 "예약됨 · 다음 … / 미예약"은 카드 헤더로. 바닥의 홀로 선 "취소"는 제거(닫기는 우측 상단 ✕), "비활성화"는 단회 실행 창 카드로 옮겨 "실행 중지"로 개명(실행 중에만 표시. 의미 불변: 창 중지는 예약도 함께 중지, toast로 명시). 예약 설정 시 배너와 상태등 tooltip은 "매일 예약 저장됨: 매일 HH:MM 자동 실행(저장 즉시 활성, '활성화' 불필요)"라고 하며 "꺼짐"으로 시작하지 않음.
- **상태등**: 오늘 모든 계정 수령 완료 → 노란 등(작업 완료, 자동 폴링 할 일 없음의 정직한 표현). tooltip에 창/예약이 유지되며 다음 날 갱신 후 정상 재개함을 주석.
- **daemon 내성(10router#114와 동형 크래시 페이스 이식)**: 비정상 요청 라인(`new URL`이 throw하는 것)으로 프로세스가 죽지 않음——파싱 전 try/catch로 400 응답, 이후 정상 요청 도달 가능.
- **테스트**: trae-gateway "401 자동 블랙리스트" 케이스 밀봉화——로그인된 Trae 클라이언트가 있고 HTTPS_PROXY가 설정된 머신에서는 401 후 `readLiveAuth`가 본머신 실자격증명을 읽어 재시도하고, fetchJsonRace의 프록시 폴백이 trae.cn에 실접속해 실 200 스트림을 반환(502 어서션은 반드시 실패, 12.7초 소요). 현행은 `TRAE_HOME`을 빈 디렉터리로 + 프록시 환경변수 클리어 + 프록시 경로 스텁 throw로 삼로 봉쇄, 전량 스위트 **472/472** 올그린.


## [1.8.0] (2026-11-16)

테마:**신규 제품 라인 DuMate(바이두 搭子) 추가(로컬 가져오기 / QR 로그인 / 하드 전환 / 포인트·잔액 전체 체인) + Meoo(秒悟)는 웹 세션으로 연동(OAuth 독립 라인은 1 이터레이션 만에 회귀——리프레시 토큰 단회 교체의 크로스 시스템 경쟁이 구조적으로 불가능) + 채널 푸시 기준 수렴(채널 목록 카드화) + 웹 세션 행의 "최초 만기" 표기 통일 + Loomy 초대 코드 동기화 + Trae Linux/macOS 로컬 가져오기 및 동일 머신 다중 계정 출석 수정**.

- **신규 DuMate(바이두 搭子) 제품 라인**: 바이두 개인 버전 컴패니언 클라이언트의 전체 체인 연동——
  - **로그인 삼선**: 로컬 가져오기(Loomy와 동일한 클라이언트 자격증명 수확) + **QR 코드 로그인**(바이두 Passport tangram QR 플로 완전 이식: getqrcode 이미지 → data URI 변환 → unicast 롱폴링(scanned/confirming) → qrbdusslogin 표 교환(u 단회 인코딩 + SDK 파라미터 보완 + 홑따옴표 JSON 정규식 폴백) → 리다이렉트 체인을 따라 bce-sessionid 획득, 누락 시 wap 빠른 로그인 체인 폴백. 도메인 인식 cookie 통은 콘솔 세션 + Passport 계열만 보존) + 브라우저 로그인(개인 버전 입구); 패널 "계정 추가"에 "QR 로그인" 탭 추가(DuMate 전용, 기본 열림): QR 표시 + 상태 머신 문안 + 재획득/취소, 다이얼로그를 닫으면 daemon 측 세션 자동 중단;
  - **포인트와 잔액**: 실제 quota_overview 엔드포인트 접속(개인 버전 타임존과 desktop clientType로 조회)——구독 / 지급 / 추가 구매 포인트와 최근 만기일을 정확히 계산하여 기존 고정 "100점" 표시 수정; 출석은 loginBonus 매일 로그인 포인트로 진행; 잔액 바는 패키지별 분할 표시(WorkBuddy 다중 패키지 바와 동일, 텍스트 행은 최근 만기만 보고); quota에서 유료 플랜 배지 파생——plan_pro/plan_max/plan_team은 최상위 등급만 보라색 PRO/Max/Team 배지(hover 시 만기일 표시), plan_experience(무료 체험)는 미출력;
  - **로컬 계정 전환**: 하드 전환은 클라이언트 auth.json active 슬롯에 기록——최상위 cookies를 동일한 AES-256-GCM iv||tag||ct 레이아웃으로 재암호화하고 activeProfileId/activeProviderType를 다시 기록. 전환 전에 셸과 전체 Go 서비스(main-server/base-proxy/router/opencode/na)를 kill, 1.2초 지연 재확인으로 되쓰기 방어. 근거: 클라이언트 시작 시 setCookieProvider로 Go 프록시가 auth.json을 직접 소비해 Cookie를 주입하므로 콜드 상태 파일 기록만으로 전환 완료(윈도우 Chromium 통에 옛 Cookie가 남아 있으면 UI상 신원이 옛것일 수 있음——콘솔 API의 실제 신원이 기준); 전환 후 패널이 클라이언트를 자동 재실행(Loomy 동형, 미설치는 DUMATE_NOT_INSTALLED 409 동일 기준);
  - **10Router 동기화**: 계정 관리 다이얼로그의 채널 표에 DuMate 추가(계정 동기화 체인 수렴); 채널 행은 "연결 전용"으로 변경——잔액 카드는 10R 측 연결 자격증명 자체가 내보내므로 CD는 중복 카드를 밀어넣지 않음;
  - 기타: 표시명 "DuMate 百度搭子"→"DuMate"로 축약(10R 정합); 제품 페이지 VIEWS 누락 등록 수정 + 공식 아이콘; README 보안 경계에 다중 계정 격리·안티 연관 기준 추가(issue #64); 웹 세션 페이지와 무료 잔액 페이지의 사이트 풀 어디에도 DuMate를 표시하지 않음(test.5 실측에서 무료 잔액 페이지 누락 건 포착)——브라우저 로그인 라인 입구는 자체 페이지의 "계정 추가 → 웹 버전" 탭으로 이동(시크릿 창 수집 메커니즘과 수집된 계정은 변경 없음).
- **신규 Meoo 제품 라인(issue #65)**: 웹 세션 cookie 라인은 1 이터레이션 만에 독립 제품 라인으로 승격(cookieSites의 meoo 항목과 캡처 분기 제거), CLI 컨트롤 플레인으로 이행——
  - **컨트롤 플레인 API 클라이언트**: `/open/v1/cli-compat/*`(Bearer + `X-Meoo-Client: cli` + CLI-Version 0.5.8): identity / points / projects / 프로젝트 AK; 잔액 기준 total=totalGranted, used=totalConsumed, remaining=availableBalance, parts는 소스별로 배치 만기일 동봉;
  - **OAuth PKCE S256 루프백 브라우저 로그인**: 공식 CLI 공개 클라이언트와 동형(authorize/token + 127.0.0.1 루프백 리스너로 인가 코드 수신, trae 골격 동형); redirect_uri는 공식 CLI 0.5.8 산물 고고학으로 `/oauth/callback`에 정정(기존 `/callback`은 인가 페이지가 invalid_redirect_uri로 거부); 루프백 랜덤 포트 + 콜백 응답 규율(404/400/200 + no-store) + token 응답 계약 검증; refreshMeooToken 신설——출석 트리거 동작을 토큰 강제 리프레시 1회로 승격(리프레시 자체가 로그인 신호, 10R 동일), 결과는 계정 저장소에 되돌려 쓰고 재독은 새 자격증명 사용;
  - **출석 증분 검증**: 수령 엔드포인트 없음 = 기준 대장 → 신원 읽기로 트리거 → 재독(3×1.5초) → totalGranted 증분 재정, 결코 성공을 위장하지 않음(10R meoo-daily-claim 동일 알고리즘); 수령 완료는 already로 마감;
  - **패널과 동기화**: 제품 카드 / 내비 / 빈 상태 표시 배선; 계정 추가 듀얼 채널(OAuth 브라우저 로그인 + meoo_ak_ 붙여넣기); 10R 동기화 자격증명은 psd.meooControlKey에 넣고 프로젝트 필드 완비(00cde6b7 수신 기준), 동기화 전 best-effort로 프로젝트 AK 사전 해석;
  - 아이콘: CD 내비 / 제품 카드와 10Router providers 아이콘을 meoo.com 현행 favicon으로 교체(공식 브랜드 자산, 128×128로 lingxi/dumate 크기 관례에 정합)——CD 보라 점 placeholder와 10R 288 풀블리드版은 폐기;
  - OAuth 로그인 신원 읽기 재시도: uid 귀속 키가 되는 첫 신원 읽기가 실패하면 openid로 폴백——동일 계정 다음 로그인(uid=user_id)에서 합류 불가, 구행이 토큰 교체와 함께 invalid_token 죽은 행으로 잔존; 3회 재시도 후에도 실패할 때만 openid로 폴백하도록 변경.
  - 10R 중복 카드 푸시 폐지(자가 소비 기준, test.2 실측 피드백): 10R는 meoo 연결을 네이티브 지원하고 잔액 카드는 연결 자격증명 자체가 내보내므로 CD의 meoo-free 푸시를 제거(DuMate "연결 전용"과 동일 기준)——동일 계정에 같은 수치의 카드 2장이 나오지 않음. 푸시 경로의 홀로 참조 `MEOO_POINTS_URL`로 인한 ReferenceError(test.2의 "잔액 카드 푸시 실패" 원인)도 동시 수습;
  - 잔액 바를 컴팩트 분할 방식에 통합(DuMate 다중 패키지 바와 동일): 구독 / 매일 로그인 / 초대 3종 배치를 패키지별 세그먼트로 표시하고 텍스트 행은 최근 만기 + 사용/합계만 보고, 전체 명세는 hover에서;
  - 출석 견고화: 재독 윈도우를 5회 ×2초로 확대(발급은 트리거보다 늦을 때가 많음), 트리거 동작 1회 재시도. 재독이 모두 실패하면 failed로 기록——"불명"을 already 마감으로 위장하지 않음.
  - 자동 갱신(test.5 실측 "凭据已失效 invalid_token" 피드백): 잔액 / 출석 경로에 OAuth 리프레시 연결——대장 읽기가 401(invalid_token)이면 refresh를 한 번 거쳐 재독하고, 새 자격증명은 ctx.onRefresh로 계정 저장소에 기록("자격증명 유효·자동 갱신" 배지의 실현 지점). 출석 기선의 401도 먼저 갱신·재독 후 판정. onRefresh 영속화 훅이 없는 경로는 갱신하지 않음(refresh_token 교체 손실 방지). providers의 meoo 항목도 ctx를 전달하도록 변경. PR #66에서 누락된 동기화 목록 오류의 4개 언어 사전 등록도 추가.
  - 채널 푸시 기준 수렴 + 계정 관리 다이얼로그의 채널 목록 카드화: Meoo에 pushable:false 추가(meoo-free 푸시는 폐지되어 체크박스가 죽은 상태)하고 WPS 영희 행 신설(pushable:false)——10R는 #127부터 lingxi 채널을 네이티브 지원(webCookie executor가 카드 발행)하고 PR #66 연결 동기화도 있으므로, CD의 lingxi-<hash> 영점 카드는 푸시 중단(quotaPushDisabledProviders 상시 제외, 백그라운드 푸시 / 무료 잔액 페이지 webSessionOnly / 단일 카드 리프레시 410의 세 경로 모두 준수). 채널 목록은 카드 그리드로 재구성(제품 아이콘 + "额度卡" "연결" 이중 스위치 + "10R 자체 발행" 배지), 안내 문안은 신기준으로 4개 언어 등록;
- **웹 세션 행에 "최초 만기" 표시 추가(WPS 영희 / LongCat, Meoo와 동일 기준)**: 영희의 lingxiPacks 저장은 #53부터 배선이 끊겨 있었습니다——lxSnapshot은 선언만 되고 한 번도 할당되지 않아(항상 null) 팩/만기 데이터가 저장되지 않았고, 영희 행의 팩 명세는 한 번도 표시되지 않았음. 캡처/재탐지에서 lxStatus.packs 저장 추가(잔액 엔드포인트는 원래 팩별 expireAt를 반환). LongCat 팩 행에 "~ <최초 만기>" 날짜 추가(데이터는 원래 expireAt를 갖고 있었으나 미표시). 아울러 LongCat 재탐지 분기에 남아 있던 미선언 lxSnapshot 참조 제거——수동 "포인트 갱신"(live=1)은 반드시 ReferenceError 502였던 지뢰;
- **meoo를 웹 세션 라인으로 회귀(test.13 실측에서 갱신이 불가능함이 확인된 아키텍처 결정, issue #65은 요약과 함께 종료)**: 독립 제품 라인 철거——OAuth PKCE 로그인, 제어 평면 키 붙여넣기, CLI 제어 평면 API 클라이언트(meooAuth.js 완전 삭제 / meooClient 제어 평면 구현 / authDevice FLOWS / 계정 추가 듀얼 채널)를 제거. meoo는 cookieSites 웹 세션 항목(웹 캡처 / user_id 키잉 / entitlement 탐지) + FREE_CHECKIN_SITES 출석 라인 + 秒悟积分 독립 단위로 회귀. 10R 동기화는 이미 중단(리프레시 토큰 경쟁)——10R 측은 제어 평면 키로 자체 연결 관리. 기존 OAuth 계정의 자격증명은 무효이므로 웹 세션 페이지에서 다시 캡처하세요.
- **개발 인프라: 패널 부트 스모크 scripts/panel-boot-smoke.cjs(제로 의존 vm 실행 스텁)**——브라우저 없는 샌드박스에서 panel.html의 인라인 스크립트를 실행: HTML의 실제 id 집합을 수집(알 수 없는 id 조회는 null 반환, 누락 노드 참조 버그는 부트 시 즉시 발각), fetch를 URL별로 모킹, 부트 체인을 전부 통과한 뒤 렌더링 산출물(웹 세션 행의 만기 표기 포함)을 단언. 이번 라운드에서 렌더링 계층 누락 1건을 이미 포착. test/panel-smoke.test.js(자식 프로세스)로 CI에 편입;
- **DuMate QR 로그인 수령 수정(커뮤니티 PR #67, by lu8010252)**: QR 경로가 console.bce.baidu.com/dumate/channel을 통과하면 세션에는 BDUSS / bce-sessionid만 있고 콘솔 랜딩 페이지는 bce-user-info를 발행하지 않으며, 수령 엔드포인트는 csrftoken(값 = bce-user-info 원문)을 필요로 하므로 매일 수령이 항상 "Cookie 缺少 bce-user-info"로 실패했습니다. healDumateCookies() 추가: bce-user-info가 없으면 /api/dumate/app/token/get를 호출해 Set-Cookie의 bce-login-accountid에서 계정 ID를 보완(bce-login-display-name / bce-device-token도 세션에 통합). 세 곳에 배선——QR 로그인 저장 전 보완(저장된 자격증명 완전), verify/수령 전 폴백 보완(로컬 가져오기 / 웹 캡처의 깨진 항아리도 구제), API가 포인트 수를 반환하지 않는 경우 로그가 +undefined를 출력하지 않음. heal로 보완한 완전한 Cookie 통은 refreshContext.persistCookieJar(신설 영속화 훅)로 계정 저장소에 되돌려 쓰며, 수령할 때마다 다시 보완하지 않음.
  - 채널 능력 표 검증·수정(test.7 실측 지적): 잔액 카드 푸시가 실제 커버하는 것은 tokenharbor / minimax(-global) / 샤오미 MiMo / River / ModelScope / LongCat / 영희——WorkBuddy / Loomy / Qoder / DuMate / Meoo에는 CD 푸시 분기가 애초에 없어 체크박스는 죽은 상태. WorkBuddy 양 라인과 Loomy는 pushable:false로(10R의 codebuddy-cn / codebuddy-intl / loomy 연결이 자체 카드 발행), Token Harbor는 syncable:false로(sk- 키 소스, 연결 개념 없음). "연결" 스위치는 실제 동기화 가능한 채널에만 표시되고, "仅额度卡" "10R 자체 발행" 배지가 각 채널 형태를 정직하게 표시;
- **meoo의 10R 동기화 중단(test.12 실측 "凭据无法保存" 원인)**: CD와 10R는 동일한 리프레시 토큰을 공유하며, 어느 한 쪽에서 교체(단회용)되면 다른 쪽 사본이 무효화됨——동기화된 계정은 CD 측에서 상시 invalid_token. meoo 행을 채널 표와 동기화 맵에서 완전 제거. 10R 측 meoo 연결은 10R 자체 관리(QR / 제어 평면 키), CD 측에서 한 번 OAuth 재로그인하면 자동 갱신 복구;
- **사용량 동기화 "Masked usage apiKey requires apiKeyHash" 수습(test.5 실측: 1 소스가 통째로 400)**: 로컬 10Router 인스턴스의 usageHistory 행은 10R issue #9부터 "마스크된 apiKey + apiKeyHash" 형태인데, 10r 소스의 SELECT에 apiKeyHash 열이 빠져 있었다——聚合端으로 보내는 행은 hash 없는 마스크 키뿐이어서 10R의 apiKeyIdentity가 상시 거부. SELECT에 열을 추가(구 DB는 PRAGMA 탐지로 NULL 폴백), 행 변환이 apiKeyHash를 투명 전달, 마스크됐고 hash 없는 행은 계수 안내와 함께 건너뜀(신원 검증 불가 행은 미발송, 한 행의 불량이 배치 전체를 끌어내리지 않음); 聚合端 수신 경로는 원래 hash를 지원하므로 10R 측 변경 불필요.
- **영희 계정 "10Router 동기화" 연결(PR #66, 수신 측 10R #127/#128/#129)**: `TENROUTER_PROVIDER_MAP`에 `lingxi → lingxi` 추가(CD의 token은 완전한 WPS Cookie 통으로, api-key 형태로 10R 내장 lingxi 채널에 직송); transfer 행은 `authType:'cookie'` 보유(영희/DuMate 동일)——기존 Cookie 통 행이 oauth 형태로 기록되어 10R의 webCookie executor가 자격증명을 읽지 못하던 문제 수습(DuMate 동기화 체인도 동시 수습); 동기화 가능 목록 오류 문안에 DuMate/영희 추가; smoke 어서션 신설.
- **OAuth 루프백 콜백 페이지 재구성(test.12 실측 "too AI" 지적)**: Meoo(성공/경고 2 상태)와 Trae(성공 페이지)의 이모지 아이콘(✅/⚠️)을 인라인 SVG 서클 배지(녹색 바탕 흰 체크 / 호박색 바탕 흰 느낌표)로 교체하고, 페이지에 흰 카드 레이아웃(둥근 모서리 얇은 테두리, 시스템 폰트, 회색 계층 텍스트) 추가——플랫폼별 이모지 폰트 렌더링에 더 이상 의존하지 않음. 문안과 응답 규율(상태 코드 / no-store)은 불변.
- **Loomy 초대 코드**: 추천 코드 다이얼로그 placeholder를 현재 랜덤 후보 코드에 동기화; 초대 코드 풀에 4HT9MF6 추가(랜덤 균등 배분으로 두 공유 코드).
- **Trae 수정**:
  - **로컬 자격증명 탐지 Linux/macOS 보완(PR #62, Ubuntu 26.04 + Trae CN 2.3.92182 실측)**: detectTrae의 clientInstalled/clientPath/running 3필드는 기존 win32 전용 하드코딩——Linux에서는 storage.json 복호화가 가능함에도 "클라이언트 미설치"로 판정되어 패널이 로컬 가져오기 입구를 내주지 않았음. clientPathOf에 darwin(/Applications/*.app)과 linux(PATH의 kebab-case bin + .desktop Name 해석 Exec 폴백) 추가; running은 unixTraePids 경유(Linux는 /proc/<pid>/exe, macOS는 pgrep -x); terminateTrae는 unix에서 SIGTERM→폴링→SIGKILL; win32 동작 무변경;
  - **동일 머신 다중 계정 출석 9074 수습(issue #31)**: ① 브라우저 로그인 계정의 OAuth 기기 번호는 meta.traeDevice.deviceId에 저장되지만 출석은 meta.deviceId만 읽음——OAuth 계정은 항상 파생 번호가 되어 9074로 지속 거부; fallback 추가로 두 로그인 경로 통일. ② 동일 머신 다중 계정이 파생 번호를 강제받지 않도록(issue #28 구 기준 폐기): 동일 머신에서 가져온 모든 계정은 로그인 시 해당 기기를 서버에 등록했으므로 실기기 번호가 전 계정에서 유효——전 계정 attempt=0에서 실기기 번호 사용, 9074 시 파생 번호로 강등 재시도(폴백 보존); "기기 오늘 수령 완료"는 already(녹색 배지)로 분류, 적색 실패 처리하지 않음.
- **데스크톱 셸 종료 체인 안전망(test.11 실측 "프로그램을 닫을 수 없음")**: 기존 종료 경로(quit → close 통과 → window-all-closed 빈 처리)는 우아한 파괴에 의존——Meoo 인가 실패 창 / OAuth 루프백 server 등 매달린 handle가 quit를 붙잡아 프로그램이 닫히지 않았음. before-quit에서 전체 창(authWin 포함)과 트레이를 비동기 강제 destroy하고, 1.2초 후에도 종료되지 않으면 app.exit(0) 하드 종료——종료는 더 이상 어떤 handle의 자연 정리에도 의존하지 않음.
- **기타**: 데스크톱 빌드 산출물은 인스톨러(nsis)만 유지하고 포터블 target 폐기(역대 Portable 산출물 일괄 정리); scripts/clean-dist.js 빌드 게이트 신설——구 테스트 패키지 자동 청소(최신 2개 테스트 버전과 전체 정식 버전만 보존); README에 Trae 브라우저 로그인 "동일 머신 인가" 설명 추가(127.0.0.1 리다이렉트는 공식과 동일한 메커니즘, NAS / 원격 웹 패널에서 브라우저가 "접근 불가"를 보고하는 것은 예상 내)와 기능 개관 5사 정정; 테스트 466/466 그린(test/dumate.test.js 10케이스——암호화 왕복 / active 슬롯 / 멱등 / 미지 계정 거부 / 유료 플랜 배지 + heal 기록 케이스, test/meoo.test.js는 웹 세션 라인으로 회귀하여 12케이스). 제품 라인 설명 4곳에 DuMate 보완(release-check [14/15] 경고 해소).

## [1.7.2] (2026-11-12)
- **영희 카드에 "지금 출석 체크" 버튼 추가（issue #53 후속）**: 웹 세션 카드의 WPS 영희 계정 행에는 "재프로브"만 있어 수동 출석 체크할 방법이 없었습니다(자동 라운드는 있지만 시점을 제어할 수 없음). 행에 ▶ 버튼 추가: `POST /api/accounts/:id/checkin`으로 매일 작업을 대신 수행하고, 토스트는 daemon이 반환한 메시지를 그대로 표시("영점" 단위 포함). 이미 완료된 날은 자동 건너뜀(먼저 작업 상태를 확인, claim을 무분별하게 호출하지 않음). 성공 후 즉시 재프로브하여 잔액에 +100을 바로 반영. 豆包(doubao)는 checkin 구현이 있지만 순수 클라이언트 실행 진입로로 유지(CD가 대신 출석하지 않음)하므로 제외.
- **영희 출석 표기 3곳 수정（test.2 실측 피드백）**: ① 대시보드 "오늘 수령" KPI와 배지에 웹 세션 출석 라인 추가——`/api/status`의 `todayByProduct`에 lingxi 일 경계(자정 기준)를 추가하고, 영희 카드 계정 행은 제품 행과 동일한 `statusOf` 배지 재사용(오늘 수령 / 미수령 / 실패, 시간·메시지 툴팁). 수동·자동 출석 결과가 카드에 남고 일회성 토스트만 남지 않음; ② "+N 과장" 수정——claim 응답의 `total_claimed_credits`는 **주기 누적값**(실측: 연속 3일째에 300 반환, 잔액은 +100만 이동; 7일째에는 800으로 과장). 표시는 작업 상태의 `check_in_days[연속일수].reward`(매일 100 / 7일째 200)로 통일하고 토스트·배지·daemon 로그 3곳 동기화; ③ 수령 로그 단위를 제품 라인별로(영희 "영점", 豆包 "额度"), 획일적 "Credits" 폐지. 신규 `test/lingxi.test.js`(6케이스)로 당일 수량 기준과 "이미 완료 시 claim 무분별 호출 금지" 고정.
- **Trae 이중 채널: 직접 비샌드박스 + v3 표 교환 중첩 계약(10Router 44b2bb27 / #99 동기화)**: ① 게이트웨이 세션 페이로드를 모델명으로 분기——일반 모델은 직접 비샌드박스 채널(`agent_type: chat` + `env: local`, 클라우드 샌드박스 미개설), solo/work/agent- 포함 이름은 SOLO 샌드박스 유지. 모델명은 `canonicalTraeModel`로 정규화 후 전송(서버 대소문자 엄격, 오류 시 4001 config empty). 스트림 파싱에 직접 채널의 `content / delta.content / text` 계열 추가. ② 브라우저 로그인 "인증 페이지는 성공하나 표 교환이 ExchangeToken/DeviceInfo: HTTP 200 보고" 수정——v3 엔드포인트 실기기 계약은 중첩 `Result.Token / Result.RefreshToken / Result.RefreshExpireAt`(밀리秒)인데 평면 필드로 읽어 토큰 없음으로 오판, 구 엔드포인트로 강등되어 10101을 받던 문제. 채널 분기 4케이스 + 중첩 계약 회귀 1케이스 신설.

- **링희 멀티 계정 귀속(issue #53 후속, test.4 실측)**: 캡처가 '단일 계정'으로 하드코딩되어(tasks/balance에 신원 필드 없음, user 엔드포인트 404) 두 번째 계정 캡처 시 항상 첫 번째 계정을 덮어썼음. 신원을 세션 통의 `uid` cookie(WPS 계정 uid, 실측상 유일한 신뢰 소스)로 변경: 캡처는 uid 해시로 행이 분리되어 공존, 재프로브 시 identityHash 채워 넣고 행명에 uid 접미사, 10Router 카드 source는 uid 기준으로 바꾸고 구카드는 230e2fd 방식으로 일회 정리, hint에 멀티 계정 안내 추가(각 계정별 '웹 버전 / 붙여넣기 캡처', 동일 파티션에서 계정 전환 전 '저장된 세션 지우기').
- **링희 uid 표시 마스킹(test.5 실측 피드백)**: 행명과 로그는 앞3 뒤3(`192****197`, 휴대폰 번호와 동일 기준). 귀속 해시 / 계정 uid / 10R source는 원본 uid 유지로 멀티 계정 매칭에 영향 없음.
- **대시보드에 웹 세션 카드 추가 및 대시보드 멈춤 수정(test.6 실측 피드백)**: COMPONENTS에 '웹 세션'이 있는데 대시보드는 PRODUCTS 카드만 렌더링해 진입로가 없었음——새 카드는 캡처한 사이트 / 세션 총수 / 링희 출석 오늘 진행률을 표시하고 클릭 시 웹 세션 페이지로 이동(cookieSites 지연 로드 후 재렌더). 첫 버전은 renderDash 지역 변수를 참조해 ReferenceError로 대시보드가 멈췄고, 호출 측에서 인자로 넘기도록 수정.
- **대시보드 카드 드래그 재정렬(test.9 실측 피드백)**: bindCardDrag 일반화(.prodcard 포함, data-view 폴백)로 제품 카드 / 웹 세션 카드 / 10Router 카드 모두 드래그 가능. 순서는 compOrder에 영속화되고 대시보드·상단 탭바·컴포넌트 설정 칩 세 곳이 같은 데이터로 동기화.
- **Trae 브라우저 로그인: 국내 진입로 개방 + 국제 라인(test.8/test.9 실측 피드백)**: OAuth 인가 코드 + PKCE 플로우는 이미 완성되어 있었지만 tabShown이 진입로를 숨기고 있었음——개방. 국제 사이트 www.trae.ai용 provider `trae-intl` 신규(동일 프로토콜 동일 client_id, app_version 3.6.4, 표 교환 화이트리스트 grow-normal 계열, 단발 v3——10Router #99 기준 정렬). 국제 계정의 출석/한도는 정직하게 스킵(ug 출석 API는 국내 사이트에만 등록, pay 엔드포인트는 국제 게이트웨이에서 404——10R traeCheckin과 동일한 결론). 10R 연결 매핑 trae-intl→trae, 기존 isIntl 가드는 구 표기 계정으로 축소.
- **MiniMax 국제판 계정 엔드포인트 서버 서명 + 307 지역 감지(커뮤니티 PR #59)**: CN 네트워크에서 agent.minimax.io로 직접 연결하면 출석/한도/자료 엔드포인트가 CN 도메인 군으로 307 리다이렉트되어 전부 실패하고, 오류가 자격 증명 만료처럼 보여 사용자를 오도——10Router open-sse 구현 이식: 계정 동작 엔드포인트에 이중 서명(yy + x-signature) 통일, 국제판은 프록시 우선. 도메인 군을 넘는 307/403은 '지역 제한——국제판에 프록시를 설정하세요'로 명확히 보고. 패널 브라우저 로그인 필터를 prod 기준으로 변경(minimax-global이 접두어 절단에서 누락되던 문제 수정).
- **River AI 세션 expiresAt 수정(issue #61, 커뮤니티 보고)**: WorkOS 갱신 응답에 `expires_in`이 없어 `expiresAt`이 항상 null이었고, 매 프로브마다 무조건 401인 Bearer를 쏜 뒤 갱신 교환으로 넘어가 약 3초를 허비——`jwtExpiresAt`(JWT payload exp 역산)로 3개 지점 폴백 채워 넣고 영속화. `fetchRiverBalance`는 로컬에서 만료 확인 시(60초 클럭 허용 오차——너무 이른 갱신이 단회 로테이션 refresh 사슬을 소진하는 것 방지) Bearer를 건너뛰고 로그에 `bearer:만료 건너뜀` 표시.
- **WorkBuddy 팝업 수정(issue #52, 커뮤니티 보고)**: 레지스트리 모호 검색이 workbuddy-switch의 DisplayIcon에 오히트되어 wb-switch-rust.exe를 클라이언트로 캐싱. 마스터 키 추출 시 Electron으로 취급해 spawn하면 Rust GUI는 `-e`를 해석하지 않아 자기 창을 띄우고 5초 후 kill되는 일이 매 라운드 반복. 후보는 이중 게이트 통과: 파일명 블랙리스트(switch/launcher/uninstall 등) + 무자식 프로세스 Electron 지문 검증(exe 앞 2MB의 'Electron' 문자열). getWorkbuddyMasterKey의 spawn 앞에도 같은 게이트——캐시가 오염돼도 가짜 exe는 기동하지 않음.
- **Qoder 브라우저 로그인 드롭다운에 ZCode 혼입 수정(test.12 실측 피드백)**: PROV에 zcode-bigmodel/zcode-zai가 없고 provOf 폴백이 prod:'qoder' 고정——Qoder 창에 ZCode 항목 둘이 섞이고 ZCode 창은 자기 옵션이 전부 숨겨짐. 사전 보강 + 폴백은 제품 접두어(workbuddy/zcode/trae/minimax/qoder)로 정확 판정.
- **Loomy 초대 코드 풀**: 8YZCH5는 슬롯 17/20 만료 임박으로 퇴역. 초대 창에서 공유 코드 5개(AAYW9D/BD3GGF/HB4ABC/DTAPH5/9S2PB6) 중 하나를 랜덤 사전 입력——열면 바로 보이고 바로 바인딩 가능, 소모를 분산.
- **단위 테스트 프록시 격리(커뮤니티 PR #58)**: fetchJsonRace의 viaProxy는 node:http/tls라 globalThis.fetch 스텁을 우회——https_proxy가 있는 개발 머신에서 '네트워크 없음' 테스트에 실제 통신이 새어 들어감(3/4 실패, 건당 6-17초). 두 테스트 파일 상단에서 프록시 환경변수 일괄 제거. seedQoder에 id 부여, store 프로젝션은 정확한 id로 참조(멀티 계정 교차 오염 수정).
- **i18n 사전 정비**: MiniMax 빌드/언어판 불일치 intlWarning 2건 보완(d6721c9이 남긴 맨 중국어, 출시 게이트 15번 항목 차단 요인). 구 Trae intlWarning 고아 키 삭제. 링희 수령 로그 템플릿 {unit}판 4개 언어 보완.
## [1.7.1] (2026-11-07)

- **신규 MiniMax 국제판 채널 `minimax-global` 추가(issue #54)**：국내판과 동일 프로토콜·동일 클라이언트(`mcode-public`, RFC 8628 + S256 PKCE 디바이스 플로우)이며 도메인만 다름——`agent.minimax.io` + `account.minimax.io`(엔드포인트는 공식 클라이언트의 `@mavis/oauth-core` ACCOUNT_ORIGINS에서 실증, 로컬 `~/.minimax/auth/prod/<cn|en>/mcode-public/` 레이아웃과 상호 검증). 출석 / 잔액 / 디바이스 코드 로그인 / 로컬 가져오기(양쪽 디렉터리 수확) / 로컬 게이트웨이(계정 플레이버별 업스트림 선택) / 10Router 연결 동기화(`minimax-global` 라인) 전 체인 연결. 패널 MiniMax 페이지는 국제/국내 세그먼트로 분리(기존 Trae / MiniMax 지역 구분 없음 특례 폐지). `/api/status`는 두 현재 uid(`minimaxCurrentUid` / `minimaxGlobalCurrentUid`)를 반환해 배지가 플레이버별로 점등.
- **MiniMax 양 라인이 10Router "연결" 동기화 지원(issue #55)**：`TENROUTER_PROVIDER_MAP`에 `minimax → minimax-code`, `minimax-global → minimax-code-global` 추가. 계정 관리 대화상자의 MiniMax가 `syncable: false`에서 동기화 가능으로 전환——OAuth 경로(전송 파이프라인은 provider 비의존)를 그대로 사용하며, 10R 측은 `creditDaddySync` 마커로 "CD Sync" 배지 점등(10R 측 준비 완료). 출석 소속은 10Router 권장(MiniMax 양 라인 매일 출석 네이티브 지원)이며, CD 측 minimax-free 무료 게이트웨이 라인은 기존대로 CD 내에서 마무리해 이중 수령을 방지.
- **신규 WPS 영희(Lingxi) 채널 추가(issue #53)**：`lingxi.kdocs.cn` 세션 cookie 캡처(작업 목록 API가 프로브 겸용) + 매일 자동 출석(먼저 `daily_check_in` 상태를 확인하고 available일 때만 claim POST——멱등성 미검증으로 맹목 발사 안 함. +100 크레딧/일, 7일 주기 7일차 200) + 영점 잔액 표시(독립 "영점" 단위로 잔액 합산 미포함) + 10Router 잔액 카드(`lingxi-<hash>` 단일 잔액 카드, xiaomi-mimo 동일 형태). Cookie는 약 300일 이상 유효. 영점은 영희 화면에서만 소비 가능(공식 API 없음)해 게이트웨이 / 대화 보완은 대상 외.
- **"사용 중" 배지에 30분 서비스 윈도우 도입(ZCode / MiniMax / Trae 3개 게이트웨이, 사용자 실측 피드백)**：배지 판정에 시간 감쇠가 없었다——ZCode의 `recentAccounts`는 중복 제거와 상한만, MiniMax/Trae는 `lastAccount`만 봐서 한 번이라도 호출된 계정은 영원히 켜져 있었고 현재 실제 서비스 중인 계정을 알 수 없었다. 서비스 기록에 타임스탬프를 담아 최근 30분 내 실제 서비스한 계정만 점등(게이트웨이의 30분 세션 스티키 TTL과 정합). 툴팁(4개 언어)도 "최근 30분 내 서비스한 계정"으로 갱신.
- **제품명 통일: WorkBuddy 페이지와 모든 문구는 "WorkBuddy"만 사용(#54 논의)**——CodeBuddy IDE는 같은 채널 내의 클라이언트 전환 대상(자격증명 동일 출처)이지 독립 제품 라인이 아님. 내비 탭·페이지 제목·토큰 드롭다운·빈 상태 안내·토큰 붙여넣기 플레이스홀더·전환 차단 오류·토큰 검증 오류 및 4개 언어 사전 모두에서 "/ CodeBuddy" 접미사 제거(페이지 내 "WorkBuddy / CodeBuddy IDE" 필터 세그먼트와 CodeBuddy IDE 전환 대상 이름은 클라이언트명이므로 유지).
- **ZCode 활동 수령 견고성("수령 불가, 클라이언트에서만 가능" 보고 대응)**：① captchaVerifyParam은 1회용——3007/3001 거부 후 자동으로 새 인증 코드를 받아 1회 재시도(기존 param 재사용은 서버 F008 중복 certifyId 판정 유발). 자동 폴링과 패널 수동 수령 양쪽 경로에 적용. ② 인증 코드 fail 이벤트에서 파라미터를 잃는 버그 수정——공식 SDK는 `success+verifyResult=true` / `verifyCode=T006`(terminal pass)일 때 fail 콜백에 이미 유효한 param을 담아 주며, 데스크톱 숨김 창과 패널의 runCaptcha가 이를 채택(강제 대화형 팝업 회피). ③ 새로운 `partial` 상태——일부 활동은 수령했고 나머지는 인증 코드가 필요할 때 카드 전체를 "수령 실패"로 기록하지 않고, 배지는 "부분 수령"을 표시하며 메시지에 수령 목록과 대기 수를 함께 표기. ④ 수동 수령 안내 문구 구체화(패널의 "활동 수령"에서 인증 완료 → 여전히 실패하면 공식 ZCode 클라이언트에서 수령——실측으로 비대상 계정의 claim은 항상 3007이며 이는 인증 코드 실패가 아닌 서버 측 타게팅 사전 검사). ⑤ 활성화 이벤트 보고는 HTTP 429 시 3초 백오프 후 1회 재시도(약 2분 간격 자동 폴링은 제한되기 쉬움).
- **Loomy "내 초대 코드"**: 계정 카드에 이 계정 자체의 초대 코드를 보는 입구 추가(Loomy 클라이언트 app.asar에서 프로토콜 역분석: `GET /api/v1/invitation-codes`)——대화상자에 각 코드·사용 진행(예: 1/20 명액, 소진 시 주황)·코드 또는 공유 문구 원클릭 복사 표시(클라이언트 동일 문구). 프로덕션 API 실측 필드는 `{inviteCode, usedCount, maxUses, status}`로 클라이언트 bundle의 `{code, usedCount, limit}`와 다르며 두 형태 모두 정규화(실측 wire 우선). 목록이 비면 클라이언트와 동일하게 first-login으로 포인트 프로필 초기화 후 재조회.
- **Trae 브라우저 OAuth 로그인 루프(refreshToken의 공급원)**：패널의 "계정 추가 → 브라우저 로그인 → Trae 국내판"이 공식 클라이언트와 동일한 인가 코드 + PKCE(S256) + 로컬 루프백 콜백 풀 플로우를 실행(프로토콜은 workbuddy-switch와 trae-api-proxy 두 독립 리버스 구현으로 상호 검증). 디바이스 식별은 계정별 자체 생성(독립 deviceId / machineId / EC P-256 키 쌍. 인가 URL과 토큰 교환 body 세 곳을 동일 출처로 맞춰 20403 회피, 계정 간 식별 공유 없이 4017 리스크 제어 회피). 콜백 리스너는 커뮤니티의 세 가지 교훈을 따름(포트는 `auth_callback_url` 추종, 프로브 요청에 200+CORS 응답, 거부 콜백을 프로브 판정보다 먼저 처리). 토큰 교환 호스트는 SSRF 대비 화이트리스트. 콜백 파싱은 "경로 제거 → `&` 분할 → 반복 디코딩 → 첫 `=` 분할"로 이중 인코딩에 내성. 로그인 후 계정은 refreshToken을 가지며 10Router 측 자동 갱신도 개통. DeviceProof 갱신 체인은 다음 라운드(개인키는 영속화 완료).
- **Trae 계정을 분리된 `trae-cn`에 동기화(issue #56, 실기 테스트 통과 후 종료)**：`TENROUTER_PROVIDER_MAP`에 `trae → trae-cn` 추가. 동기화 요약은 스킵 사유를 명시. 국제판 Trae 계정(`meta.isIntl`)에는 오전송 가드 추가——국내 엔드포인트로 보내면 반드시 20101. refreshToken 없는 JWT-only 페이로드는 OAuth 경로로 임포트 가능함을 실기 검증. refreshToken은 OAuth 루프 구현으로 자동 부속. 잔액 카드 페이로드가 `trae-cn`을 지명하는 약속은 Trae 카드 구현 시까지 보류.
- **패널이 30초마다 4-5초 정지하는 문제 수정(issue #57)**：`/api/status` 폴링에 7곳의 동기 `tasklist` 프로브(매번 700-900ms)가 있어 Electron 메인 프로세스를 막았다. winProc에 전량 스냅샷 프로브(10s TTL + 백그라운드 비동기 갱신)를 추가하고 폴링 경로는 모두 공유 스냅샷을 읽음. 가드 / 종료 경로(switchTo 거부, terminate 대기 루프, 자격증명 쓰기 판정)는 적색선대로 동기 정밀 프로브를 유지해 실행 중 클라이언트의 자격증명이 덮어써지는 것을 방지.
- **Qoder 전환이 만료된 로그인 스냅샷 거부(2026-11-07 실기 검증)**：Qoder 디바이스 플로우 토큰은 수명 약 30일이며 갱신 경로가 없음(서명 없는 갱신 호출에 업스트림은 일괄 403 "Request discarded"——10Router 측도 동일 결론). 만료된 스냅샷을 쓰면 클라이언트가 기동 시 죽은 자격증명을 읽어 → 무효 판정 → 로그인 파일 삭제 → 로그인 화면이 되어 "전환 후 로그아웃"처럼 보였다. switchTo는 쓰기 전에 `expiresAt`를 검사：만료 시 명확한 사유와 함께 거부(`QODER_AUTH_STALE`, 재로그인과 로컬 가져오기 안내), 만료 24시간 이내는 경고와 함께 그대로 전환.
- **"클라이언트 열기"가 플레이버를 선택 + Qoder는 Launcher 우선**：Trae와 Qoder는 모두 국내 / 국제 두 클라이언트를 가짐. 기존 Trae는 고정 순서로 exe를 열었고 Qoder 페이지에는 입구조차 없었다. Qoder 페이지에 상단바 "클라이언트 열기" 추가(실행 상태 점 표시). 양쪽 플레이버가 설치된 경우 삼択 대화상자(취소 / 국제판 / 국내판), 단일이면 직접 기동. `/api/status`는 `cnInstalled` / `intlInstalled`를 반환해 패널 판단에 사용. Qoder는 공식 Launcher 우선(시작 메뉴와 같은 입구：`.qoder-versions`의 적용 대기 업데이트를 적용하고 실제 현행 버전을 기동), 최상위 구 exe는 폴백——"버튼이 여전히 0.2.5 구버전을 열음 + 버전 경고 배너" 수정. Trae 전환 후 자동 재기동은 계정 플레이버(`meta.isIntl`)로 클라이언트 선택.
- **글로벌 이메일 / 전화번호 마스킹**：패널의 모든 이름·식별 표시 위치를 통일 마스킹——이메일은 로컬부 앞 2 + 뒤 2(`11****91@도메인`, 로컬부 ≤4자는 첫 글자만 남겨 전체 노출 방지), 전화번호는 앞 3 + 뒤 3(`138****678`). 계정 카드 이름과 계정 행, 대시보드 "클라이언트 현재", 주의 목록, 10Router 잔액 카드, 정렬 칩, 전환 확인 / 초대 코드 대화상자, 임포트 후보, 세션 만료 배너를 커버. 툴팁도 마스킹(계정 행 호버 시 평문 이메일이 보이던 문제 수정). 사용자 지정 닉네임 등 이메일 형식이 아닌 문자열은 무영향. 이름 변경 편집 상자는 실명 유지.

## [1.7.0] (2026-11-06)

테마:**신규 CodeBuddy IDE 제품 라인(양쪽 플레이버 자격증명 수확 / SQLite 암호화 / 다중 계정 전환) + WorkBuddy 듀얼 클라이언트 전환 재작성(국내/국제 독립 세션, $wbEncrypted 봉투 쓰기, 세션 합성 폴백) + ZCode 활동 수령 개편(marketing/touch 진짜 소스 + 활성화 이벤트 보고, 하드코딩 폴백 목록 폐기) + 독립 업데이트 창 + 전환 UX 개선(클라이언트 자동 실행 / 내비 회색 배지 / 국제판 배지 전부 점등)**.

- **신규 CodeBuddy IDE 제품 라인(issue #51)**：CodeBuddy IDE(국내 CodeBuddy CN / 국제 CodeBuddy)는 WorkBuddy와 계정 체계가 동일(토큰이 같은 realm에서 발급)하여 잔액 / 출석 / 10Router 푸시는 기존 경로를 그대로 재사용. 이번 버전은 자체 저장소의 읽기/쓰기를 추가——
  - **자격증명 수확**：`%APPDATA%\(CodeBuddy CN|CodeBuddy)\User\globalStorage\state.vscdb`(SQLite ItemTable의 `secret://…` 행)를 Chromium Safe Storage v10으로 복호화(Windows: Local State `os_crypt.encrypted_key` → DPAPI → AES-256-GCM / macOS: Keychain Safe Storage → PBKDF2 → AES-128-CBC). 전부 async이며 명시적 가져오기 / 전환 시에만 호출(DPAPI는 자식 프로세스를 띄우므로 1.6.6 백색 화면 철칙대로 `/api/status` 폴링에는 절대 넣지 않음)；
  - **다중 계정 전환**：쓰기 전에 반드시 `state.vscdb.bak-<타임스탬프>` 백업. 벌 UPDATE 대신 upsert(IDE는 설치됐지만 로그인한 적 없으면 secret 행이 없어 벌 UPDATE는 0행 영향 + 오류 없음 → "가짜 성공")；upsert 키/값 인수가 뒤바뀌던 결함 수정(진짜 secret 행이 한 번도 기록되지 않았음)；
  - **네이티브 스냅샷이 없는 계정**(토큰 / 10R 가져오기)은 `buildCodeBuddyIdeSession`으로 완전한 IDE 세션을 동적 합성해 기록(workbuddy-switch 사양 준수).
- **WorkBuddy 듀얼 클라이언트 전환 재작성**：
  - 국내 WorkBuddy와 국제 WorkBuddyAI는 별개 클라이언트(auth ID도 세션 파일도 별개, 동시에 각 1계정 로그인 가능)：`writeWorkbuddySession`은 계정 플레이버에 맞는 파일에 기록(국제 계정은 국제/국내 두 파일 모두 기록). 신규 `currentWorkbuddyUids()`는 한 번의 읽기로 국내/국제 현재 uid를 반환；
  - `$wbEncrypted` 봉투 기록: 대상 파일이 암호화 템플릿이면 토큰 / 리프레시 토큰 / 닉네임을 공식 런타임에서 추출한 masterKey로 재봉인(keyId는 원본 파일과 일치, 닉네임까지 암호화하는 국제 클라이언트 형태에 부합)；
  - `meta.session`이 없는 계정은 세션을 합성해 기록(`buildWorkbuddySession`: 도메인은 플레이버별, 전화번호 마스킹)——순수 토큰 가져오기 계정도 클라이언트 전환 가능；
  - 사용자 지정 설치 경로 발견(issue #46): 레지스트리 Uninstall 키 → 프로세스 경로 2단 폴백. daemon 시작 시 비동기 예열, `detectWorkbuddy`는 동기 · 제로 자식 프로세스 유지(1.6.6 백색 화면 교훈).
- **패널 전환 UX와 배지**：
  - "무엇을 골라도 CodeBuddy IDE로 전환되는" 버그 수정——uiDialog Promise가 `'alt'` 반환값을 `true`로 강제 변환해 전환 대상 선택 로직이 무효화되어 있었음；
  - WorkBuddy 페이지에 "전체 / WorkBuddy / CodeBuddy IDE" 클라이언트 필터 추가: 필터 활성 시 전환 대상이 바로 확정되고 "전환 대상 선택" 대화상자가 뜨지 않음；
  - 전환 성공 후 800ms에 해당 클라이언트 자동 실행(ZCode와 동일). WorkBuddy / WorkBuddyAI / CodeBuddy CN / CodeBuddy 네 개의 exe를 플레이버로 정확히 선택；
  - 국제판 현재 계정 배지 수정: `/api/status`가 네 개의 현재 uid(WorkBuddy 국내/국제, CodeBuddy IDE CN/국제)를 내려주고 패널은 계정 플레이버로 대조. 토큰 갱신 후 클라이언트 기록도 양쪽 모두 커버；
  - 내비 탭: 계정 수를 테마색 큰 캡슐에서 아이콘 오른쪽 작은 회색 캡슐로 변경, 활성 탭 배경은 반투명으로. 헤더 메뉴는 폭 확장 + flex 배분으로 버튼 넘침 해소.
- **ZCode 활동 수령 개편(2026-11-04 실측)**：
  - 활동 발견은 `marketing/touch` 진짜 소스로(공식 클라이언트가 활동 카드를 받는 곳, 숨겨진 활동도 보임). `billing/preview`와 병합. **하드코딩 폴백 목록 폐기**(`ZCODE_KNOWN_CLAIM_PLANS`는 빈 배열 호환 유지)——활동 ID는 세대교체마다 무효화됨(1102 → gb-1104 실측)；
  - 활성화 이벤트 보고 추가(`app_launch` / `app_daily_active`, zcode-switch claim.rs에서 이식): 미보고 시 preview는 항상 비고, claim은 비활성 클라이언트로 거부——"공식 클라이언트에서만 수령 가능"의 근본 원인；
  - 캡차 region 엔드포인트(출구 IP별로 cn/sgp 배포)는 강제 다이렉트 연결(`directOnly`)——프록시 출구가 region을 잘못 전달해 검증이 영원히 실패하는 것을 방지.
- **독립 업데이트 창**: 업데이트 확인 / 다운로드 / 설치를 테두리 없는 독립 창(`update-window.html` + 화이트리스트 preload)으로 이동, 메인 창과 완전 분리——메인 창이 멈춰도 업데이트 경로는 산다. "다운로드 취소" 죽은 버튼(AbortController가 한 번도 대입되지 않았음)도 수정.
- **10Router 동기화 마커**: CreditDaddy에서 동기화한 모든 10R 연결은 `creditDaddySync: true`를 가짐(apikey / OAuth 양 경로). 10Router 측 동일 배치 변경과 함께 CodeBuddy 연결도 "CD Sync" 출처 배지 점등(qoder 웹 세션 `creditDaddyWebSession` 의미는 불변).
- 기타: daemon에 `/assets/providers/` 제품 아이콘 정적 라우트와 아이콘 자산 추가. 테스트 389/389(codebuddy-ide / workbuddy-custom-path 두 스위트 신규, cookiesites / tenrouter / smoke는 동기화 마커에 맞춰 갱신).

---

## [1.6.7] (2026-11-03)

> **1.6.6 철회 안내**: 1.6.6은 같은 날 오전에 릴리스(tag / GitHub Release / npm)되었으나, 새로 추가된 WorkBuddy 키 추출 spawnSync 결함으로 데스크톱 셸이 "응답 없음" 백색 화면에 빠지는 문제(사용자 실측)로 수 시간 내 전량 철수했습니다. 사용자 결정에 따라 동일 내용 + 백색 화면 근복 수정을 **1.6.7**로 재릴리스합니다——본 버전은 1.6.6의 완전한 대체이며, 모든 1.6.6 사용자는 업그레이드해야 합니다.

테마:**WorkBuddy 5.6+ 암호화 자격증명 수확(WorkDaddy 방식: $wbEncrypted 봉투 복호화 / 5.8+ 전화번호 복원 / 전환 시 암호화 쓰기) + ZCode GLOBAL BUILD 신규 활동 폴백(3억 GLM-5.3-Flash) + 1.6.5 릴리스 후 전량 재검토 수정(35 커밋 10건)**.

- **【1.6.6 긴급 수정】WorkBuddy 키 추출을 비동기화——데스크톱 셸 "응답 없음" 백색 화면 근본 해결(사용자 실측)**：1.6.6 초기版의 getWorkbuddyMasterKey는 **spawnSync**로 WorkBuddy Electron 자식 프로세스를 띄워 복호화 키를 가져왔습니다——동기 호출이 Node 이벤트 루프를 최대 5초 잠급니다. 데스크톱 셸은 daemon을 **Electron 메인 프로세스 안에서** 구동하므로, /api/status(패널 부팅 + 30초 폴링) → currentWorkbuddyUid() → 암호화 세션 복호화 → 200MB 클라이언트 프로세스를 동기 실행하면서 메시지 펌프가 멈추고 → Windows가 "응답 없음" 판정 → 백색 화면(부팅이 60초 실패 백오프 창에 걸리면 반드시 재현). 전 체인을 비동기화: 키 추출은 spawn(Promise + in-flight 중복 제거 + 5초 타임아웃), decryptSessionJson / sessionToAccount / readWorkbuddySessions / currentWorkbuddyUid / writeWorkbuddySession 모두 async, detectWorkbuddy.signedIn은 순수 파일 판정(복호화 안 함). 복호화 불가 세션은 null을 정직히 반환(행탁·크래시 없음). 로컬 실측: detect 1ms / 3계정 수확 5ms. 테스트 376/376(「키 불통 시에도 블록하지 않음」 회귀 추가).
- **ZCode 신규 활동 「GLOBAL BUILD」 폴백 수록 및 한도 초과 처리**:
  - 11월 신규 활동 `zcode-v3-start-plan-1102`(ZCODE GLOBAL BUILD · 300,000,000 GLM-5.3-Flash Token)를 수록. 서버의 `preview` 목록에서는 숨겨져 있지만 폴백 목록을 통해 직접 `claim` 호출로 수령 가능;
  - 실측 확인: 당일 명액이 모두 소진된 경우 서버가 `1005 今日领取名额已用完(exceed quota limit)`를 반환(클라이언트에서는 "操作失败，请稍后重试"로 표시), 이미 수령한 계정은 `1003 该套餐已经领取过`를 반환합니다.
- **WorkBuddy 5.6+ 암호화($wbEncrypted) 봉투 복호화 및 5.8+ 전화번호 복원**:
  - ① **$wbEncrypted 로컬 복호화**: WorkBuddy 5.6+의 필드 레벨 at-rest 암호화(AES-256-GCM 및 AAD 서명을 포함한 `$wbEncrypted` 봉투) 지원. 공식 WorkBuddy Electron 런타임(`ELECTRON_RUN_AS_NODE=1`)을 통해 스토리지 바인딩 키를 추출하고 메모리 캐싱 및 60초 장애 대기를 적용하여 토큰 등 민감 필드를 안전하게 복호화(5.6+ 클라이언트 계정을 전혀 수확하지 못하던 문제 해결);
  - ② **실제 전화번호 복원**: WorkBuddy 5.8+가 `account.phoneNumber`를 마스킹(`135****6735`)하지만, access_token의 JWT payload claims(`preferred_username` / `phone_number` / `mobile`)에서 마스킹되지 않은 휴대폰 번호를 자동 추출;
  - ③ **계정 전환 쓰기 암호화 보호**: 기존 세션이 `$wbEncrypted` 구조인 경우 전환 시 암호화 봉투로 다시 패키징하여 5.6+ 클라이언트의 로딩 예외 방지;
  - ④ **클라이언트 탐지 후보 확장**: `WorkBuddyAI.exe`, `CodeBuddy CN.exe` 및 macOS 대응 경로 보완. 테스트 375/375.
- **릴리스 후 재검토 수정(v1.6.2..HEAD 35개 커밋 멀티에이전트 심사, 10건 모두 수동 확인)**: ① daemon 크래시 경로——10R 사용량 동기화 setInterval이 경화된 loadConfig(읽기 실패 시 throw하도록 변경)를 가드 없이 호출, 백신 순간 잠금 EPERM에 daemon 전체가 죽을 수 있었음.이번 라운드는 catch 후 스킵. ② `.bak` 퇴로 자기파괴——주 파일 손상 후 .bak에서 복구한 뒤 첫 저장에서 아직 손상된 주 파일 내용을 .bak에 되써버림; 주 파일이 JSON 파싱 불가하면 .bak를 건드리지 않음. ③ Trae 동일 기기 다중 계정 디바이스 번호 회귀——#38 이후 attempt=0이 일률적으로 meta.deviceId 우선, 동일 기기 가져오기 N개 계정의 deviceId가 같아 두 번째 계정부터 매일 9074. traePrimaryIds(기기번호별 첫 계정만 인정) 신규, 비선두 계정은 파생호 강제(#28 분리 복원). ④ 패널 한도 신선도——loadQuotas 배치 가드가 await 앞에 있어(항상 참) 구배치가 새 live 수동갱신을 덮음; await 후 재판정. ⑤ webSessionOnly 푸시가 채널 제외 무시——무료 한도 페이지가 자체 source 목록으로 quotaPushDisabledProviders를 우회해 사용자가 해제한 채널을 재푸시; 이제 제외 존중. ⑥ Loomy 전환 두 곳——대상 userid 없으면 이전 자격증명 userid를 빌리지 않음(새 session에 남의 신원 매칭·배지 오점); 클라이언트 미설치 시 LOOMY_NOT_INSTALLED로 성실 보고(이전엔 가짜 쓰기+가짜 성공). ⑦ Loomy 포인트 총액——total=영구+매일잔여라 게이지가 항상 가득; total을 용량 기준(영구+매일 상한)으로. ⑧ 게이트웨이 계정삭제 잔재——forgetAccount가 weights는 지웠지만 진행 중 weightInflight는 그대로, 느린 상위 갱신이 삭제된 계정 가중치를 Map에 되씀(2s 상한이 막으려던 바로 그 경로); 양 게이트웨이 보완. ⑨ macOS qodercli 구성요소 선택(PR #44 후속)——사전순→버전순(1.2.10 > 1.2.9); 후보는 statSync().isFile() 통과만 사용,잘못된 항목 스킵. ⑩ 정리: 무료풀 사이트 카드 warn 렌더 보충, 패널 강제전환 목록에서 죽은 코드 LOOMY_RUNNING 제거, hasAny 죽은 변수·4개 언어 사전을 닿지 않는的字면 `\n` 키 삭제, ja '現在前不可' 깨짐 수정. 테스트 370/370.

---

## [1.6.5] (정식 릴리스. 내용은 이전에 1.6.3으로 테스트 배포됨)

테마:**취페이 Loomy 제품 라인(SMS 직접 로그인 / 로컬 자격증명 가져오기 / 다중 계정 하드 전환 / 포인트·초대 코드 / 10Router 동기화) + ZCode 숨김 활동 폴백(WEEKEND BUILD) + Trae 자동 체크인 수정 및 fnOS 통합 게이트웨이 진입(#38 / #39) + 전량 코드 리뷰 완료**.

> **릴리스 상태 / 버전 번호 안내**: 본 내용은 2026-10-28에 1.6.3으로 로컬 테스트 배포되었습니다(Feishu 그룹 파일 `CreditDaddy-Win-Setup-1.6.3.exe`). 잘못 npm에 배포된 `creditdaddy@1.6.3`(deprecation 처리됨)은 npm이 동일 버전 재배포를 허용하지 않으므로 **영구 폐기**입니다 — 정식 릴리스(tag / GitHub Release / npm)는 **1.6.3 / 1.6.4를 건너뛰고 1.6.5로** 진행하여, 같은 버전 번호가 두 채널에서 서로 다른 것을 가리키는 상황을 피합니다(2026-10-29 사용자 결정).

### 🔧 수정

- **무료 한도 페이지의 「10Router로 동기화」는 웹 세션 계열 한도 카드만 푸시**: 이전에는 이 버튼이 계정 연결 동기화(Qoder / WorkBuddy 등 모든 연결 푸시)를 먼저 호출한 뒤 전체 한도 카드 푸시(로컬 인증 정보 계열의 minimax-free까지 포함)까지 실행했습니다. 이제 `webSessionOnly`로 통일하여 cookie-site 계열 카드(tokenharbor / 샤오미 MiMo / River / ModelScope / LongCat)만 푸시합니다. 계정 연결 동기화는 10Router 페이지의 「계정 관리」 대화상자(채널 스위치 포함)의 역할입니다.
- **Qoder 웹 세션 수집 후 「웹 세션 없음」 배지가 즉시 사라지고 상세 내역도 능동적으로 새로고침**: 수집은 3단 비동기(로그인 성공 → 로그인 창 「닫힘」 후 Cookie 수집 → daemon 바인딩)이며, 이전에는 12s/30s setTimeout으로 시점을 추측했습니다 — 틀리면 배지가 남고 리소스 패키지 상세는 수동 새로고침을 기다려야 했습니다. 바인딩 완료(bound>0) 시 데스크톱 셸이 `qoder-web-session:bound`를 emit하고, 패널은 계정 목록을 새로고침한 뒤 Qoder 잔여량을 **live 기준으로 다시 조회**합니다(수동 「크레딧 새로고침」과 동일: 실제 상위 조회로 상세를 다시 당겨옴).
- **Trae 자동 체크인이 매일 9074로 실패(issue #38, #31의 진짜 원인)**: 체크인의 `x-device-id`는 uid에서 **결정론적으로 파생**되었지만, 서버는 「계정 ↔ 디바이스」를 **로그인 시 등록한 기기**에 묶습니다 — 파생된 낯선 ID는 가져온 다음 날부터 리스크 제어에 지속적으로 거부되고, 공식 클라이언트의 수동 체크인은 정상입니다. 이제 가져올 때 클라이언트 `storage.json`에서 얻은 **실제 기기 ID를 우선 사용**(`meta.deviceId`)하고, 실제 기기 ID가 없는 경우(token만 가져오기)나 9074 재시도 시에만 파생 ID로 폴백하며, 같은 기기의 여러 계정은 첫 번째가 실제 ID를 쓰고 나머지는 서로 충돌하지 않게 파생합니다.

### ✨ 새 기능

- **fnOS 데스크톱 / APP가 통합 게이트웨이 진입을 사용(issue #39, 방안 2)**: 공용 도메인(리버스 프록시 / Cloudflare Tunnel 등)에서 fnOS 데스크톱 아이콘이나 모바일 APP을 열면 흰 화면 — 창이 「현재 접속 호스트명」으로 `http://호스트:47860`을 조립하지만 HTTPS 진입은 443만 서비스하여 도달 불가(LAN 내부는 정상). fpk가 **fnOS 통합 게이트웨이**를 경로로 변경: `ui/config`에 `gatewaySocket`(app.sock)과 접두사 `/app/creditdaddy`를, manifest에 `micro_app`을 선언하고, 새로운 `gateway-proxy.mjs`(Node 제로 의존)가 접두사 제거·Host/Origin/Referer 재작성 후 로컬 47860으로 전달 — **공용 443 직통·페이지와 동일 출처·사용자 설정 불필요**. Anthropic SSE 장기 스트림(/gateway/*)은 스트리밍 투과. `http://LAN_IP:47860` 직접 연결 기존 경로는 완전히 영향 없음.

### 🛡 견고성 보강(2026-10-29 전수 감정)

런타임 전체 25개 파일에 대한 견고성 감정(동시성 / 리소스 누수 / 오류 경로 / 무한 증식)으로 다음을 수정했습니다:

- **게이트웨이가 「우아한 연결 해제」를 관찰(세 게이트웨이)**: 응답 헤더 도달 전 클라이언트 취소(cc CLI의 Ctrl+C / 정지)는 `res 'close'`만 발생시키고 `req 'close'`는 발생하지 않습니다 — 유일한 abort 훅으로는 포착할 수 없어 재시도 루프가 계속 돌았습니다(ZCode는 captcha 해결과 로테이션 공회전, Trae는 SOLO 세션 생성으로 실제 한도를 소진). `res 'close'` 훅 추가로 취소 = 즉시 중단.
- **Trae 게이트웨이의 오류 응답 본문을 해제**: 401 / 429 / events 실패의 본문을 읽지도 취소하지도 않아 연결이 상위 종료 또는 ~300s 타임아웃까지 못 박혔습니다 — 429 폭풍 시 완료 1건당 최대 5개 소켓 누수. 일괄 `cancel()`로 폐기하고, 세션 정리 DELETE도 10s 상한 경로로 변경.
- **ZCode / MiniMax 게이트웨이의 스트림 중단 시 error 프레임 전송**: 상위 스트림 단절은 이전에 debug 로그 + 무언의 `res.end()`뿐 — 클라이언트는 `message_stop` 없는 맨 EOF로 「스트림이 갑자기 끝났다」만 보입니다. Anthropic 프로토콜의 `event: error` 프레임 한 장으로 원인을 전달합니다. 클라이언트 발신 연결 해제는 기존대로 조용히 종료.
- **Trae / MiniMax의 가중치 조회가 완성 요청을 막지 않음**: 가중치 캐시 만료 후 첫 요청이 각 계정의 한도 조회를 **순차 완전 대기**(Trae는 계정당 POST×2·각 15s 상한) — 상위 블랙홀 시 완성 요청이 1-2분 정지. 이제 병렬 조회·**계정당 2초 상한**: 정상 시에는 새 값으로 정확히 분배하고, 블랙홀 시에는 이전 스냅샷으로 먼저 진행하며 갱신은 백그라운드에서 계속됩니다(in-flight 중복 제거로 조회가 배로 늘지 않음).
- **프록시 경유 응답의 스트리밍화**: 프록시 경로는 본문 전체를 받고 나서 resolve — 「프록시 우선」 모드에서는 생성 중인 단 1바이트도 클라이언트에 도달하지 않아 첫 토큰 타임아웃이 반드시 오탐. PassThrough로 청크 단위 투과로 변경(월클록 상한은 그대로 스트리밍 본문을 관리).
- **10Router 설정 읽기 실패가 기본값으로 조용히 덮어쓰이지 않음**: `loadConfig`는 모든 읽기 오류(백신/동기화 도구의 일시 잠금, JSON 손상)에서 기본 설정을 반환했고, 다음 쓰기가 「기본값 + 이번 변경」을 실제 파일에 통째로 기록 — 엔드포인트·키·동기화 워터마크 전멸. 이제 파일 부재만 기본값, 손상은 `.bak`에서 복구(저장 전 자동 유지), 그 외는 예외로 던져 기록 회피.
- **CLI 변경 명령은 실행 중 daemon과 상호 배타**: `withAccounts` 직렬화는 단일 프로세스 내에서만 유효 — daemon이 방금 교체한 refreshToken이 CLI의 오래된 스냅샷 기록으로 지워질 수 있습니다(일회용 refresh가 즉시 무효). `add / import / checkin / remove / scan`은 백그라운드 인스턴스를 감지하면 거부하고 패널 이용 또는 `creditdaddy stop`을 안내.
- **패널 폴링과 요청 수명 주기**: 30s/10s/5min 폴링에 단일 비행 가드(daemon 정체 시 무한 적체 없음); `api()`에 월클록 타임아웃(기본 2분, 전체 체크인 / 10R 푸시 등 무거운 작업은 명시적으로 5-10분으로 연장); 한도 일괄 로드의 만료 결과가 새 live 값을 덮어쓰지 않음; 무료 페이지 카드 드래그 리스너는 기동 시 한 번만 바인딩(이전에는 렌더링마다 누적되어 drop 1회에 N회 재정렬); 디바이스 로그인 폴링은 일시적 실패 허용(연속 5회만에 중단).
- **데스크톱 셸(Electron)**: 설치 관리자 `spawn`에 `error` 이벤트 처리 추가(백신 격리 시에도 메인 프로세스가 죽지 않음); `shell-open-external`은 https만 허용; GitHub 업데이트 확인 15s 타임아웃·설치 패키지 다운로드는 60s 무데이터 절단; 저장 비밀번호 대화상자를 단일 패스 토큰 치환으로 변경(자리표시자 문자열을 포함한 비밀번호가 손상되어 저장되지 않음); captcha 창 JSON 주입 수정.
- **fnOS 통합 게이트웨이 프록시**: 압축 응답은 HTML 재작성하지 않음(gzip 디코딩 후 치환은 반드시 깨짐); 클라이언트 연결 해제 시 즉시 상위 연결 파기; `stop` / 제거 시 프록시 프로세스를 스크립트 이름으로 확실히 정리(pid 파일 분실 시에도 고아 프로세스가 app.sock을 점유하지 않음).
- **기타**: Qoder 임시 보관 웹 세션에 48h TTL; 패널 키 스로틀과 한도 새로고침 콜백의 IP 계수 Map 주기적 청소; catpaw 사용량 워터마크는 410일 창 밖을 정리; `atomicWrite` 첫 기록 실패 시 임시 파일 정리; 계정 삭제 시 세 게이트웨이의 쿨다운/가중치/스티키 잔류 삭제(`forgetAccount`); Qoder는 「200이지만 비 JSON」 응답에 명확한 오류(SyntaxError가 「토큰 사용 불가」로 위장하지 않음); ZCode 수동 획득 라운드 종료 시 자동 획득이 켜져 있으면 스케줄 재배치; 설정 API가 체크인 필드 조기 반환으로 같은 요청의 비밀번호 변경을 놓치지 않음; Doubao 클라이언트 데드 코드 정리.

### ✨ 추가(2026-10-31 로컬 테스트 빌드)

- **Loomy 제품 라인 4종 완비**: ① 신규 휴대폰 번호 **자동 등록** — SMS 직접 로그인이 거부되면(미등록) 같은 인증 코드로 `/register/phone/submit` 등록 후 자동 재로그인; 계정명은讯飞 닉네임 우선(`/userinfo/query/baseInfo`), 유효기간은 14일로 저장. ② **클라이언트 열기** — Loomy 페이지 툴바에 「클라이언트 열기」 버튼(실행 상태 점 표시, 데스크톱 IPC로 Loomy.exe 실행). ③ **계정 전환** — Loomy 계정 카드에 전환 버튼: `auth-session.json`에 기록하고, 강제 전환 시 클라이언트를 먼저 종료한 뒤 기록 후 자동 재실행(ZCode/Trae와 동일한 경험). ④ **포인트 기준 수정** — 잔액을 클라이언트의 실제 포인트 API `GET {loomyad.xunfei.cn}/api/v1/points/records?pageNo=1&pageSize=1&recordType=all` 로 변경(영구 포인트 = 응답 `balance`, 매일 증정 포인트 = `dailyBalance` 2줄, 단위 「포인트」), **모델 수를 포인트로 둔갑시키는 것 폐지**(이전 「남은 13」은 사실 모델 풀 크기). **100002 근원 수정**: 클라이언트 `points-config.js`의 기본 포인트 URL `ossptest.voicecloud.cn/loomy/integration`은 개발/테스트 환경으로(세션 테이블이 운영과 별도) 운영 세션을 보내면 반드시 100002 「로그인 만료」가 나오지만 인증층 baseInfo에서는 같은 세션이 유효한, 매우 혼동스러운 상태였음. 클라이언트 실기 통신 실측에서 ossptest에는 전혀 접속하지 않고 loomyad.xunfei.cn만 사용하며, 운영 도메인에서는 같은 세션의 records가 `code=000000·balance=10500`을 반환해 클라이언트 UI와 일치. 포인트 조회는 클라이언트 프로토콜대로 100002 시 멱등한 `POST /api/v1/points/first-login`으로 프로필 초기화 후 1회 재시도하고, 그래도 실패할 때만 정직하게 보고한다. 가짜 숫자는 보여주지 않음.
- **ZCode 「숨겨진 활동」 자동 폴백(WEEKEND BUILD 획득 불가의 근본 해결)**: 서버는 때때로 활동을 `billing/preview` 목록에서 숨김(2026-10-30 WEEKEND BUILD 실측: preview는 비었지만 claim은 planId로 직접 획득 가능·인증 코드 불필요). 「먼저 목록 조회, 비어 있으면 알려진 planId를 순서대로 시도」 폴백 — 1001/1002(미존재/종료)는 조용히 건너뛰고, 1003은 이미 획득, 0은 획득 성공; 수동 획득 모달의 빈 상태에 「알려진 활동 시도」 버튼 추가(동일 폴백). 새 활동이 나타나면 `ZCODE_KNOWN_CLAIM_PLANS`에 한 줄만 추가.
- **Loomy 로그인 피드백**: SMS 발송 / 로그인 요청에 45초 패널 타임아웃(무한 「로그인 중…」 해소, 실패 사유는 바로 토스트로), 기존 계정 재로그인 시 「자격 증명이 업데이트되었습니다」 안내.
- **Loomy 초대 코드 입구**: Loomy 계정 카드에 「초대 코드 입력」 버튼(선물 아이콘) 추가——코드를 입력하면 클라이언트 동일의 `POST {loomyad}/api/v1/points/activation` 로 바인딩하며, 서버가 신규 계정에 영구 포인트 +5,000 지급(계정당 1회). 바인딩 후 해당 카드의 포인트를 자동 갱신하고 실행 로그에 결과 기록. 프로토콜은 클라이언트 points-service에서 역산(`bindInviteCode` / 상태는 `GET activation` → `{activated, appliedInvitationCode}`).
- **리뷰 후 두 패치(정식版 마무리)**: ① #42——`dailyConsumedPoints`는 존재하면 곧장 직독(0이어도), `||` 체인으로 유령 「사용」을 역산하지 않음(상위 used도 동일 기준; 10Router 측 open-sse/services/usage/loomy.js도 동일 수정으로 정렬, 양쪽 모두 =0 회귀 테스트); ② 대시보드 Loomy 카드에 「포인트 합계」 집계 행 추가(이전에는 잘못 배치된 「활동 수령」 문안에 집계 없음), 4개 언어 문안을 1행식으로 수렴.
- **Loomy 「클라이언트 현재」 배지 수정(전환 혼란의 근원)**: 패널 배지는 `a.token`으로 비교했지만 계정 카드는 마스킹 뷰(`tokenMasked`)만 내려보내므로 `a.token`은 항상 비어 배지가 영원히 켜지지 않았고, 어느 카드가 클라이언트 현재 로그인인지 알 수 없어 현재 계정에 전환을 누르면 「이미 해당 계정」만 돌아와 「전환 불가」처럼 보였음. `/api/status`에 `loomyCurrentUid`(auth-session.json의 userid)를 추가하고 다른 제품선과 동일하게 uid 비교로 통일.
- **Loomy 전환을 하드 전환으로 + 경계 명시(외부 전환의 능력 한계)**: 「전환했는데 안 됨」의 진범을 실측으로 포착——종료 시 되돌려쓰기만이 아니라, **클라이언트 렌더러가 UI 로그인 상태를 자체 localStorage(`loomy-auth-session`)에 보관하다가 기동 시 메인 프로세스로 역으로 밀어냄**(실측: CD가 187 기록 21초 뒤 재기동한 클라이언트가 131로 되돌려 씀). 게다가 렌더러는 메인에서 세션을 끌어오지 않음(asar에는 `setSession/clearSession/onSessionInvalidated`만 있고 `getSession` 호출 없음)——**ZCode/Trae식 외부 주입 전환은 Loomy에서 구조적으로 불가능**(Chromium Local Storage 바이너리 형식은 외부에서 안전하게 고칠 수 없음). 이제: 전환은 통일 하드 전환(클라이언트 종료 → 자격증명 기록 → 지연 재검증으로 늦은 되돌려쓰기 방비) + **실제 전환이 일어나면 반드시 클라이언트 자동 재기동**(이전에는 클라이언트가 꺼져 있을 때 전환해도 아무 일도 없었음); **자격증명 파일 결손(클라이언트 내 로그아웃으로 비워짐)이 전환을 막지 않음**——대상 계정의 session/userid/phone을 계정 저장소에서 곧장 기록(이전에는 「사용 가능한 자격증명 파일 없음」의 막다른 길이면서 실패도 로그에 없었음); 전환 실패도 실행 로그에 기록. 패널과 로그에 경계를 명시——CD 측 계정 전환·포인트·10Router 동기화는 대상 계정으로 유효, 클라이언트 UI가 여전히 이전 계정을 보여주면 클라이언트 내에서 로그아웃→재로그인 필요.
- **Loomy의 10Router 동기화 복구**: 채널 화이트리스트는 Loomy 추가 이전 저장값(`accountSync.providers`에 loomy 없음)이고 계정 관리 대화상자에도 loomy 행이 없어——동기화는 항상 loomy 계정을 걸러냈음. 대화상자에 「讯飞 Loomy」 채널 행 추가; 동기화 페이로드는 loomy에 `authType:'apikey'` 부여(10Router 네이티브 loomy 행은 apikey 형태로 자격증명이 `apiKey`에 저장, 이 필드가 없으면 가져오기가 oauth로 기록되어 apiKey 미기록). 실측: Loomy 2계정의 10Router 가져오기 성공, 재동기화는 멱등하게 동일 행 「업데이트 2」 적중. 패널의 「계정 동기화」도 실행 로그에 `10Router 账号同步:{summary}`를 기록——이전에는 성공해도 로그에 흔적이 없었음.

### 🌐 기타

- 웹 세션 사이트 라벨과 제품 설명에 「Doubao」 추가; 다국어 변경 로그(en/ja/ko) 동기화.
- **1.6.5 전량 코드 리뷰 수정(9a056a0..HEAD 전체 diff 멀티에이전트 검토, 9건 발견 모두 수동 확인)**: ① loomyClient의 포인트/액티베이션/초대 코드 3개 엔드포인트에 `res.ok`·비 JSON 검사 추가——상위 5xx/HTML 오류 페이지가 「바인딩 성공」이나 「0 포인트」로 삼켜지지 않음; ② 매일 증정 상한은 서버가 명시한 0을 5000으로 조작하지 않음——잔액 0의 빈 계정은 empty 기준으로 복귀(「0/5000 사용 5000」 유령 소멸); ③ ZCode 숨김 활동 무음 스킵을 known 목록 폴백 항목(`known` 마커)으로 한정——preview 목록의 실재 활동이 1002를 반환하면 여전히 실패로 기록; ④ `/api/status`가 `loomyCurrentToken`(생존 세션 토큰, 소비자 없음)을 내보내지 않음——노출 면을 uid로 수렴; ⑤ 하드 전환이 이전 계정 전화번호를 대상 계정 자격증명에 섞지 않음; ⑥ 전환 라우트 안의 도달 불가한 두 번째 Loomy 분기와 loomyLocal 사문 내보내기(switchTo/killLoomy/launchLoomy/switchLoomyAccount/currentLoomyToken) 삭제; ⑦ Loomy 전체 UI 문자열 4개 언어 번역 완비(빈 상태/로컬 가져오기 안내/SMS 로그인 흐름/전환 경고 15条)하고 무효 키 제거. 테스트 366/366.

---

## [1.6.2] (2026-10-26)

테마: **ZCode 패키지 게이트웨이 분배 정비(로테이션 수정 + 세션 스티키) + LongCat 패키지 행 수치 왜곡 수정 + 지급 시각 가시화 + 429 단계적 백오프와 전환/획득 피드백 정비**.

> **태그 전 추가(2026-10-28)**: 아래 「429 단계적 백오프」「WorkBuddy 미설치 가드」「획득 즉시 카드 반영」「10R 채널 스위치」 네 그룹은 본 버전에 함께 포함(태그 미공개로 독립 버전 번호 없음).

### 🔧 수정

- **게이트웨이 429 쿨다운: 고정 5분 → 단계적 백오프**: 세 게이트웨이 모두 429 쿨다운을 5분으로 고정 — 상위 레이트 리밋 기간은 보통 5분을 넘어, 쿨다운이 끝나자마자 다시 429를 맞는 무한 루프. 이제 연속 횟수에 따라 **30s → 1분 → 2분 → 5분 → 10분**(5회째부터 10분 상한)의 사다리. 성공 1회로 계수 리셋 — 일회성 429는 누적되지 않습니다. 리셋 지점은 완성 성공(스트리밍/비), 인증 정보 갱신 부활, 게이트웨이 재시작, 새 획득 네 곳. 로그에 연속 횟수 포함.
- **Trae 게이트웨이의 events 단계 429가 쿨다운에 들지 않음**: Trae는 2단계(세션 생성 → events 읽기)이며, 읽기 단계의 429가 계수되지 않아 다음 세션 생성이 또 30초부터 시작. 생성 단계와 같은 사다리로 통일.
- **WorkBuddy 미설치 시 전환에 명확한 안내**: `writeWorkbuddySession()`이 무조건 mkdir + 기록 후 성공 반환 — 미설치 기기에서는 「전환됨」이 표시되지만 적용할 클라이언트가 없는 막다른 길. `detectWorkbuddy()`는 클라이언트 exe만 근거로 삼고, 미설치 시 `WORKBUDDY_NOT_INSTALLED`를 반환하여 toast/배너로 안내(토큰 가져오기·한도·일일 획득은 영향 없음, 전환만 클라이언트 필요).
- **ZCode 획득 성공 후 카드와 배지 즉시 갱신**: 자동·수동 두 경로 모두 `loadQuotas()`만 하고 다시 그리지 않았고, `statusOf()`는 ZCode에 빈 배지 — 획득 결과가 카드에 아무 흔적도 없었습니다. `effective_at`(당일 늦게 지급)까지는 「적용 대기」 상태로 이전 상태와 구별이 안 보여 수동 새로고침이 필요했습니다. 세 곳(자동/수동/단일 카드 새로고침)에서 다시 그리고 「수령 완료 / 이미 수령 / 실패」 배지 추가.
- **ZCode 패키지 게이트웨이의 「다중 계정 로테이션」이 실제로는 돌지 않았음**: `rotationQueue()`가 포인터 `rrIndex`를 범위 내로 정규화만 하고 **절대 증가시키지 않음** — 선두는 항상 첫 번째 계정이고, 다른 계정은 실패/쿨다운/차단 때만 사용. 매 라운드 한 칸씩 전진시켜 요청을 각 계정에 분산; 가용 집합 변화 시 나머지로 위치 복귀.
- **LongCat 리소스 패키지 행 수치 왜곡(issue #37)**: 실제 수치를 `name` 텍스트에 섞어 넣고 구조화 필드는 `used=0 / total=잔여 / remainingPercentage=100` — 10R은 구조화 필드만 믿으므로 만점 미소비 바와 name이 모순. **필드가 곧 진실**로 변경: `used`=소비·`total`=총량·`remainingPercentage`=잔여율, `name`은 순수 문안, 만료는 `resetAt`; Balance 행은 Σ소비/Σ총량을 푸시.
- **ZCode 획득 성공했지만 미지급일 때 「HH:MM 지급」 표시**: `claimPlan()`은 `startsAt`을 반환했지만 `zcodeAutoClaim`이 버렸습니다. 두 획득 경로(captcha 없음/무음 captcha) 모두 `startsAt`을 운반하며, 미래 지급 시에만 「（HH:MM 지급）」을 추가(같은 날은 시:분, 날짜가 바뀌면 `M-DD HH:MM`).

### ✨ 새 기능

- **ZCode 패키지 게이트웨이 세션 스티키**: 같은 대화의 연속 턴은 같은 계정에 고정, 새 대화에서만 로테이션. 세션 ID는 body의 `metadata.user_id`에서(관용 파싱 3가지 형태); `metadata.user_id`는 **호출자가 전달하면 그대로 투과, 미지정 시에만 생성** — 이전에는 매 요청 새 `session_id`라 상위에서 보면 매번 새 대화였습니다. 스티키 TTL 30분, 차단/쿨다운/마킹 시 자동 양보.
- **10Router 계정 동기화 채널 스위치**: 계정 관리 대화상자에 채널 체크 영역(로컬에 계정이 있는 채널만 표시), 각 채널에 두 개의 체크 — 주 체크 = 한도 카드 푸시, 「연결」 = 계정 연결 동기화. 10Router 측에 동일 출처 채널(minimax-code 연결 등)이 있으면 체크를 해제하여 중복 카드(`minimax-free-*`)를 만들지 않습니다. `tenrouter.json`에 `accountSync { enabled, providers }`와 `quotaPushDisabledProviders[]` 추가; 제외 채널의 새로고침 콜백은 410.
- 패널의 「API 사용 중」 배지는 복수 계정 시 로테이션 공유를 주기; `gatewayStatus`에 `stickySessions`.

### 🌐 기타

- `gatewayStatus` 세 게이트웨이에 `coolingDetail`(잔여 초/문안/연속 횟수); `cooling`은 문자열 배열의 기존 형태 유지. `formatDuration.js` 추가(쿨다운 시간 가독화, 30s는 초 표시).
- 10Router 툴바 순서를 잔량 새로고침 · 사용량 동기화 · 계정 관리 · 설정으로.
- 테스트 보강: 로테이션/스티키, 세 게이트웨이 429 사다리, `formatDuration` 경계, `detectWorkbuddy`, 채널 화이트리스트 등. 전체 340건.
- i18n 항목 추가(4개 언어 동기화); `check-i18n.js` 전체 통과.

---

## [1.6.1] (2026-10-23)

테마: **Qoder 이중 채널 전환 정비(현재 계정 판정 / 실제 원인 오류 / 자동 실행) + ZCode 특전 「적용 대기」 표시 + 10Router 계정 관리 진입**.

### 🔧 수정

- **Qoder 전환 후 현재 계정 판정 어긋남(전환 버튼 소실)**: 국제/국내를 오가면 「클라이언트 현재」 표시가 실제 로그인과 불일치 — `qoderCurrent`는 uid 비교만 하고 60초 캐시. 클라이언트가 조용히 토큰을 갱신(uid 동일·토큰 교체)하기 때문에 동일 uid 복수 기록에서 다른 기록을 현재로 오인. 이제 `auth.v1.dat`에서 푼 **토큰으로 계정 id를 정확히 대조**(uid는 폴백), 전환 성공 후 즉시 캐시 클리어. 회귀: `test/qoder-current-token.test.js`.
- **Qoder 전환 시 인증 정보 무효 안내가 실제 원인을 가리킴**: 기존 메시지 「인증 정보 파일이 존재하지 않습니다(제거 또는 데이터 디렉터리 변경 가능)」는 최빈 원인 「클라이언트 로그아웃으로 `auth.v1.dat` 삭제」를 엉뚱한 방향으로 안내. 탐지 결과에 따른 안내(설치됨 → 클라이언트에서 로그인 후 「로컬 가져오기」; 미설치 → 먼저 설치 후 로그인) + 계정명·채널명 포함.

### ✨ 새 기능

- **Qoder 전환 후 클라이언트 자동 실행**: 강제 전환은 Qoder를 먼저 종료시키며, 이전에는 「다시 열어 주세요」에서 멈췄습니다. ZCode / mirasim / 妙手 / Trae와 동일하게 기록 후 자동 실행하며, 채널에 맞는 해당 하나만 실행(국제판 전환 시 국내판을 함께 열지 않음).
- **ZCode 미적용 특전을 「적용 대기」로 별도 표시**: 특전은 `effective_at`까지 잔여에 반영되지 않음(3억+2억 등) — 이전에는 「잔여 0 / 5억」으로 표시되어 획득 실패로 보였습니다. 전체 미적용이면 주 행 「적용 대기 5억 Token · 이벤트명 · HH:MM 지급」+ 점선 프로그레스(pending-ghost); 부분 적용 시 잔여 행 아래에 추가. 백엔드에 `pendingTotal` / `pendingAt`과 특전별 `planName`.
- **10Router 「Cookie 세션」을 「계정 관리」로**: 계정 동기화는 「10Router 연결 설정」 최하단에 숨어 찾기 어려웠습니다. 툴바 「계정 관리」 대화상자에 두 영역 통합 — 계정 동기화(로컬 Qoder / WorkBuddy를 상위 연결로 푸시, 패널 비밀번호 입력으로 OAuth 경로)와 웹 세션(Token Harbor 등). 중복 블록과 구 대화상자의 데드 코드 삭제.

### 🌐 기타

- i18n 항목 추가(적용 대기 / 지급 / 계정 관리 / Qoder 실행 관련) 4개 언어 동기화; `check-i18n.js` 전체 통과.

---

## [1.6.0] (2026-10-21)

> **동일 버전 재배포 (2026-10-21)**: 첫 빌드 후(태그 미공개·공개 산출물 없음) 같은 날 여섯 건의 수정이 반영되어 본 태그로 통합 배포. 기존에 로컬 배포된 테스트 빌드(81b02e0 / 5b5aab6 / b6f6dad 등)는 본 태그 산출물로 대체됩니다.

테마: **Trae 9074 디바이스 ID 로테이션 재시도(#31) + WorkBuddy 국제판 "액티브 클레임" 폐지 + Doubao 데일리 체크인 8번째 제품 라인(#32) + MiniMax 무료 한도 카드 10Router 복귀 및 읽기 전용 체크인 상태(#33 플랜 B) + 2026-10-21 여섯 건 수정 배치**.

### ✨ 새 기능

- **Doubao(doubao.com) 데일리 체크인 지원(issue #32, 8번째 제품 라인, 웹 세션 캡처 라인)**: CDP 실측(완료/미완료 시나리오)으로 엔드포인트 형상 확인 — 캠페인 상세 API로 상태 조회, 랜딩 체크인 API로 수령(+200 크레딧/일); 순수 cookie 인증, a_bogus/msToken 서명 없음, 서버 멱등(중복 수령은 `idempotent:true`로 기완료 처리); cookieSites 탐지 프레임워크가 method/body 지원으로 확장(JSON API 탐지 선례). 참여 조건 실측 확인: **개인 계정만 가능**(Feishu 조직 계정은 제외, 오류 그대로 표시).
- **MiniMax 무료 한도 카드 10Router 복귀 + 읽기 전용 체크인 상태(#33 플랜 B)**: 각 한도 행에 `checkinToday` / `streakDays` 읽기 전용 필드를 붙여 푸시 재개 — 자격 증명은 CD 밖으로 나가지 않고 10Router는 표시만 담당(배지 렌더링은 10Router#77이 소비, 구버전은 미지 필드 무시). **체크인 동작은 10R에 넣지 않음**(읽기 전용 경계). `fetchMiniMaxCheckinStatus` 신설, 조회만 하고 수령하지 않으며 실패 시 null로 푸시를 깨뜨리지 않음.
- **WorkBuddy 원클릭 활동 수령**: 임시 활동(추가 보상/첫 달 선물)을 전 계정 일괄 수령하는 엔드포인트 추가, 패널에서 원클릭.
- **웹 세션 탐지 빈도 거버넌스**: 패널의 2분 폴링이 전체 업스트림을 두드리지 않도록, `/quota`는 기본 캐시 스냅샷을 읽고 수동 "새로고침" 버튼만 실제 탐지; 푸시 루프가 지나가면서 스냅샷을 신선화.

### 🐛 수정

- **Trae 체크인 9074 디바이스 ID 로테이션 재시도(issue #31)**: 대조 실험으로 파생 디바이스 ID는 일괄 9074 거부, 같은 시각의 실기기 ID는 수령 가능함을 확인 — 재시도 시 **파생 디바이스 ID 로테이션**(attempt 증가), 3s/8s/15s 백오프. ⚠️ 파생 salt 변경으로 전 계정의 기본 지문이 한 번 로테이션됨: **업그레이드 후 첫 체크인에서 9074가 보이면 정상**, 재시도 메커니즘이 자동으로 ID를 바꿔 몇 회 후 안정됩니다.
- **업데이트 로그 다이얼로그 경험**: 즉시 열림 + 로딩 상태; 온라인 fetch가 "테마:" 행 형식 인식(1.5.1 항목은 이전에 제목만 표시됐었음).

### 🔧 수정 (2026-10-21 여섯 건 수정 배치, 자세히는 docs/incident-20261021-quota-sync.md)

- **mirasim 사용량은 공식 릴레이 행만 동기화**: 업스트림이 로컬 10Router인 호출은 재임포트하지 않음(10Router에서 codebuddy-cn과 mirasim-anthropic 이중 계상이었음). viaRelay 경계는 실측 제로 교차; 10Router 측 중복 4,066행 삭제, 집계를 진값 342행으로 재작성 완료.
- **minimax-free 구 집계 카드 업그레이드 시 자동 정리**: 구 카드는 7일 TTL 동안 신규 카드와 병존하는 대신 업그레이드 후 첫 푸시에서 자동 DELETE.
- **TraeWork→TRAE 마이그레이션 대응**: 신규 TRAE CN 클라이언트 우선 탐지(폐지된 SOLO CN의 잔여 디렉터리 낡은 자격증명을 선택하지 않음) + 국제판 클라이언트(trae.ai) 임포트 시 "중국 내수판만 지원" 명시 경고.
- **웹 세션 수확 후 계정 카드 잔액 즉시 갱신**: 수확 핸들러가 quota 캐시 재로딩을 누락해 수동 갱신까지 옛 수치(예: Xiaomi ¥0.00)가 남는 문제.
- **"무료 한도 푸시 설정"을 "한도 카드 푸시 설정"으로 개칭**: 푸시 범위는 구독/잔액 라인도 포함하며 무료만이 아님; 4개 언어 사전 동기 갱신.
- **i18n 사전 죽은 항목 일괄 정리**: 미참조 86개 ×4개 언어 삭제(1783→1699), 오삭제 방지 이중 검증 포함.

---

## [1.5.1] (2026-10-18)

테마: **Trae 체크인 9074 리스크 컨트롤 재정립(issue #31) — 일시적 레이트 리밋은 백오프 재시도하고 "본기기 수령 완료" 오표기를 그만둠 + 실패 표시에 서버 코드 + 네트워크 오류 원인 집계.** 파괴적 변경 없음.

### 🐛 수정

- Trae 9074를 일시적 레이트 리밋으로 처리: 백오프 재시도(3s/8s/15s), 계정을 "수령 완료"로 오마크하지 않음; 실패 토스트에 서버 코드 표시; 네트워크 오류 원인 집계.
- logger 런타임 강화: 로테이션된 아카이브 스트림 + 현행 스트림의 error 리스너(Windows 비동기 쓰기 EBUSY/EPERM으로 데몬이 죽을 가능성).

---

## [1.5.0] (2026-10-15)

테마: **웹 세션 캡처 전면 확장 — 범용 브라우저 cookie 캡처 프레임워크(설정 구동) + 5개 업체 지원(Token Harbor / Xiaomi MiMo / River AI / ModelScope / LongCat) + 10Router 한도 카드 동기화**. 파괴적 변경 없음.

이전 릴리스: [CHANGELOG.md](./CHANGELOG.md)(중국어) 참조.
