# 🔪 마피아 게임

폰으로 함께하는 실시간 마피아 게임 웹앱. 6자리 코드나 QR로 접속해서 플레이합니다.

## 게임 방식

- 방장이 방을 만들면 **6자리 코드 + QR**이 생성됨 → 친구들이 폰으로 접속
- 방장이 마피아/경찰/의사 인원을 설정하고 **게임 시작** → 역할 랜덤 배정, 그중 **1명은 랜덤으로 사회자**
- 사회자가 밤 → 낮(토론) → 투표 단계를 버튼으로 진행
- **밤**: 마피아는 제거 대상, 의사는 보호 대상, 경찰은 조사 대상을 각자 폰에서 선택 (경찰은 결과를 즉시 확인)
- 밤 행동 현황과 전체 역할, 투표 내역은 **사회자만** 실시간으로 볼 수 있음
- **투표**: 생존자 전원이 폰으로 투표 → 사회자가 집계를 보고 처형 결정
- 마피아 전멸 → 시민 승리 / 마피아 수 ≥ 나머지 → 마피아 승리
- 게임이 끝나면 전체 역할 공개, 같은 멤버로 바로 다시 시작 가능

## 로컬 실행

```bash
npm install
npm start
# http://localhost:3000
```

같은 와이파이의 폰에서 테스트: `http://<맥의 IP>:3000`

## Railway 배포

1. GitHub에 이 폴더를 push
2. [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo** 선택
3. 자동으로 `npm install` + `npm start` 실행됨 (PORT 환경변수 자동 처리)
4. Settings → Networking → **Generate Domain** 으로 공개 URL 생성
5. 그 URL로 접속하면 어디서든 플레이 가능 (QR도 그 주소 기준으로 자동 생성됨)

GitHub 없이 CLI로 배포하려면:

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway domain
```

## 참고

- 방 상태는 서버 메모리에만 저장됨 (재배포하면 진행 중인 방은 사라짐)
- 새로고침/일시적 접속 끊김은 자동 복구됨 (localStorage 세션)
- 최대 20명, 방은 전원이 나간 뒤 6시간 후 자동 삭제
