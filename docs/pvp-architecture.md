# 방 코드 PVP 아키텍처

- 상태: 현재 구현 기준선
- 문서 버전: 0.3
- 최종 검토: 2026-07-22

이 문서는 [게임 규칙 명세](./game-rules.md)를 서버 권위의 2인 실시간 웹 게임으로 구현하기 위한 논리 아키텍처와 데이터 계약을 정의한다. 특정 프레임워크를 고르기 전에도 규칙 엔진, 네트워크, 저장소, UI의 책임이 섞이지 않게 하는 것이 목적이다.

## 1. 목표와 범위

### MVP 목표

- 방장이 방을 만들고 6자리 방 코드를 공유한다.
- 상대가 코드와 게스트 닉네임으로 참가한다.
- 두 플레이어가 준비하면 서버가 선공을 정하고 경기를 시작한다.
- 모든 난수와 규칙 판정은 서버가 담당한다.
- WebSocket 연결이 끊겨도 같은 좌석으로 재접속할 수 있다.
- 모바일 브라우저의 백그라운드 전환과 일시적인 네트워크 손실을 견딘다.
- 종료 후 두 사람이 동의하면 같은 방에서 새 경기로 재대결한다.

### MVP 비목표

- 계정, 친구, 랭킹, 영구 전적
- 랜덤 매칭
- 관전자, 채팅, 이모트
- 토너먼트
- 영구 포인트와 티카투카 선언
- 여러 지역에 걸친 대규모 분산 실행
- 원작 로고, 캐릭터, UI, 음원 사용

## 2. 핵심 설계 원칙

1. **서버가 유일한 판정자다.** 클라이언트는 행동 의도만 보내고 주사위 값, 제거 결과, 점수, 다음 턴을 결정하지 않는다.
2. **규칙 엔진은 순수하게 유지한다.** 네트워크, DB, WebSocket 연결 상태, 시스템 시계에 직접 접근하지 않는다.
3. **방 코드는 인증 수단이 아니다.** 방을 찾는 공개 식별자와 좌석을 되찾는 비공개 세션 자격을 분리한다.
4. **작은 전체 스냅샷을 활용한다.** 양쪽 보드를 합쳐 최대 30개 주사위뿐이므로, 승인된 행동마다 이벤트와 최신 스냅샷을 함께 보내 복구를 단순하게 한다.
5. **버전과 멱등성을 기본값으로 둔다.** 모든 게임 명령에 `expectedVersion`과 `actionId`를 넣어 중복 탭, 재전송, 늦게 도착한 패킷을 안전하게 처리한다.
6. **화면 방향과 게임 좌표를 분리한다.** 서버의 플레이어 ID와 라인 `0..2`는 고정하며, 각 클라이언트는 자신을 편한 위치에 그린다.

## 3. 논리 구성

MVP는 하나의 애플리케이션 안에서 책임을 나눈 **모듈형 모놀리스**로 시작한다. 현재 규모에서 규칙 서비스, 방 서비스, WebSocket 서비스를 별도 배포하면 트랜잭션과 장애 지점만 늘어난다.

```text
모바일/데스크톱 웹 클라이언트 A, B
        | HTTP: 방 생성·참가·세션
        | WebSocket: 명령·이벤트·스냅샷
        v
애플리케이션 서버
  - Room Service        방 수명주기, 준비, 재대결
  - Realtime Gateway    인증, 연결, 송수신 스키마
  - Command Handler     멱등성, 버전, 트랜잭션
  - Game Rules Engine   순수 규칙 전이와 점수 계산
  - Presence/Timer      접속 상태, 턴·재접속 마감
        |
        v
Storage Adapter
  - 개발: 메모리
  - 배포: 트랜잭션 가능한 영속 저장소
```

### 경계별 책임

