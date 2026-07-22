import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  Board,
  Die,
  GameCommand,
  GameEvent,
  LaneIndex,
  PlayerId,
} from "../game";
import type { RoomSnapshot } from "../protocol";
import {
  DieView,
  LaneCard,
  Sheet,
  ShieldIcon,
  Spinner,
} from "./components";
import { useRoomSession } from "./use-room-session";
import type { ConnectionState, PendingAction } from "./use-room-session";

type Overlay = "RULES" | "HOLD" | "SURRENDER" | null;

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "").slice(0, 6);
}

function HomeScreen({
  requesting,
  onCreate,
  onJoin,
  onRules,
}: {
  requesting: boolean;
  onCreate: (nickname: string) => void;
  onJoin: (code: string, nickname: string) => void;
  onRules: () => void;
}) {
  const [mode, setMode] = useState<"HOME" | "CREATE" | "JOIN">("HOME");
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!nickname.trim()) return;
    if (mode === "CREATE") onCreate(nickname);
    if (mode === "JOIN" && code.length === 6) onJoin(code, nickname);
  };

  return (
    <main className="home shell">
      <header className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span>1</span><span>6</span>
        </div>
        <p className="eyebrow">HEAD-TO-HEAD DICE TACTICS</p>
        <h1>ROLL<span>//</span>DUEL</h1>
        <p className="home__lead">
          같은 눈을 모아 점수를 키우고,<br />알까기로 상대 라인을 무너뜨리세요.
        </p>
      </header>

      {mode === "HOME" ? (
        <div className="home__actions">
          <button className="button button--primary" onClick={() => setMode("CREATE")}>
            새 방 만들기 <span>→</span>
          </button>
          <button className="button button--outline" onClick={() => setMode("JOIN")}>
            방 코드로 참가
          </button>
          <button className="text-button" onClick={onRules}>90초 규칙 보기</button>
        </div>
      ) : (
        <form className="entry-card" onSubmit={submit}>
          <button type="button" className="back-button" onClick={() => setMode("HOME")}>
            ← 돌아가기
          </button>
          <p className="eyebrow">{mode === "CREATE" ? "CREATE A ROOM" : "JOIN A ROOM"}</p>
          <h2>{mode === "CREATE" ? "플레이어 이름을 정하세요" : "초대받은 방에 참가하세요"}</h2>
          {mode === "JOIN" && (
            <label>
              <span>방 코드</span>
              <input
                className="code-input"
                value={code}
                onChange={(event) => setCode(normalizeCode(event.target.value))}
                placeholder="ABC234"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={6}
                autoFocus
              />
            </label>
          )}
          <label>
            <span>닉네임</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="1~16자"
              maxLength={16}
              autoFocus={mode === "CREATE"}
            />
          </label>
          <button
            className="button button--primary"
            disabled={requesting || !nickname.trim() || (mode === "JOIN" && code.length !== 6)}
          >
            {requesting ? "연결 중…" : mode === "CREATE" ? "방 만들기" : "참가하기"}
          </button>
        </form>
      )}
      <footer className="home__footer">NO ACCOUNT · TWO PLAYERS · ONE ROOM CODE</footer>
    </main>
  );
}

function ConnectionPill({ connection }: { connection: ConnectionState }) {
  const label =
    connection === "OPEN"
      ? "연결됨"
      : connection === "DISCONNECTED"
        ? "연결 중단"
      : connection === "RECONNECTING"
        ? "재연결 중"
        : "연결 중";
  return <span className={`connection-pill connection-pill--${connection.toLowerCase()}`}>{label}</span>;
}