| 경계 | 담당 | 담당하지 않음 |
| --- | --- | --- |
| 규칙 엔진 | 명령 검증, 보드 변경, 점수, 다음 턴, 결과 | HTTP, DB, 소켓, 실제 시계, 세션 |
| 애플리케이션 계층 | 인증된 명령 처리, 버전, 멱등성, 트랜잭션, 시스템 명령 | UI 표현 |
| 실시간 게이트웨이 | 연결 인증, 스키마 검증, 메시지 전달, heartbeat | 게임 규칙 판정 |
| 방 서비스 | 생성, 참가, 준비, 경기 생성, 재대결, 만료 | 주사위 규칙 |
| Presence/Timer | 접속 상태와 마감 관리, 시스템 명령 발행 | 게임 상태 직접 수정 |
| 저장소 | 방·경기·행동 결과 원자적 저장 | 점수 재계산 |
| 클라이언트 | 입력, 애니메이션, 서버 상태 표시 | 난수, 최종 판정, 권한 검증 |

`connected`는 규칙 상태가 아니라 presence 상태다. 연결이 끊겼다는 이유로 규칙 엔진의 보드를 직접 바꾸지 않고, 유예 시간이 끝났을 때 애플리케이션 계층이 `SYSTEM_SURRENDER` 같은 명시적 시스템 명령을 발행한다.

## 4. 식별자와 인증

| 값 | 공개 여부 | 용도 |
| --- | --- | --- |
| `roomId` | 내부 | 방의 영구 식별자, UUID/ULID |
| `roomCode` | 공개 | 사람이 방을 찾는 6자리 코드 |
| `playerId` | 제한적 공개 | 경기 안의 좌석 식별자 |
| `gameId` | 제한적 공개 | 재대결마다 새로 생기는 경기 식별자 |
| `sessionToken` | 비공개 | 브라우저가 자기 좌석을 복구하는 고엔트로피 자격 |
| `actionId` | 공개 가능 | 클라이언트가 만든 명령 멱등성 키 |
| `version` | 공개 | 경기 상태의 낙관적 동시성 버전 |

### 방 코드

- 혼동하기 쉬운 `I`, `L`, `O`, `0`, `1`을 제외한 대문자와 숫자를 사용한다.
- 예시 알파벳: `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
- 서버는 생성 시 활성 방과의 충돌을 확인하고 충돌하면 다시 만든다.
- 4자리 숫자는 탐색 공간이 너무 작으므로 사용하지 않는다.
- 참가 시도에는 IP와 방 코드 기준 속도 제한을 둔다.
- 대기 중인 방은 일정 시간 뒤 만료한다. 시작된 경기는 별도 보존 정책을 사용한다.

### 좌석 세션

- 방 생성·참가 성공 시 최소 128비트 이상의 불투명한 `sessionToken`을 발급한다.
- 가능하면 `HttpOnly`, `Secure`, `SameSite=Lax` 쿠키에 저장한다.
- WebSocket 연결은 같은 쿠키 또는 짧게 유효한 1회용 WebSocket ticket으로 인증한다.
- 토큰을 방 코드, 닉네임, URL, 공유 메시지, 일반 로그에 넣지 않는다.
- 서버 저장소에는 토큰 원문 대신 안전한 해시를 저장한다.
- 닉네임은 표시용 값일 뿐 인증 수단이 아니다.

## 5. 방 수명주기

```text
WAITING_FOR_OPPONENT
  -> LOBBY
  -> IN_GAME
  -> POST_GAME
       | 두 플레이어가 재대결 동의
       v
     IN_GAME (새 gameId)