function LobbyScreen({
  room,
  connection,
  pending,
  onReady,
}: {
  room: RoomSnapshot;
  connection: ConnectionState;
  pending: PendingAction | null;
  onReady: (ready: boolean) => void;
}) {
  const [copyState, setCopyState] = useState("복사");
  const self = room.seats.find((seat) => seat.playerId === room.selfPlayerId);
  const shareText = `ROLL//DUEL 방 코드: ${room.roomCode}`;
  const copy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(room.roomCode);
      } else {
        const field = document.createElement("textarea");
        field.value = room.roomCode;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("Copy was rejected.");
      }
      setCopyState("복사됨");
    } catch {
      setCopyState("복사 실패");
    }
    window.setTimeout(() => setCopyState("복사"), 1600);
  };
  const share = async () => {
    if (!navigator.share) {
      await copy();
      return;
    }
    try {
      await navigator.share({ title: "ROLL//DUEL 초대", text: shareText });
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "AbortError") {
        await copy();
      }
    }
  };

  return (
    <main className="lobby shell">
      <header className="topbar">
        <span className="wordmark">ROLL<span>//</span>DUEL</span>
        <ConnectionPill connection={connection} />
      </header>
      <section className="room-code-card">
        <p className="eyebrow">PRIVATE MATCH CODE</p>
        <h1>{room.roomCode}</h1>
        <p>이 코드를 상대에게 보내 같은 방으로 초대하세요.</p>
        <div className="inline-actions">
          <button className="button button--small button--outline" onClick={copy}>{copyState}</button>
          <button className="button button--small button--dark" onClick={share}>공유</button>
        </div>
      </section>
      <section className="players-card">
        <header>
          <p className="eyebrow">PLAYERS</p>
          <span>{room.seats.length}/2</span>
        </header>
        {[0, 1].map((index) => {
          const seat = room.seats[index];
          return (
            <div className={`player-seat ${seat ? "player-seat--filled" : ""}`} key={index}>
              <span className="player-seat__number">0{index + 1}</span>
              <span className="player-seat__avatar">{seat?.nickname.slice(0, 1) ?? "?"}</span>
              <span className="player-seat__name">
                {seat?.nickname ?? "상대를 기다리는 중"}
                {seat?.playerId === room.selfPlayerId && <small>나</small>}
              </span>
              <span className={`ready-badge ${seat?.ready ? "ready-badge--on" : ""}`}>
                {seat ? (seat.ready ? "READY" : seat.connected ? "대기" : "접속 중") : "EMPTY"}
              </span>
            </div>
          );
        })}
      </section>
      <div className="lobby__note">
        <span aria-hidden="true">✦</span>
        두 플레이어가 모두 준비하면 선공과 첫 주사위는 서버가 정합니다.
      </div>
      <footer className="lobby-dock">
        <p>{room.seats.length < 2 ? "상대가 들어오면 함께 준비할 수 있어요." : self?.ready ? "상대의 준비를 기다리고 있어요." : "준비되었다면 경기를 시작하세요."}</p>
        <button
          className={`button ${self?.ready ? "button--outline" : "button--primary"}`}
          disabled={connection !== "OPEN" || Boolean(pending)}
          onClick={() => onReady(!self?.ready)}
        >
          {pending?.label ?? (self?.ready ? "준비 취소" : "준비 완료")}
        </button>
      </footer>
    </main>
  );
}

function eventText(event: GameEvent, selfPlayerId: PlayerId): string {
  const who = (playerId: PlayerId) => playerId === selfPlayerId ? "내가" : "상대가";
  switch (event.type) {
    case "GAME_STARTED": return "새 경기가 시작됐습니다.";
    case "TURN_STARTED": return `${who(event.playerId)} 주사위를 굴렸습니다.`;
    case "DIE_PLACED": return `${who(event.playerId)} ${event.lane + 1}번 라인에 놓았습니다.`;
    case "DICE_REMOVED": return `${who(event.byPlayerId)} 알까기로 ${event.dice.length}개를 제거했습니다.`;
    case "TAZZA_USED": return `${who(event.playerId)} 타짜를 사용했습니다.`;
    case "PLAYER_HELD": return `${who(event.playerId)} 홀드했습니다.`;
    case "PLAYER_SURRENDERED": return `${who(event.playerId)} 항복했습니다.`;
    case "GAME_FINISHED": return "경기가 끝났습니다.";
    default: return "게임 상태가 바뀌었습니다.";
  }
}

function RulesSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="90초 규칙" onClose={onClose}>
      <ol className="rules-list">
        <li><strong>같은 눈을 모으세요.</strong><span>각 라인은 같은 눈이 겹칠수록 보너스가 커집니다. 5+5는 15점, 5+5+5는 25점.</span></li>
        <li><strong>라인을 선택해 놓으세요.</strong><span>내 3개 라인 중 빈 라인에 현재 주사위를 배치합니다.</span></li>
        <li><strong>같은 눈은 알까기.</strong><span>상대 같은 라인의 동일한 일반 주사위를 전부 지우고 보너스 실드를 받습니다.</span></li>
        <li><strong>타짜는 경기당 한 번.</strong><span>현재 눈과 새 눈 중 하나를 고를 수 있습니다.</span></li>
        <li><strong>2개 라인을 이기면 승리.</strong><span>라인 승수가 같으면 전체 점수로 판정합니다.</span></li>
      </ol>
      <button className="button button--primary" onClick={onClose}>알겠어요</button>
    </Sheet>
  );
}

function pendingDie(state: RoomSnapshot["game"] extends infer _T ? NonNullable<RoomSnapshot["game"]>["state"] : never): Die | null {
  if (state.pending?.source === "TURN") return state.pending.original;
  if (state.pending?.source === "BONUS") return state.pending.die;
  return null;
}