어느 단계에서든 만료/해산 -> CLOSED
```

### 생성부터 시작까지

1. 방장이 닉네임을 보내 방을 생성한다.
2. 서버가 `roomCode`, 방장 좌석 세션, 방 스냅샷을 반환한다.
3. 상대가 `roomCode`와 닉네임으로 참가한다.
4. 각 플레이어가 준비 상태를 보낸다.
5. 두 명이 모두 준비되면 서버가 새 `gameId`를 만들고 선공을 CSPRNG로 선택한다.
6. 서버가 시작 실드를 굴린 상태로 첫 게임 스냅샷을 양쪽에 보낸다.

### 재대결

- 종료된 경기는 변경하지 않는다.
- 두 플레이어의 `REMATCH` 의사가 모두 모이면 같은 방 안에 새 `gameId`와 `version = 0`을 만든다.
- 선공, 보드, 타짜 사용 여부, 홀드 여부는 전부 초기화한다.
- 이전 경기의 `actionId` 멱등성 범위는 이전 `gameId`에만 적용한다.

## 6. HTTP와 WebSocket 경계

경로 이름은 구현 스택에 맞게 바꿀 수 있지만 책임은 유지한다.

### HTTP 예시

| 메서드 | 경로 | 역할 |
| --- | --- | --- |
| `POST` | `/api/rooms` | 방 생성, 방장 좌석 세션 발급 |
| `POST` | `/api/rooms/{roomCode}/join` | 빈 좌석 참가, 참가자 세션 발급 |
| `GET` | `/api/rooms/{roomCode}` | 인증된 좌석의 최신 방/경기 스냅샷 복구 |
| `POST` | `/api/session/ws-ticket` | 선택 사항: 짧게 유효한 1회용 소켓 ticket 발급 |
| `POST` | `/api/session/leave` | 대기 방 퇴장 또는 진행 경기 항복으로 변환 |

방 생성·참가 요청의 닉네임은 길이, 제어 문자, 공백 정책을 서버에서 검증한다. 렌더링할 때는 HTML로 해석하지 않는다.

### 게임 명령 봉투

```json
{
  "type": "GAME_COMMAND",
  "gameId": "01K...",
  "actionId": "019...",
  "expectedVersion": 12,
  "command": {
    "type": "ALKKAGI",
    "lane": 1
  }
}
```

- `actionId`는 클라이언트가 명령을 처음 만들 때 생성하고, 같은 명령을 재전송할 때 유지한다.
- `expectedVersion`은 사용자가 보았던 마지막 서버 스냅샷 버전이다.
- 서버는 세션에서 `actorPlayerId`를 얻는다. 클라이언트가 actor를 지정하지 않는다.

### 게임 명령

| 명령 | payload | 주요 검증 |
| --- | --- | --- |
| `PLACE_OWN` | `{ lane }` | 내 턴, `TURN_ACTION`, 내 라인 빈칸 |
| `ALKKAGI` | `{ lane }` | 내 턴, 같은 라인 빈칸, 상대 동일 눈 일반 주사위 |
| `USE_TAZZA` | `{}` | 내 턴, `TURN_ACTION`, 미사용, 턴 주사위(최초 실드 포함, 보너스 실드 제외) |
| `USE_SWAP_ITEM` | `{ lane, ownDieId, opponentDieId }` | 내 턴, `TURN_ACTION`, 이번 턴 아이템 미사용, 수량 보유, 두 대상이 같은 라인의 양쪽 보드에 존재 |
| `USE_REROLL_ITEM` | `{ boardOwnerPlayerId, lane, dieId }` | 내 턴, `TURN_ACTION`, 이번 턴 아이템 미사용, 수량 보유, 대상이 지정 보드·라인에 존재 |
| `CHOOSE_TAZZA_DIE` | `{ choice: "ORIGINAL" | "CANDIDATE" }` | 내 턴, `TAZZA_CHOICE` |
| `PLACE_BONUS_SHIELD` | `{ boardOwnerPlayerId, lane }` | 내 턴, `BONUS_PLACEMENT`, 대상 빈칸 |
| `HOLD` | `{}` | 내 턴, `TURN_ACTION` 또는 `TAZZA_CHOICE` |
| `SURRENDER` | `{}` | 진행 중인 경기의 참가자 |

로비의 `SET_READY`와 종료 뒤의 `REMATCH`는 게임 규칙 명령과 분리하고 `roomVersion`을 사용한다.

### 서버 메시지

| 메시지 | 역할 |
| --- | --- |
| `ROOM_SNAPSHOT` | 좌석, 준비, 현재 경기, 재대결 의사 |
| `GAME_SNAPSHOT` | 수신자에게 허용된 최신 전체 게임 상태 |
| `GAME_EVENTS` | 승인된 한 명령에서 생긴 순서 있는 연출용 사건 |
| `COMMAND_ACCEPTED` | `actionId`, 새 `version`, 필요 시 결과 요약 |
| `COMMAND_REJECTED` | 안정적인 오류 코드와 최신 `version` |
| `PRESENCE_CHANGED` | 상대 연결/재연결/유예 시간 상태 |
| `PING` / `PONG` | 연결 생존 확인 |

승인된 명령은 `GAME_EVENTS`와 새 `GAME_SNAPSHOT`을 함께 보낸다. 이벤트는 애니메이션 순서를 제공하고, 스냅샷은 최종 진실값을 제공한다. 재접속 시에는 과거 애니메이션을 재생하지 않고 최신 스냅샷부터 그린다.

## 7. 상태 모델

아래 타입은 언어 중립 계약을 TypeScript 형태로 표현한 예시다.

```ts
type PlayerId = string;
type LaneIndex = 0 | 1 | 2;
type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
type DieKind = "NORMAL" | "SHIELD";
type ItemType = "SWAP" | "REROLL";
type ItemInventory = Record<ItemType, number>;

type Die = {
  id: string;
  face: DieFace;
  kind: DieKind;
  createdBy: PlayerId;
};

type Board = [Die[], Die[], Die[]];

type TurnPending =
  | {
      source: "TURN";
      original: Die;
      candidate?: Die;
    }
  | {
      source: "BONUS";
      die: Die;
      attackedPlayerId: PlayerId;
      attackedLane: LaneIndex;
    };

type GamePhase =
  | "TURN_ACTION"
  | "TAZZA_CHOICE"
  | "BONUS_PLACEMENT"
  | "FINISHED";

type GameResult = {
  reason: "NORMAL" | "SURRENDER" | "DISCONNECT_FORFEIT";
  winnerPlayerId: PlayerId | null;
  laneScores: Record<PlayerId, [number, number, number]>;
  laneWins: Record<PlayerId, number>;
  totalScores: Record<PlayerId, number>;
};

type GameState = {
  schemaVersion: 2;
  rulesVersion: "3";
  gameId: string;
  version: number;
  players: [PlayerId, PlayerId];
  firstPlayerId: PlayerId;
  currentPlayerId: PlayerId;
  phase: GamePhase;
  turnNumber: number;
  boards: Record<PlayerId, Board>;
  pending: TurnPending | null;
  tazzaUsed: Record<PlayerId, boolean>;
  inventory: Record<PlayerId, ItemInventory>;
  itemUsedThisTurn: boolean;
  held: Record<PlayerId, boolean>;
  result: GameResult | null;
};
```

`createdBy`와 현재 보드의 소유자를 구분한다. 내가 만든 보너스 실드를 상대 보드에 놓으면 `createdBy`는 나지만 점수는 상대에게 속한다.

다음 값은 `GameState`에 저장하지 않거나 파생 값으로만 제공한다.

- 라인 점수와 총점: `boards`에서 계산
- `connected`, 소켓 ID, 마지막 heartbeat: presence 저장소에서 관리
- 세션 토큰: 인증 저장소에서 관리
- 전체 이벤트 로그: 게임 상태 안의 배열이 아니라 별도 append-only 기록으로 관리
- 턴 타이머의 화면용 남은 초: 서버의 `deadlineAt`에서 계산

## 8. 규칙 상태 머신

주사위 굴림과 다음 플레이어 선택은 서버의 내부 전이다. 클라이언트가 `ROLL`이나 `NEXT_TURN`을 요청하지 않는다.

```text
START_GAME
  -> CHOOSE_FIRST_PLAYER
  -> ROLL_TURN_DIE
  -> TURN_ACTION
       | PLACE_OWN --------------------------+
       | ALKKAGI -> ROLL_BONUS -> BONUS_PLACEMENT
       | USE_TAZZA -> TAZZA_CHOICE -> TURN_ACTION
       | USE_SWAP_ITEM ----------------------> TURN_ACTION
       | USE_REROLL_ITEM --------------------> TURN_ACTION
       | HOLD -------------------------------+
       | SURRENDER -> FINISHED                |
                                               v
                                     CHECK_BOARD_COMPLETE
                                        | 한쪽 15개 -> FINISHED
                                        | 미완성
                                        v
                                      ADVANCE_OR_FINISH
                                        | 다음 플레이어 존재
                                        v
                                     ROLL_TURN_DIE
                                        | 없음
                                        v
                                      FINISHED

BONUS_PLACEMENT
  -> PLACE_BONUS_SHIELD
  -> CHECK_BOARD_COMPLETE
  -> ADVANCE_OR_FINISH 또는 FINISHED