function GameScreen({
  room,
  connection,
  pending,
  onCommand,
  onRules,
}: {
  room: RoomSnapshot;
  connection: ConnectionState;
  pending: PendingAction | null;
  onCommand: (command: GameCommand, label: string) => boolean;
  onRules: () => void;
}) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const game = room.game;
  if (!game) return <Spinner label="경기를 준비하는 중" />;
  const state = game.state;
  const selfId = room.selfPlayerId;
  const opponentId = state.players.find((playerId) => playerId !== selfId);
  if (!opponentId) return <Spinner label="상대 정보를 확인하는 중" />;
  const self = room.seats.find((seat) => seat.playerId === selfId);
  const opponent = room.seats.find((seat) => seat.playerId === opponentId);
  const ownBoard = state.boards[selfId] as Board | undefined;
  const opponentBoard = state.boards[opponentId] as Board | undefined;
  if (!ownBoard || !opponentBoard) return <Spinner label="보드를 불러오는 중" />;
  const ownScores = game.scores[selfId] ?? [0, 0, 0];
  const opponentScores = game.scores[opponentId] ?? [0, 0, 0];
  const ownTotal = ownScores.reduce((sum, value) => sum + value, 0);
  const opponentTotal = opponentScores.reduce((sum, value) => sum + value, 0);
  const isMyTurn = state.currentPlayerId === selfId;
  const controlsLocked = connection !== "OPEN" || Boolean(pending);
  const currentDie = pendingDie(state);
  const isBonus = state.phase === "BONUS_PLACEMENT";

  const hasBonusTarget = (boardOwnerPlayerId: PlayerId, lane: LaneIndex) =>
    game.legalActions.bonusTargets.some(
      (target) => target.boardOwnerPlayerId === boardOwnerPlayerId && target.lane === lane,
    );

  const instruction = !isMyTurn
    ? state.phase === "TAZZA_CHOICE"
      ? "상대가 타짜 주사위를 고르는 중입니다."
      : "상대의 선택을 기다리는 중입니다."
    : state.phase === "TAZZA_CHOICE"
      ? "기존 눈과 새 눈 중 하나를 선택하세요."
      : state.phase === "BONUS_PLACEMENT"
        ? "실드를 놓을 보드와 라인을 선택하세요."
        : "놓거나 공격할 라인을 선택하세요.";

  return (
    <main className="game shell shell--game">
      <header className="game-header">
        <div>
          <p className="eyebrow">ROOM {room.roomCode}</p>
          <h1>{opponent?.nickname ?? "상대"} <span className={`presence-dot ${opponent?.connected ? "on" : ""}`} /></h1>
        </div>
        <div className="game-header__actions">
          <button className="icon-button" onClick={onRules} aria-label="규칙 보기">?</button>
          <button className="text-danger" onClick={() => setOverlay("SURRENDER")}>항복</button>
        </div>
      </header>

      <section className={`score-ribbon ${isMyTurn ? "score-ribbon--mine" : ""}`}>
        <div><span>{self?.nickname ?? "나"}</span><strong>{ownTotal}</strong></div>
        <p>{isMyTurn ? "내 차례" : "상대 차례"}<small>TURN {String(state.turnNumber).padStart(2, "0")}</small></p>
        <div><span>{opponent?.nickname ?? "상대"}</span><strong>{opponentTotal}</strong></div>
      </section>

      <section className="lanes-grid">
        {([0, 1, 2] as LaneIndex[]).map((lane) => {
          const canPlace = game.legalActions.ownPlacementLanes.includes(lane);
          const canAttack = game.legalActions.alkkagiLanes.includes(lane);
          const bonusOwn = hasBonusTarget(selfId, lane);
          const bonusOpponent = hasBonusTarget(opponentId, lane);
          return (
            <LaneCard
              key={lane}
              lane={lane}
              opponentDice={opponentBoard[lane]}
              ownDice={ownBoard[lane]}
              opponentScore={opponentScores[lane]}
              ownScore={ownScores[lane]}
              disabled={controlsLocked}
              opponentAction={canAttack ? {
                label: "알까기",
                tone: "attack",
                run: () => { onCommand({ type: "ALKKAGI", lane }, `${lane + 1}번 라인 공격 중`); },
              } : bonusOpponent ? {
                label: "상대에게 실드",
                tone: "bonus",
                run: () => { onCommand({ type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: opponentId, lane }, "보너스 실드 배치 중"); },
              } : undefined}
              ownAction={canPlace ? {
                label: "놓기",
                tone: "place",
                run: () => { onCommand({ type: "PLACE_OWN", lane }, `${lane + 1}번 라인 배치 중`); },
              } : bonusOwn ? {
                label: "내게 실드",
                tone: "bonus",
                run: () => { onCommand({ type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: selfId, lane }, "보너스 실드 배치 중"); },
              } : undefined}
            />
          );
        })}
      </section>

      <details className="event-log">
        <summary>최근 기록 <span>{room.recentEvents.length}</span></summary>
        <ol>
          {room.recentEvents.slice(-6).reverse().map((event, index) => (
            <li key={`${event.type}-${index}`}>{eventText(event, selfId)}</li>
          ))}
        </ol>
      </details>

      <footer className={`action-dock ${isBonus ? "action-dock--bonus" : ""}`}>
        <div className="action-dock__die">
          {currentDie ? <DieView die={currentDie} large /> : <span className="die-placeholder">—</span>}
          {isBonus && <span className="bonus-orbit"><ShieldIcon /></span>}
        </div>
        <div className="action-dock__copy">
          <p className="eyebrow">{isBonus ? "BONUS SHIELD" : isMyTurn ? "CURRENT ROLL" : "OPPONENT ROLL"}</p>
          <strong>{pending?.label ?? instruction}</strong>
          {isBonus && <small>상대 보드에 놓으면 상대 점수에 포함됩니다.</small>}
        </div>
        {isMyTurn && state.phase === "TURN_ACTION" && (
          <div className="action-dock__buttons">
            <button
              className="button button--tazza"
              disabled={!game.legalActions.canUseTazza || controlsLocked}
              onClick={() => onCommand({ type: "USE_TAZZA" }, "타짜 주사위 확인 중")}
            >
              타짜 <small>{state.tazzaUsed[selfId] ? "사용 완료" : "1회"}</small>
            </button>
            <button
              className="button button--ghost"
              disabled={!game.legalActions.canHold || controlsLocked}
              onClick={() => setOverlay("HOLD")}
            >홀드</button>
          </div>
        )}
      </footer>

      {isMyTurn && state.phase === "TAZZA_CHOICE" && state.pending?.source === "TURN" && state.pending.candidate && (
        <Sheet title="어느 주사위를 사용할까요?" description="한 번 선택하면 되돌릴 수 없습니다.">
          <div className="tazza-options">
            <button disabled={controlsLocked} onClick={() => onCommand({ type: "CHOOSE_TAZZA_DIE", choice: "ORIGINAL" }, "기존 주사위 선택 중")}>
              <span>기존</span><DieView die={state.pending.original} large />
            </button>
            <button disabled={controlsLocked} onClick={() => onCommand({ type: "CHOOSE_TAZZA_DIE", choice: "CANDIDATE" }, "새 주사위 선택 중")}>
              <span>새 주사위</span><DieView die={state.pending.candidate} large />
            </button>
          </div>
          <button className="button button--ghost" disabled={controlsLocked} onClick={() => setOverlay("HOLD")}>둘 다 포기하고 홀드</button>
        </Sheet>
      )}

      {overlay === "HOLD" && (
        <Sheet
          title="남은 턴을 모두 포기할까요?"
          description="현재 주사위를 버리고 이번 경기에서 더 이상 턴을 받지 않습니다. 지금까지의 점수로 승부는 계속됩니다."
          onClose={() => setOverlay(null)}
        >
          <button className="button button--hold" onClick={() => { if (onCommand({ type: "HOLD" }, "홀드 처리 중")) setOverlay(null); }}>홀드하기</button>
          <button className="button button--ghost" onClick={() => setOverlay(null)}>계속 플레이</button>
        </Sheet>
      )}
      {overlay === "SURRENDER" && (
        <Sheet
          title="경기를 포기할까요?"
          description="즉시 패배로 처리되며 되돌릴 수 없습니다."
          onClose={() => setOverlay(null)}
        >
          <button className="button button--danger" onClick={() => { if (onCommand({ type: "SURRENDER" }, "항복 처리 중")) setOverlay(null); }}>항복하기</button>
          <button className="button button--ghost" onClick={() => setOverlay(null)}>취소</button>
        </Sheet>
      )}

      {(connection === "CONNECTING" || connection === "RECONNECTING") && (
        <div className="reconnect-overlay"><Spinner label="게임에 다시 연결하는 중" /></div>
      )}
    </main>
  );
}