```

### 다음 플레이어 선택

```ts
function isEligible(state: GameState, playerId: PlayerId): boolean {
  return !state.held[playerId] && countDice(state.boards[playerId]) < 15;
}
```

턴을 끝내는 배치 뒤 어느 한쪽이라도 15개를 채웠는지 먼저 검사한다. 완성된 보드가 있으면 다음 주사위를 굴리지 않고 즉시 결과를 계산한다. 미완성일 때만 상대를 먼저 검사하고, 상대가 불가능하면 현재 플레이어를 검사한다. 둘 다 불가능하면 결과를 계산한다.

## 9. 순수 규칙 엔진 계약

규칙 엔진의 핵심 API는 다음 모양을 권장한다.

```ts
type EngineContext = {
  now: string;
  rng: DiceRng;
  idGenerator: IdGenerator;
};

type Transition = {
  state: GameState;
  events: GameEvent[];
};

function applyCommand(
  state: GameState,
  actorPlayerId: PlayerId,
  command: GameCommand,
  context: EngineContext,
): Transition;
```

원칙은 다음과 같다.

- 입력 상태를 직접 변경하지 않고 새 상태를 반환한다.
- 현재 시각과 난수는 `context`로 주입한다.
- 잘못된 명령은 안정적인 규칙 오류를 반환하고 상태를 바꾸지 않는다.
- 한 명령 안의 알까기 제거와 보너스 굴림은 하나의 전이로 만든다.
- 전이 후 불변 조건 검사기를 개발·테스트 환경에서 항상 실행한다.
- 점수 함수, 합법 행동 selector, 결과 판정은 UI에서도 복사하지 않고 공유 가능한 순수 모듈로 둔다. 단 최종 검증은 서버가 한다.

## 10. 명령 처리와 동시성

서버는 한 게임 명령을 다음 순서로 처리한다.

1. WebSocket 세션을 좌석과 연결한다.
2. 메시지 크기와 JSON 스키마를 검증한다.
3. `gameId` 기준 직렬화 락 또는 DB 트랜잭션을 연다.
4. `(gameId, playerId, actionId)`로 이미 처리한 명령인지 확인한다.
5. 중복이면 저장해 둔 동일 승인/거절 결과를 다시 반환한다.
6. `expectedVersion`과 현재 `version`을 비교한다.
7. 규칙 엔진으로 명령을 적용한다.
8. 새 상태의 불변 조건을 검사한다.
9. 상태, 이벤트, action 결과를 하나의 트랜잭션으로 저장한다.
10. 커밋 후 두 플레이어에게 이벤트와 스냅샷을 방송한다.

`version`은 승인된 사용자 명령 또는 시스템 명령 하나마다 한 번 증가한다. 명령 내부에서 여러 이벤트가 생겨도 버전은 한 번만 증가한다.

두 탭이 동시에 같은 버전을 보냈을 때 먼저 커밋한 하나만 성공해야 한다. 나머지는 `STALE_VERSION`과 최신 스냅샷을 받고 다시 그린다.

## 11. 난수

서버 RNG 인터페이스를 세 동작으로 분리한다.

```ts
interface DiceRng {
  chooseFirstPlayer(players: [PlayerId, PlayerId]): PlayerId;
  rollD6(): DieFace;
  rollDifferentFace(excluded: DieFace): DieFace;
}
```

- 운영 환경은 암호학적으로 안전한 난수 생성기를 사용한다.
- 범위 변환에는 modulo bias가 없는 표준 `randomInt` 계열 API를 사용한다.
- `rollDifferentFace`는 제외한 눈 이외의 5개를 정확히 같은 확률로 반환한다.
- 테스트에서는 미리 정한 값을 순서대로 반환하는 RNG를 주입한다.
- 클라이언트가 난수, seed, 주사위 결과를 제안하지 않는다.
- 이벤트 로그에는 확정된 결과와 원인이 된 명령을 남긴다.

경쟁성을 높여야 할 때는 경기 전 seed commitment, 경기 후 seed 공개 같은 검증 방식을 별도 설계할 수 있다. MVP에는 CSPRNG와 감사 로그면 충분하다.

## 12. 플레이어별 뷰

내부 상태를 그대로 직렬화하지 않고 수신자별 view model을 만든다.

- 세션 토큰, 토큰 해시, 내부 락, 소켓 ID는 어떤 게임 스냅샷에도 포함하지 않는다.
- 타짜 후보를 고르는 동안 원래 눈과 후보 눈은 현재 플레이어에게만 보낸다.
- 상대에게는 `상대가 타짜 선택 중`이라는 단계만 보내고, 선택이 끝난 눈만 공개한다.
- 서버 내부 오류와 스택 트레이스를 클라이언트에 보내지 않는다.
- 계산된 합법 행동 목록을 현재 플레이어 뷰에 포함해 UI 하이라이트에 사용할 수 있다.

예시 합법 행동 뷰는 다음과 같다.

```json
{
  "canUseTazza": true,
  "canUseSwapItem": true,
  "canUseRerollItem": true,
  "ownPlacementLanes": [0, 2],
  "alkkagiLanes": [1],
  "swapItemLanes": [0],
  "rerollItemTargets": [
    { "boardOwnerPlayerId": "player-a", "lane": 0, "dieId": "die-7" },
    { "boardOwnerPlayerId": "player-b", "lane": 2, "dieId": "die-11" }
  ],
  "bonusTargets": []
}
```

이 목록은 UX 편의를 위한 서버 계산값이며, 실제 명령 처리 때 같은 조건을 다시 검증한다.

## 13. 재접속과 타이머

### 재접속

1. 소켓이 끊기면 presence를 `DISCONNECTED`로 바꾸고 상대에게 알린다.
2. 끊긴 플레이어의 입력을 기다리는 phase라면 현재 행동 deadline의 남은 시간을 저장하고 일시 정지한다.
3. 상대의 입력 phase라면 그 입력은 계속 진행하되, 다음 턴이 끊긴 플레이어에게 넘어가는 시점에 진행을 멈춘다.
4. 모바일 브라우저가 잠깐 백그라운드로 간 경우를 위해 최대 90초의 연결 복구 유예를 둔다.
5. 같은 좌석 세션으로 돌아오면 새 소켓을 기존 좌석에 연결하고, 저장한 행동 시간을 새 서버 deadline으로 복원한다.
6. 서버가 최신 방 스냅샷과 게임 스냅샷을 다시 보낸다.
7. 클라이언트는 로컬 보드를 폐기하고 서버 스냅샷으로 복구한다.
8. 유예 시간이 끝나면 Timer 서비스가 `SYSTEM_SURRENDER`를 발행하고 `DISCONNECT_FORFEIT`으로 종료한다.

재연결은 닉네임이나 방 코드만으로 좌석을 되찾지 않는다. 같은 계정이 없는 MVP에서는 세션 토큰이 유일한 좌석 자격이다.

### 행동 시간 제한의 초기 정책

시간 값과 자동 행동은 규칙 엔진에 하드코딩하지 않고 방 정책으로 주입한다. 플레이테스트 전 기본값은 다음과 같이 시작한다.

| 상황 | 기본 시간 | 만료 시 시스템 행동 |
| --- | ---: | --- |
| `TURN_ACTION` | 60초 | 현재 주사위를 버리고 `SYSTEM_HOLD` |
| `TAZZA_CHOICE` | 60초 안의 남은 시간 | 후보를 모두 버리고 `SYSTEM_HOLD` |
| `BONUS_PLACEMENT` | 30초 | 방금 공격한 상대 라인의 첫 빈칸에 자동 배치 |
| 연결 끊김 | 최대 90초 | `SYSTEM_SURRENDER` |

알까기 대상 라인은 제거 직후 반드시 빈칸이 있으므로 보너스 실드 자동 배치의 유효한 fallback이 된다. 모든 deadline은 서버 시각으로 판정하고 클라이언트 카운트다운은 표시일 뿐이다.

## 14. 저장 전략

### 개발과 운영

- 로컬 규칙 개발과 테스트는 메모리 저장소로 시작할 수 있다.
- 공개 배포에서 재접속과 서버 재시작 복구를 약속하려면 경기 상태를 영속 저장한다.
- 상태 스냅샷과 action 멱등성 레코드를 같은 트랜잭션으로 갱신할 수 있는 저장소가 필요하다.

### 논리 레코드

| 레코드 | 핵심 데이터 |
| --- | --- |
| `rooms` | `roomId`, `roomCode`, 상태, `roomVersion`, 현재 `gameId`, 만료 시각 |
| `room_seats` | `roomId`, `playerId`, 닉네임, 세션 토큰 해시, 준비 상태 |
| `games` | `gameId`, `roomId`, `version`, 직렬화된 `GameState`, 종료 시각 |
| `game_actions` | `gameId`, `playerId`, `actionId`, 요청 해시, 결과 버전, 응답 |
| `game_events` | `gameId`, 순번, 버전, event type, payload, 발생 시각 |

전체 이벤트 소싱을 도입할 필요는 없다. 최신 스냅샷을 복구의 기준으로 삼고, 이벤트는 감사·분석·애니메이션 추적용 append-only 기록으로 둔다.

### 수평 확장 시점

초기에는 한 서버 인스턴스가 모든 활성 방을 처리하는 편이 단순하다. 인스턴스를 여러 개로 늘릴 때는 아래 중 하나를 먼저 해결해야 한다.

- `gameId` 기준 sticky routing과 공유 영속 저장소
- DB compare-and-swap/row lock을 이용한 단일 writer 보장
- 다른 인스턴스의 소켓으로 이벤트를 보내기 위한 Redis Pub/Sub 같은 fan-out
- Timer 작업의 중복 실행을 막는 lease

트래픽 근거 없이 이 구성을 미리 분리하지 않는다.

## 15. 오류 계약

클라이언트가 문구가 아니라 안정적인 code로 분기할 수 있게 한다.

| code | 의미 | 클라이언트 처리 |
| --- | --- | --- |
| `NOT_AUTHENTICATED` | 좌석 세션 없음/만료 | 참가 화면으로 이동 |
| `ROOM_NOT_FOUND` | 코드 없음 또는 만료 | 코드 재입력 |
| `ROOM_FULL` | 두 좌석 사용 중 | 안내 후 참가 중단 |
| `NOT_YOUR_TURN` | 현재 플레이어가 아님 | 최신 스냅샷 반영 |
| `INVALID_PHASE` | 현재 단계에서 금지된 명령 | 최신 단계 표시 |
| `INVALID_LANE` | `0..2`가 아님 | 입력 버그 기록 |
| `LANE_FULL` | 대상 라인에 빈칸 없음 | 하이라이트 갱신 |
| `ALKKAGI_NOT_AVAILABLE` | 제거 대상 또는 내 빈칸 없음 | 공격 하이라이트 갱신 |
| `TAZZA_ALREADY_USED` | 사용권 소진 | 버튼 비활성화 |
| `ITEM_ALREADY_USED_THIS_TURN` | 현재 턴에 아이템 사용 완료 | 인벤토리 대상 선택 종료, 다음 턴까지 비활성화 |
| `ITEM_NOT_AVAILABLE` | 해당 아이템 수량 없음 | 수량 갱신 후 아이템 비활성화 |
| `INVALID_ITEM_TARGET` | 대상 주사위가 지정 보드·라인에 없거나 교환 라인이 다름 | 최신 스냅샷으로 타깃 강조 갱신 |
| `STALE_VERSION` | 이전 상태를 기준으로 보냄 | 응답 스냅샷으로 교체 |
| `DUPLICATE_ACTION_MISMATCH` | 같은 `actionId`에 다른 payload | 요청 중단, 진단 기록 |
| `GAME_FINISHED` | 종료 뒤 게임 명령 | 결과 화면 유지 |
| `RATE_LIMITED` | 요청 빈도 초과 | 재시도 시각 안내 |

거절된 명령은 게임 버전을 증가시키지 않는다.

## 16. 보안과 오용 방지

- 모든 HTTP·WebSocket 입력을 런타임 스키마로 검증한다.
- 메시지 크기, 닉네임 길이, 방 생성 수, 참가 재시도 수를 제한한다.
- WebSocket 연결에서 `Origin`과 세션을 검증한다.
- 방 참가·생성 HTTP 요청에는 CSRF 방어를 적용한다.
- 세션 토큰과 쿠키 값을 로그, 분석 도구, 오류 추적 payload에 남기지 않는다.
- 닉네임은 텍스트로 렌더링하고 제어 문자와 bidi 오용을 제한한다.
- 주사위와 선공은 CSPRNG로 정한다.
- 하나의 좌석에 새 소켓이 인증되면 이전 소켓을 교체하거나 read-only로 만들고, 동시에 두 writer를 허용하지 않는다.
- 클라이언트가 보낸 점수, `playerId`, 주사위 종류, 현재 턴 값을 신뢰하지 않는다.

## 17. 테스트 전략

### 규칙 단위 테스트

- [게임 규칙 명세의 구현 수용 테스트](./game-rules.md#13-구현-수용-테스트)를 테이블 기반으로 구현한다.
- 스크립트 RNG로 선공, 일반 눈, 타짜 후보, 보너스 눈을 고정한다.
- 점수, 합법 행동 selector, 다음 플레이어, 승패 판정을 각각 독립 테스트한다.

### 속성 테스트

임의의 합법 명령 시퀀스 뒤에 아래 속성을 검사한다.

- 라인 길이는 절대 5를 넘지 않는다.
- 눈은 항상 `1..6`이다.
- 실드는 제거 이벤트의 대상이 되지 않는다.
- `FINISHED` 뒤 상태는 게임 명령으로 바뀌지 않는다.
- 저장된 점수와 보드 재계산 점수가 다를 수 없다.
- 활성 상태에는 15개를 채운 보드가 남을 수 없고, 15번째 배치 전이는 반드시 `FINISHED`로 끝난다.
- 같은 상태·명령·스크립트 RNG는 같은 전이 결과를 만든다.
- 아이템 명령 뒤 pending 턴 주사위와 현재 플레이어는 유지되고, 같은 턴의 두 번째 아이템은 거절된다.

### 애플리케이션 통합 테스트

- 같은 `actionId` 재전송이 한 번만 적용된다.
- 같은 버전의 동시 명령 중 하나만 성공한다.
- 잘못된 `expectedVersion`은 상태를 바꾸지 않는다.
- 트랜잭션 저장 실패 시 이벤트가 방송되지 않는다.
- 재대결은 새 `gameId`와 초기 상태를 만든다.

### 두 클라이언트 E2E

- 생성 -> 코드 참가 -> 준비 -> 시작 -> 정상 종료
- 알까기 이벤트 순서와 양쪽 스냅샷 일치
- 한쪽 연결 끊김 -> 재접속 -> 같은 좌석과 상태 복원
- 유예 만료 -> 연결 끊김 패배
- 모바일 백그라운드 전환 뒤 중복 명령 없이 복구

## 18. 관측 가능성

구조화 로그에는 `roomId`, `gameId`, `playerId`, `actionId`, 이전/새 버전, command type, 거절 code를 남긴다. 세션 자격은 남기지 않는다.

초기 지표는 다음이면 충분하다.

- 활성 방/경기 수
- 방 생성 대비 상대 참가율
- 명령 승인/거절 수와 code 분포
- `STALE_VERSION`과 중복 action 비율
- WebSocket 재접속 성공률
- 정상 종료, 홀드 종료, 항복, 연결 끊김 패배 비율
- 평균 경기 시간과 턴 수
- 선공/후공 승률

규칙 변경 시 `rulesVersion`을 경기 기록에 남겨 서로 다른 버전의 통계를 섞지 않는다.

## 19. 권장 구현 순서

1. 순수 점수 함수와 불변 조건 검사기
2. 스크립트 RNG를 사용하는 전체 규칙 상태 머신
3. 로컬에서 두 명령 주체를 번갈아 실행하는 시뮬레이터
4. 방 생성·참가와 좌석 세션
5. 트랜잭션 command handler, 버전, 멱등성
6. WebSocket 이벤트와 전체 스냅샷
7. 모바일 게임 UI
8. 재접속, presence, 서버 타이머
9. 재대결과 운영 지표

규칙 엔진을 네트워크보다 먼저 완성하면 UI와 WebSocket 문제를 게임 판정 문제와 분리해 디버깅할 수 있다.

## 20. 구현 전 남은 제품 결정

다음은 규칙을 바꾸지 않으면서 구현 스택이나 운영 정책에 따라 정할 수 있다.

- 프론트엔드·서버 언어와 프레임워크
- 운영 저장소와 배포 환경
- 방 대기/완료 데이터의 보존 시간
- 60초 턴, 90초 재접속 기본값의 플레이테스트 조정
- 독자적인 서비스명과 시각 자산

이 항목을 정하더라도 서버 권위, 세션과 방 코드 분리, 버전·멱등성, 순수 규칙 엔진 경계는 유지한다.