function ResultScreen({
  room,
  connection,
  pending,
  onRematch,
}: {
  room: RoomSnapshot;
  connection: ConnectionState;
  pending: PendingAction | null;
  onRematch: () => void;
}) {
  const game = room.game;
  const result = game?.state.result;
  if (!game || !result) return <Spinner label="결과를 집계하는 중" />;
  const selfId = room.selfPlayerId;
  const opponentId = game.state.players.find((id) => id !== selfId);
  if (!opponentId) return <Spinner />;
  const won = result.winnerPlayerId === selfId;
  const draw = result.winnerPlayerId === null;
  const selfRequested = room.rematchPlayerIds.includes(selfId);
  const opponentRequested = room.rematchPlayerIds.includes(opponentId);
  const selfName = room.seats.find((seat) => seat.playerId === selfId)?.nickname ?? "나";
  const opponentName = room.seats.find((seat) => seat.playerId === opponentId)?.nickname ?? "상대";

  return (
    <main className={`result shell ${won ? "result--won" : ""}`}>
      <header className="topbar">
        <span className="wordmark">ROLL<span>//</span>DUEL</span>
        <ConnectionPill connection={connection} />
      </header>
      <section className="result-hero">
        <p className="eyebrow">MATCH COMPLETE</p>
        <span className="result-hero__symbol">{draw ? "=" : won ? "✦" : "×"}</span>
        <h1>{draw ? "무승부" : won ? "승리했습니다" : "이번엔 패배"}</h1>
        <p>{result.reason === "SURRENDER" ? "항복으로 경기가 종료됐습니다." : "세 라인의 판정이 모두 끝났습니다."}</p>
      </section>
      <section className="result-score">
        <div><span>{selfName}</span><strong>{result.totalScores[selfId] ?? 0}</strong><small>{result.laneWins[selfId] ?? 0} LINES</small></div>
        <span className="result-score__versus">VS</span>
        <div><span>{opponentName}</span><strong>{result.totalScores[opponentId] ?? 0}</strong><small>{result.laneWins[opponentId] ?? 0} LINES</small></div>
      </section>
      <section className="result-lines">
        <header><span>라인</span><span>{selfName}</span><span>{opponentName}</span></header>
        {([0, 1, 2] as LaneIndex[]).map((lane) => (
          <div key={lane}>
            <span>0{lane + 1}</span>
            <strong className={(result.laneScores[selfId]?.[lane] ?? 0) > (result.laneScores[opponentId]?.[lane] ?? 0) ? "winner" : ""}>{result.laneScores[selfId]?.[lane] ?? 0}</strong>
            <strong className={(result.laneScores[opponentId]?.[lane] ?? 0) > (result.laneScores[selfId]?.[lane] ?? 0) ? "winner" : ""}>{result.laneScores[opponentId]?.[lane] ?? 0}</strong>
          </div>
        ))}
      </section>
      <footer className="result-actions">
        {selfRequested ? (
          <div className="rematch-wait"><span className="pulse-dot" />{opponentRequested ? "새 경기를 시작합니다…" : "상대의 재대결 선택을 기다리는 중"}</div>
        ) : (
          <button className="button button--primary" disabled={connection !== "OPEN" || Boolean(pending)} onClick={onRematch}>
            {pending?.label ?? "같은 방에서 재대결"}
          </button>
        )}
        <p>재대결하면 선공과 모든 보드가 새로 정해집니다.</p>
      </footer>
    </main>
  );
}

export default function App() {
  const session = useRoomSession();
  const [globalOverlay, setGlobalOverlay] = useState<Overlay>(null);
  const errorKey = useMemo(() => session.error, [session.error]);

  if (session.restoring) {
    return <main className="boot"><span className="wordmark">ROLL<span>//</span>DUEL</span><Spinner label="이전 게임을 확인하는 중" /></main>;
  }

  let screen;
  if (!session.room) {
    screen = (
      <HomeScreen
        requesting={session.requesting}
        onCreate={session.createRoom}
        onJoin={session.joinRoom}
        onRules={() => setGlobalOverlay("RULES")}
      />
    );
  } else if (session.room.status === "WAITING_FOR_OPPONENT" || session.room.status === "LOBBY") {
    screen = (
      <LobbyScreen
        room={session.room}
        connection={session.connection}
        pending={session.pending}
        onReady={session.setReady}
      />
    );
  } else if (session.room.status === "POST_GAME") {
    screen = (
      <ResultScreen
        room={session.room}
        connection={session.connection}
        pending={session.pending}
        onRematch={session.requestRematch}
      />
    );
  } else {
    screen = (
      <GameScreen
        room={session.room}
        connection={session.connection}
        pending={session.pending}
        onCommand={session.sendGameCommand}
        onRules={() => setGlobalOverlay("RULES")}
      />
    );
  }

  return (
    <>
      {screen}
      {errorKey && (
        <button className="error-toast" onClick={session.clearError} aria-label="오류 메시지 닫기">
          <span>!</span>{errorKey}<b>×</b>
        </button>
      )}
      {globalOverlay === "RULES" && <RulesSheet onClose={() => setGlobalOverlay(null)} />}
    </>
  );
}
