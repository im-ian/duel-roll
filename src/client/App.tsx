import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ITEM_TYPES } from "../game/constants";
import type {
  Board,
  Die,
  GameCommand,
  GameEvent,
  ItemInventory,
  ItemType,
  LaneIndex,
  PlayerId,
} from "../game";
import type { RoomSnapshot } from "../protocol";
import {
  DieView,
  LaneCard,
  RollingDieView,
  Sheet,
  ShieldIcon,
  Spinner,
} from "./components";
import { calculatePlacementHints } from "./placement-guide";
import { useRoomSession } from "./use-room-session";
import type { ConnectionState, PendingAction } from "./use-room-session";

type Overlay = "TUTORIAL" | "HOLD" | "SURRENDER" | "INVENTORY" | null;
type ItemMode =
  | {
      type: "SWAP";
      ownSelection?: { lane: LaneIndex; dieId: string };
    }
  | { type: "REROLL" }
  | { type: "DESTROY" }
  | null;

const GAME_END_TRANSITION_MS = 2_000;
const BEGINNER_GUIDE_STORAGE_KEY = "roll-duel:beginner-guide";
const DROP_ITEM_LABEL = "무작위 투하";
const ITEM_LABELS: Record<ItemType, string> = {
  SWAP: "주사위 교환",
  REROLL: "눈 변환",
  SHIELD: "실드 강화",
  DROP: DROP_ITEM_LABEL,
  DESTROY: "주사위 파괴",
  TURN_REROLL: "주사위 리롤",
  ODD: "홀수 주사위",
  EVEN: "짝수 주사위",
};
const EMPTY_INVENTORY: ItemInventory = {
  SWAP: 0,
  REROLL: 0,
  SHIELD: 0,
  DROP: 0,
  DESTROY: 0,
  TURN_REROLL: 0,
  ODD: 0,
  EVEN: 0,
};

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "").slice(0, 6);
}

function initialBeginnerGuidePreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(BEGINNER_GUIDE_STORAGE_KEY) !== "OFF";
  } catch {
    return true;
  }
}

function HomeScreen({
  requesting,
  onCreate,
  onJoin,
  onTutorial,
}: {
  requesting: boolean;
  onCreate: (nickname: string) => void;
  onJoin: (code: string, nickname: string) => void;
  onTutorial: () => void;
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
          <button className="text-button" onClick={onTutorial}>게임 튜토리얼</button>
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
    case "DICE_SWAPPED": return `${who(event.playerId)} ${event.lane + 1}번 라인의 주사위를 교환했습니다.`;
    case "DIE_REROLLED": return `${who(event.playerId)} ${event.boardOwnerPlayerId === selfPlayerId ? "내" : "상대"} 주사위를 ${event.previousDie.face}→${event.die.face}로 변환했습니다.`;
    case "DIE_SHIELDED": return `${who(event.playerId)} 현재 주사위를 실드로 강화했습니다.`;
    case "DICE_DROPPED": return `${who(event.playerId)} 양쪽 보드에 무작위 주사위를 떨어뜨렸습니다.`;
    case "DIE_DESTROYED": return `${who(event.playerId)} ${event.boardOwnerPlayerId === selfPlayerId ? "내" : "상대"} 주사위를 파괴했습니다.`;
    case "TURN_DIE_REROLLED": return `${who(event.playerId)} 현재 주사위를 ${event.previousDie.face}→${event.die.face}로 다시 굴렸습니다.`;
    case "TURN_DIE_PARITY_CHANGED": return `${who(event.playerId)} 현재 주사위를 ${event.parity === "ODD" ? "홀수" : "짝수"} ${event.previousDie.face}→${event.die.face}로 바꿨습니다.`;
    case "LINE_REWARD_CLAIMED": return `${who(event.playerId)} ${event.lane + 1}번 보상 라인을 완성해 ${ITEM_LABELS[event.itemType]} 아이템을 받았습니다.`;
    case "LINE_SCORE_REWARD_CLAIMED": return `${who(event.playerId)} ${event.lane + 1}번 보상 라인에서 ${event.threshold}점을 먼저 달성해 ${ITEM_LABELS[event.itemType]} 아이템을 받았습니다.`;
    case "PLAYER_HELD": return `${who(event.playerId)} 홀드했습니다.`;
    case "PLAYER_SURRENDERED": return `${who(event.playerId)} 항복했습니다.`;
    case "GAME_FINISHED": return "경기가 끝났습니다.";
    default: return "게임 상태가 바뀌었습니다.";
  }
}

const TUTORIAL_STEPS = [
  {
    eyebrow: "01 · OBJECTIVE",
    title: "세 라인 중 더 많이 이기세요",
    body: "각 라인의 점수를 상대와 비교합니다. 라인 승수가 같으면 세 라인의 총점이 높은 쪽이 승리합니다.",
  },
  {
    eyebrow: "02 · PLACE",
    title: "굴린 주사위를 한 라인에 놓으세요",
    body: "턴마다 내 세 라인 중 빈 곳을 고릅니다. 한 라인은 최대 5개이며, 어느 한쪽이 총 15칸을 채우는 즉시 점수를 판정합니다.",
  },
  {
    eyebrow: "03 · SCORE",
    title: "같은 눈을 모을수록 강해집니다",
    body: "같은 라인에서 같은 눈 두 개는 눈의 3배, 세 개는 5배가 됩니다. 높은 눈 하나보다 같은 눈 조합이 더 강할 수 있습니다.",
  },
  {
    eyebrow: "04 · ATTACK",
    title: "같은 눈으로 상대 라인을 깨세요",
    body: "현재 눈과 같은 상대의 일반 주사위를 같은 라인에서 모두 제거할 수 있습니다. 공격 뒤 받은 실드는 어느 쪽 빈 라인에도 놓을 수 있습니다.",
  },
  {
    eyebrow: "05 · REWARD LINE",
    title: "보상 라인의 두 목표를 선점하세요",
    body: "게임마다 무작위 라인 하나가 보상 라인이 됩니다. 주사위 3개와 라인 점수 15점을 각각 먼저 달성하면 목표마다 무작위 아이템 하나를 받습니다.",
  },
  {
    eyebrow: "06 · TACTICS",
    title: "특수 행동으로 흐름을 바꾸세요",
    body: "타짜는 경기당 한 번, 아이템은 내 턴마다 한 개까지 사용할 수 있습니다. 아이템을 쓴 뒤에도 현재 주사위를 놓거나 공격할 수 있습니다.",
  },
] as const;

function tutorialDie(face: Die["face"], id: string, kind: Die["kind"] = "NORMAL"): Die {
  return { id: `tutorial-${id}`, face, kind, createdBy: "tutorial" };
}

function TutorialVisual({ step }: { step: number }) {
  if (step === 0) {
    return (
      <div className="tutorial-visual tutorial-scoreboard" aria-label="세 라인 중 두 라인을 이기는 예시">
        {([
          [14, 9],
          [11, 16],
          [18, 12],
        ] as const).map(([mine, opponent], lane) => (
          <div className={mine > opponent ? "tutorial-scoreboard__won" : ""} key={lane}>
            <span>LINE 0{lane + 1}</span>
            <strong>{mine}</strong>
            <small>VS</small>
            <strong>{opponent}</strong>
            <em>{mine > opponent ? "승리" : "패배"}</em>
          </div>
        ))}
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="tutorial-visual tutorial-placement" aria-label="현재 주사위를 세 라인 중 하나에 놓는 예시">
        <div className="tutorial-placement__current">
          <span>현재 주사위</span>
          <DieView die={tutorialDie(4, "current")} />
        </div>
        <span className="tutorial-placement__arrow" aria-hidden="true">→</span>
        <div className="tutorial-placement__lanes">
          {[0, 1, 2].map((lane) => (
            <div key={lane} className={lane === 1 ? "is-selected" : ""}>
              <span>LINE 0{lane + 1}</span>
              {Array.from({ length: 5 }, (_, slot) => (
                <i key={slot} className={slot < lane + 1 ? "is-filled" : ""} />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="tutorial-visual tutorial-combo" aria-label="5 눈을 모아 점수가 증가하는 예시">
        <div>
          <span><DieView die={tutorialDie(5, "pair-a")} /><DieView die={tutorialDie(5, "pair-b")} /></span>
          <strong>15점</strong>
          <small>5 × 3</small>
        </div>
        <span aria-hidden="true">→</span>
        <div className="tutorial-combo__best">
          <span><DieView die={tutorialDie(5, "triple-a")} /><DieView die={tutorialDie(5, "triple-b")} /><DieView die={tutorialDie(5, "triple-c")} /></span>
          <strong>25점</strong>
          <small>5 × 5</small>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="tutorial-visual tutorial-attack" aria-label="같은 눈의 일반 주사위만 제거하고 실드는 남는 예시">
        <div>
          <span>내 공격</span>
          <DieView die={tutorialDie(4, "attack")} />
        </div>
        <span className="tutorial-attack__impact" aria-hidden="true">×</span>
        <div>
          <span>상대 라인</span>
          <span className="tutorial-attack__targets">
            <i><DieView die={tutorialDie(4, "target")} /><b>제거</b></i>
            <i><DieView die={tutorialDie(4, "shield", "SHIELD")} /><b>보호</b></i>
          </span>
        </div>
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="tutorial-visual tutorial-reward" aria-label="보상 라인에서 주사위 세 개 또는 15점을 먼저 달성하고 무작위 아이템을 받는 예시">
        <div className="tutorial-reward__lane">
          <span>REWARD LINE 02</span>
          <div>
            <DieView die={tutorialDie(5, "reward-a")} />
            <DieView die={tutorialDie(5, "reward-b")} />
          </div>
          <strong>15점</strong>
          <small>주사위 2/3 · 점수 15/15</small>
        </div>
        <span className="tutorial-reward__arrow" aria-hidden="true">→</span>
        <div className="tutorial-reward__item">
          <span aria-hidden="true">?</span>
          <strong>랜덤 아이템</strong>
          <small>목표마다 1개</small>
        </div>
      </div>
    );
  }

  return (
    <div className="tutorial-visual tutorial-tools" aria-label="타짜와 아이템 사용 규칙">
      <div><span>✦</span><strong>타짜</strong><small>경기당 1회</small></div>
      <div><span>◆</span><strong>아이템</strong><small>턴마다 1개</small></div>
      <div><span>→</span><strong>착수</strong><small>사용 후 계속</small></div>
    </div>
  );
}

function TutorialSheet({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = TUTORIAL_STEPS[step] ?? TUTORIAL_STEPS[0];
  const isLast = step === TUTORIAL_STEPS.length - 1;

  return (
    <Sheet title="게임 튜토리얼" description="여섯 장으로 핵심 규칙을 익혀보세요." onClose={onClose}>
      <section className="tutorial-step" aria-live="polite">
        <TutorialVisual step={step} />
        <div className="tutorial-step__copy">
          <p className="eyebrow">{current.eyebrow}</p>
          <h3>{current.title}</h3>
          <p>{current.body}</p>
        </div>
      </section>
      <nav className="tutorial-progress" aria-label="튜토리얼 단계">
        {TUTORIAL_STEPS.map((tutorialStep, index) => (
          <button
            key={tutorialStep.eyebrow}
            type="button"
            className={index === step ? "is-current" : ""}
            onClick={() => setStep(index)}
            aria-label={`${index + 1}단계: ${tutorialStep.title}`}
            aria-current={index === step ? "step" : undefined}
          />
        ))}
      </nav>
      <div className="tutorial-actions">
        <button
          type="button"
          className="button button--outline"
          onClick={() => step === 0 ? onClose() : setStep((currentStep) => currentStep - 1)}
        >
          {step === 0 ? "닫기" : "이전"}
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => isLast ? onClose() : setStep((currentStep) => currentStep + 1)}
        >
          {isLast ? "게임으로 돌아가기" : "다음"}
        </button>
      </div>
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
  onTutorial,
  ending = false,
}: {
  room: RoomSnapshot;
  connection: ConnectionState;
  pending: PendingAction | null;
  onCommand: (command: GameCommand, label: string) => boolean;
  onTutorial: () => void;
  ending?: boolean;
}) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [itemMode, setItemMode] = useState<ItemMode>(null);
  const [beginnerGuideEnabled, setBeginnerGuideEnabled] = useState(
    initialBeginnerGuidePreference,
  );
  const currentDie = room.game ? pendingDie(room.game.state) : null;
  const currentRollKey = currentDie && room.game
    ? `${room.game.state.gameId}:${currentDie.id}:${currentDie.face}`
    : null;
  const [revealedRollKey, setRevealedRollKey] = useState<string | null>(null);
  const gameVersion = room.game?.state.version;

  useEffect(() => {
    setItemMode(null);
    setOverlay((current) => current === "INVENTORY" ? null : current);
  }, [gameVersion]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        BEGINNER_GUIDE_STORAGE_KEY,
        beginnerGuideEnabled ? "ON" : "OFF",
      );
    } catch {
      // The guide still works when browser storage is unavailable.
    }
  }, [beginnerGuideEnabled]);

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
  const isRolling = Boolean(
    !ending && currentRollKey && currentRollKey !== revealedRollKey,
  );
  const controlsLocked = ending || isRolling || connection !== "OPEN" || Boolean(pending);
  const isBonus = state.phase === "BONUS_PLACEMENT";
  const inventory = state.inventory[selfId] ?? EMPTY_INVENTORY;
  const remainingItems = ITEM_TYPES.reduce(
    (total, itemType) => total + inventory[itemType],
    0,
  );
  const placementHints =
    beginnerGuideEnabled &&
    !controlsLocked &&
    !itemMode &&
    isMyTurn &&
    state.phase === "TURN_ACTION" &&
    currentDie
      ? calculatePlacementHints(
          ownBoard,
          currentDie,
          game.legalActions.ownPlacementLanes,
        )
      : [];
  const placementHintsByLane = new Map(
    placementHints.map((hint) => [hint.lane, hint]),
  );
  const lineReward = state.lineReward;
  const ownRewardProgress = Math.min(
    ownBoard[lineReward.lane].length,
    lineReward.threshold,
  );
  const opponentRewardProgress = Math.min(
    opponentBoard[lineReward.lane].length,
    lineReward.threshold,
  );
  const lineRewardClaimed = lineReward.claimedByPlayerId !== null;
  const lineRewardClaimedBySelf = lineReward.claimedByPlayerId === selfId;
  const lineRewardItemLabel = lineReward.itemType
    ? ITEM_LABELS[lineReward.itemType]
    : null;
  const lineScoreReward = state.lineScoreReward;
  const ownScoreRewardProgress = Math.min(
    ownScores[lineReward.lane],
    lineScoreReward.threshold,
  );
  const opponentScoreRewardProgress = Math.min(
    opponentScores[lineReward.lane],
    lineScoreReward.threshold,
  );
  const lineScoreRewardClaimed =
    lineScoreReward.claimedByPlayerId !== null;
  const lineScoreRewardClaimedBySelf =
    lineScoreReward.claimedByPlayerId === selfId;
  const lineScoreRewardItemLabel = lineScoreReward.itemType
    ? ITEM_LABELS[lineScoreReward.itemType]
    : null;
  const allLineRewardsClaimed =
    lineRewardClaimed && lineScoreRewardClaimed;
  const swapItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.SWAP <= 0
      ? "보유 수량 없음"
      : game.legalActions.canUseSwapItem
        ? "사용 가능"
        : "같은 라인에 교환 가능한 일반 주사위가 없습니다.";
  const rerollItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.REROLL <= 0
      ? "보유 수량 없음"
      : game.legalActions.canUseRerollItem
        ? "사용 가능"
        : "변환 가능한 일반 주사위가 없습니다.";
  const shieldItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.SHIELD <= 0
      ? "보유 수량 없음"
      : currentDie?.kind === "SHIELD"
        ? "현재 주사위가 이미 실드입니다."
        : game.legalActions.canUseShieldItem
          ? "사용 가능"
          : "일반 턴 주사위에만 사용할 수 있습니다.";
  const dropItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.DROP <= 0
      ? "보유 수량 없음"
      : game.legalActions.canUseDropItem
        ? "사용 가능"
        : "양쪽 보드에 빈칸이 필요합니다.";
  const destroyItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.DESTROY <= 0
      ? "보유 수량 없음"
      : game.legalActions.canUseDestroyItem
        ? "사용 가능"
        : "파괴할 수 있는 일반 주사위가 없습니다.";
  const turnRerollItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.TURN_REROLL <= 0
      ? "보유 수량 없음"
      : currentDie?.kind === "SHIELD"
        ? "실드 주사위에는 사용할 수 없습니다."
        : game.legalActions.canUseTurnRerollItem
          ? "사용 가능"
          : "일반 턴 주사위에만 사용할 수 있습니다.";
  const oddItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.ODD <= 0
      ? "보유 수량 없음"
      : currentDie?.kind === "SHIELD"
        ? "실드 주사위에는 사용할 수 없습니다."
        : game.legalActions.canUseOddItem
          ? "사용 가능"
          : "일반 턴 주사위에만 사용할 수 있습니다.";
  const evenItemStatus = state.itemUsedThisTurn
    ? "이번 턴 사용 완료"
    : inventory.EVEN <= 0
      ? "보유 수량 없음"
      : currentDie?.kind === "SHIELD"
        ? "실드 주사위에는 사용할 수 없습니다."
        : game.legalActions.canUseEvenItem
          ? "사용 가능"
          : "일반 턴 주사위에만 사용할 수 있습니다.";

  const hasBonusTarget = (boardOwnerPlayerId: PlayerId, lane: LaneIndex) =>
    game.legalActions.bonusTargets.some(
      (target) => target.boardOwnerPlayerId === boardOwnerPlayerId && target.lane === lane,
    );

  let instruction = "놓거나 공격할 라인을 선택하세요.";
  if (itemMode?.type === "REROLL") {
    instruction = "변환할 내 주사위 또는 상대 주사위를 선택하세요.";
  } else if (itemMode?.type === "DESTROY") {
    instruction = "파괴할 내 주사위 또는 상대 주사위를 선택하세요.";
  } else if (itemMode?.type === "SWAP") {
    instruction = itemMode.ownSelection
      ? "같은 라인의 상대 주사위를 선택하세요."
      : "먼저 교환할 내 주사위를 선택하세요.";
  } else if (!isMyTurn) {
    instruction = state.phase === "TAZZA_CHOICE"
      ? "상대가 타짜 주사위를 고르는 중입니다."
      : "상대의 선택을 기다리는 중입니다.";
  } else if (state.phase === "TAZZA_CHOICE") {
    instruction = "기존 눈과 새 눈 중 하나를 선택하세요.";
  } else if (state.phase === "BONUS_PLACEMENT") {
    instruction = "실드를 놓을 보드와 라인을 선택하세요.";
  }
  if (isRolling) {
    instruction = isMyTurn
      ? "주사위를 굴리는 중입니다."
      : "상대의 주사위를 굴리는 중입니다.";
  }
  if (ending) {
    instruction = "최종 결과를 집계하고 있습니다.";
  }

  return (
    <main className="game shell shell--game">
      <header className="game-header">
        <div>
          <p className="eyebrow">ROOM {room.roomCode}</p>
          <h1>{opponent?.nickname ?? "상대"} <span className={`presence-dot ${opponent?.connected ? "on" : ""}`} /></h1>
        </div>
        <div className="game-header__actions">
          <button className="icon-button" onClick={onTutorial} aria-label="게임 튜토리얼 열기">?</button>
          {!ending && <button className="text-danger" disabled={controlsLocked} onClick={() => setOverlay("SURRENDER")}>항복</button>}
        </div>
      </header>

      <section className={`score-ribbon ${isMyTurn ? "score-ribbon--mine" : ""}`}>
        <div><span>{self?.nickname ?? "나"}</span><strong>{ownTotal}</strong></div>
        <p>{ending ? "게임 종료" : isMyTurn ? "내 차례" : "상대 차례"}<small>TURN {String(state.turnNumber).padStart(2, "0")}</small></p>
        <div><span>{opponent?.nickname ?? "상대"}</span><strong>{opponentTotal}</strong></div>
      </section>

      <section className={`line-reward ${allLineRewardsClaimed ? "line-reward--claimed" : ""}`}>
        <span className="line-reward__lane" aria-hidden="true">
          <small>LINE</small>
          0{lineReward.lane + 1}
        </span>
        <div className="line-reward__objectives">
          <p className="eyebrow">목표마다 랜덤 아이템 1개</p>
          <div className={`line-reward__objective ${lineRewardClaimed ? "is-claimed" : ""}`}>
            <strong>
              {lineRewardClaimed
                ? `3개 · ${lineRewardClaimedBySelf ? "내가" : "상대가"} ${lineRewardItemLabel ?? "아이템"} 획득`
                : `주사위 ${lineReward.threshold}개 선점`}
            </strong>
            {lineRewardClaimed ? (
              <b className="line-reward__complete">완료</b>
            ) : (
              <span
                className="line-reward__progress"
                aria-label={`주사위 보상 진행도, 나 ${ownRewardProgress}/${lineReward.threshold}, 상대 ${opponentRewardProgress}/${lineReward.threshold}`}
              >
                나 <b>{ownRewardProgress}/{lineReward.threshold}</b>
                상대 <b>{opponentRewardProgress}/{lineReward.threshold}</b>
              </span>
            )}
          </div>
          <div className={`line-reward__objective ${lineScoreRewardClaimed ? "is-claimed" : ""}`}>
            <strong>
              {lineScoreRewardClaimed
                ? `15점 · ${lineScoreRewardClaimedBySelf ? "내가" : "상대가"} ${lineScoreRewardItemLabel ?? "아이템"} 획득`
                : `라인 ${lineScoreReward.threshold}점 선점`}
            </strong>
            {lineScoreRewardClaimed ? (
              <b className="line-reward__complete">완료</b>
            ) : (
              <span
                className="line-reward__progress"
                aria-label={`점수 보상 진행도, 나 ${ownScoreRewardProgress}/${lineScoreReward.threshold}, 상대 ${opponentScoreRewardProgress}/${lineScoreReward.threshold}`}
              >
                나 <b>{ownScoreRewardProgress}/{lineScoreReward.threshold}</b>
                상대 <b>{opponentScoreRewardProgress}/{lineScoreReward.threshold}</b>
              </span>
            )}
          </div>
        </div>
      </section>

      {!ending && (
        <section className={`beginner-guide ${placementHints.length > 0 ? "beginner-guide--active" : ""}`}>
          <span className="beginner-guide__icon" aria-hidden="true">◎</span>
          <div>
            <strong>초보 가이드</strong>
            <small>
              {!beginnerGuideEnabled
                ? "착수 점수 표시를 숨겼습니다."
                : placementHints.length > 0
                  ? "이번 착수의 추가 점수와 추천 라인을 표시합니다."
                  : "내 착수 차례가 되면 점수 기준 추천을 표시합니다."}
            </small>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={beginnerGuideEnabled}
            aria-label={`초보 가이드 ${beginnerGuideEnabled ? "끄기" : "켜기"}`}
            onClick={() => setBeginnerGuideEnabled((enabled) => !enabled)}
          >
            {beginnerGuideEnabled ? "ON" : "OFF"}
          </button>
        </section>
      )}

      <section className="lanes-grid">
        {([0, 1, 2] as LaneIndex[]).map((lane) => {
          const canPlace = game.legalActions.ownPlacementLanes.includes(lane);
          const canAttack = game.legalActions.alkkagiLanes.includes(lane);
          const bonusOwn = hasBonusTarget(selfId, lane);
          const bonusOpponent = hasBonusTarget(opponentId, lane);
          const ownSelectableDieIds = new Set<string>();
          const opponentSelectableDieIds = new Set<string>();
          const swapSelection = itemMode?.type === "SWAP"
            ? itemMode.ownSelection
            : undefined;

          if (
            !controlsLocked &&
            (itemMode?.type === "REROLL" || itemMode?.type === "DESTROY")
          ) {
            const targets = itemMode.type === "REROLL"
              ? game.legalActions.rerollItemTargets
              : game.legalActions.destroyItemTargets;
            for (const target of targets) {
              if (target.lane !== lane) continue;
              if (target.boardOwnerPlayerId === selfId) {
                ownSelectableDieIds.add(target.dieId);
              }
              if (target.boardOwnerPlayerId === opponentId) {
                opponentSelectableDieIds.add(target.dieId);
              }
            }
          }
          if (!controlsLocked && itemMode?.type === "SWAP") {
            if (game.legalActions.swapItemLanes.includes(lane)) {
              for (const die of ownBoard[lane]) {
                if (die.kind === "NORMAL") ownSelectableDieIds.add(die.id);
              }
            }
            if (swapSelection?.lane === lane) {
              for (const die of opponentBoard[lane]) {
                if (die.kind === "NORMAL") opponentSelectableDieIds.add(die.id);
              }
            }
          }

          let selectOwnDie: ((die: Die) => void) | undefined;
          let selectOpponentDie: ((die: Die) => void) | undefined;

          if (itemMode?.type === "SWAP") {
            selectOwnDie = (die) => setItemMode((current) => {
              if (current?.type !== "SWAP") return current;
              if (current.ownSelection?.dieId === die.id) {
                return { type: "SWAP" };
              }
              return { type: "SWAP", ownSelection: { lane, dieId: die.id } };
            });
            if (swapSelection?.lane === lane) {
              selectOpponentDie = (die) => {
                onCommand(
                  {
                    type: "USE_SWAP_ITEM",
                    lane,
                    ownDieId: swapSelection.dieId,
                    opponentDieId: die.id,
                  },
                  `${lane + 1}번 라인 주사위 교환 중`,
                );
              };
            }
          }
          if (itemMode?.type === "REROLL") {
            selectOwnDie = (die) => {
              onCommand(
                { type: "USE_REROLL_ITEM", boardOwnerPlayerId: selfId, lane, dieId: die.id },
                `${lane + 1}번 라인 내 주사위 변환 중`,
              );
            };
            selectOpponentDie = (die) => {
              onCommand(
                { type: "USE_REROLL_ITEM", boardOwnerPlayerId: opponentId, lane, dieId: die.id },
                `${lane + 1}번 라인 상대 주사위 변환 중`,
              );
            };
          }
          if (itemMode?.type === "DESTROY") {
            selectOwnDie = (die) => {
              onCommand(
                { type: "USE_DESTROY_ITEM", boardOwnerPlayerId: selfId, lane, dieId: die.id },
                `${lane + 1}번 라인 내 주사위 파괴 중`,
              );
            };
            selectOpponentDie = (die) => {
              onCommand(
                { type: "USE_DESTROY_ITEM", boardOwnerPlayerId: opponentId, lane, dieId: die.id },
                `${lane + 1}번 라인 상대 주사위 파괴 중`,
              );
            };
          }
          return (
            <LaneCard
              key={lane}
              lane={lane}
              opponentDice={opponentBoard[lane]}
              ownDice={ownBoard[lane]}
              opponentScore={opponentScores[lane]}
              ownScore={ownScores[lane]}
              placementHint={placementHintsByLane.get(lane)}
              isRewardLane={lineReward.lane === lane}
              rewardClaimed={allLineRewardsClaimed}
              disabled={controlsLocked}
              opponentSelectableDieIds={opponentSelectableDieIds}
              ownSelectableDieIds={ownSelectableDieIds}
              selectedDieId={itemMode?.type === "SWAP" ? itemMode.ownSelection?.dieId : undefined}
              onOpponentDieClick={selectOpponentDie}
              onOwnDieClick={selectOwnDie}
              opponentAction={!itemMode && canAttack ? {
                label: "알까기",
                tone: "attack",
                run: () => { onCommand({ type: "ALKKAGI", lane }, `${lane + 1}번 라인 공격 중`); },
              } : !itemMode && bonusOpponent ? {
                label: "상대에게 실드",
                tone: "bonus",
                run: () => { onCommand({ type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: opponentId, lane }, "보너스 실드 배치 중"); },
              } : undefined}
              ownAction={!itemMode && canPlace ? {
                label: "놓기",
                tone: "place",
                run: () => { onCommand({ type: "PLACE_OWN", lane }, `${lane + 1}번 라인 배치 중`); },
              } : !itemMode && bonusOwn ? {
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

      <footer className={`action-dock ${isBonus ? "action-dock--bonus" : ""} ${isRolling ? "action-dock--rolling" : ""}`}>
        <div className="action-dock__die">
          {currentDie && currentRollKey && isRolling ? (
            <RollingDieView
              key={currentRollKey}
              die={currentDie}
              onComplete={() => setRevealedRollKey(currentRollKey)}
            />
          ) : currentDie ? (
            <DieView die={currentDie} large />
          ) : (
            <span className="die-placeholder">—</span>
          )}
          {isRolling && <span className="roll-status" aria-hidden="true">ROLL</span>}
          {isBonus && <span className="bonus-orbit"><ShieldIcon /></span>}
        </div>
        <div className="action-dock__copy">
          <p className="eyebrow">{ending ? "MATCH COMPLETE" : isRolling ? "ROLLING..." : itemMode ? "SELECT ITEM TARGET" : isBonus ? "BONUS SHIELD" : isMyTurn ? "CURRENT ROLL" : "OPPONENT ROLL"}</p>
          <strong>{pending?.label ?? instruction}</strong>
          {isBonus && <small>상대 보드에 놓으면 상대 점수에 포함됩니다.</small>}
        </div>
        {!ending && isMyTurn && state.phase === "TURN_ACTION" && (
          <div className={`action-dock__buttons ${itemMode ? "action-dock__buttons--item-mode" : ""}`}>
            {itemMode ? (
              <button
                className="button button--ghost"
                disabled={controlsLocked}
                onClick={() => setItemMode(null)}
              >아이템 선택 취소</button>
            ) : (
              <>
                <button
                  className="button button--tazza"
                  disabled={!game.legalActions.canUseTazza || controlsLocked}
                  onClick={() => onCommand({ type: "USE_TAZZA" }, "타짜 주사위 확인 중")}
                >
                  타짜 <small>{state.tazzaUsed[selfId] ? "완료" : "1회"}</small>
                </button>
                <button
                  className="button button--inventory"
                  disabled={controlsLocked}
                  onClick={() => setOverlay("INVENTORY")}
                >
                  아이템 <small>{remainingItems}개</small>
                </button>
                <button
                  className="button button--ghost"
                  disabled={!game.legalActions.canHold || controlsLocked}
                  onClick={() => setOverlay("HOLD")}
                >홀드</button>
              </>
            )}
          </div>
        )}
      </footer>

      {overlay === "INVENTORY" && (
        <Sheet
          title="인벤토리"
          description="한 턴에 아이템은 하나만 사용할 수 있습니다. 사용 후에도 현재 주사위를 놓거나 공격할 수 있습니다."
          onClose={() => setOverlay(null)}
        >
          <button
            className="item-card"
            disabled={!game.legalActions.canUseSwapItem || controlsLocked}
            onClick={() => {
              setItemMode({ type: "SWAP" });
              setOverlay(null);
            }}
          >
            <span className="item-card__icon" aria-hidden="true">⇄</span>
            <span className="item-card__copy">
              <strong>주사위 교환</strong>
              <small>같은 라인에서 내 일반 주사위 1개와 상대 일반 주사위 1개를 1:1로 교환합니다.</small>
              <em>{swapItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.SWAP}</span>
          </button>
          <button
            className="item-card item-card--reroll"
            disabled={!game.legalActions.canUseRerollItem || controlsLocked}
            onClick={() => {
              setItemMode({ type: "REROLL" });
              setOverlay(null);
            }}
          >
            <span className="item-card__icon" aria-hidden="true">↻</span>
            <span className="item-card__copy">
              <strong>눈 변환</strong>
              <small>내 일반 주사위 또는 상대 일반 주사위 하나를 다른 무작위 눈으로 바꿉니다.</small>
              <em>{rerollItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.REROLL}</span>
          </button>
          <button
            className="item-card item-card--shield"
            disabled={!game.legalActions.canUseShieldItem || controlsLocked}
            onClick={() => {
              if (onCommand({ type: "USE_SHIELD_ITEM" }, "현재 주사위 실드 강화 중")) {
                setOverlay(null);
              }
            }}
          >
            <span className="item-card__icon" aria-hidden="true"><ShieldIcon /></span>
            <span className="item-card__copy">
              <strong>실드 강화</strong>
              <small>현재 눈을 유지한 채 주사위를 실드로 바꿉니다. 아이템과 맵 효과를 받지 않습니다.</small>
              <em>{shieldItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.SHIELD}</span>
          </button>
          <button
            className="item-card item-card--drop"
            disabled={!game.legalActions.canUseDropItem || controlsLocked}
            onClick={() => {
              if (onCommand({ type: "USE_DROP_ITEM" }, `${DROP_ITEM_LABEL} 사용 중`)) {
                setOverlay(null);
              }
            }}
          >
            <span className="item-card__icon" aria-hidden="true">✦</span>
            <span className="item-card__copy">
              <strong>{DROP_ITEM_LABEL}</strong>
              <small>양쪽 보드의 무작위 빈칸에 무작위 일반 주사위를 하나씩 떨어뜨립니다.</small>
              <em>{dropItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.DROP}</span>
          </button>
          <button
            className="item-card item-card--destroy"
            disabled={!game.legalActions.canUseDestroyItem || controlsLocked}
            onClick={() => {
              setItemMode({ type: "DESTROY" });
              setOverlay(null);
            }}
          >
            <span className="item-card__icon" aria-hidden="true">×</span>
            <span className="item-card__copy">
              <strong>주사위 파괴</strong>
              <small>내 일반 주사위 또는 상대 일반 주사위 하나를 선택해 제거합니다.</small>
              <em>{destroyItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.DESTROY}</span>
          </button>
          <button
            className="item-card item-card--turn-reroll"
            disabled={!game.legalActions.canUseTurnRerollItem || controlsLocked}
            onClick={() => {
              if (onCommand({ type: "USE_TURN_REROLL_ITEM" }, "현재 주사위 리롤 중")) {
                setOverlay(null);
              }
            }}
          >
            <span className="item-card__icon" aria-hidden="true">⟳</span>
            <span className="item-card__copy">
              <strong>주사위 리롤</strong>
              <small>현재 착수할 일반 주사위를 기존 눈과 다른 무작위 눈으로 다시 굴립니다.</small>
              <em>{turnRerollItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.TURN_REROLL}</span>
          </button>
          <button
            className="item-card item-card--odd"
            disabled={!game.legalActions.canUseOddItem || controlsLocked}
            onClick={() => {
              if (onCommand({ type: "USE_PARITY_ITEM", parity: "ODD" }, "현재 주사위 홀수 변경 중")) {
                setOverlay(null);
              }
            }}
          >
            <span className="item-card__icon item-card__icon--numbers" aria-hidden="true">135</span>
            <span className="item-card__copy">
              <strong>홀수 주사위</strong>
              <small>현재 일반 주사위를 기존 눈과 다른 무작위 홀수 눈으로 바꿉니다.</small>
              <em>{oddItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.ODD}</span>
          </button>
          <button
            className="item-card item-card--even"
            disabled={!game.legalActions.canUseEvenItem || controlsLocked}
            onClick={() => {
              if (onCommand({ type: "USE_PARITY_ITEM", parity: "EVEN" }, "현재 주사위 짝수 변경 중")) {
                setOverlay(null);
              }
            }}
          >
            <span className="item-card__icon item-card__icon--numbers" aria-hidden="true">246</span>
            <span className="item-card__copy">
              <strong>짝수 주사위</strong>
              <small>현재 일반 주사위를 기존 눈과 다른 무작위 짝수 눈으로 바꿉니다.</small>
              <em>{evenItemStatus}</em>
            </span>
            <span className="item-card__count">×{inventory.EVEN}</span>
          </button>
          {state.itemUsedThisTurn && (
            <p className="inventory-status">이번 턴에는 이미 아이템을 사용했습니다.</p>
          )}
        </Sheet>
      )}

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
      {ending && (
        <div className="game-end-overlay" role="status" aria-live="assertive">
          <section className="game-end-card">
            <span aria-hidden="true">◆</span>
            <p className="eyebrow">MATCH COMPLETE</p>
            <h2>게임 종료</h2>
            <p>최종 결과를 확인합니다.</p>
          </section>
        </div>
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

function PostGameTransition({
  room,
  connection,
  pending,
  onCommand,
  onTutorial,
  onRematch,
}: {
  room: RoomSnapshot;
  connection: ConnectionState;
  pending: PendingAction | null;
  onCommand: (command: GameCommand, label: string) => boolean;
  onTutorial: () => void;
  onRematch: () => void;
}) {
  const gameId = room.game?.state.gameId ?? null;
  const [revealedGameId, setRevealedGameId] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) return;
    const timeout = window.setTimeout(
      () => setRevealedGameId(gameId),
      GAME_END_TRANSITION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [gameId]);

  if (!gameId || revealedGameId === gameId) {
    return (
      <ResultScreen
        room={room}
        connection={connection}
        pending={pending}
        onRematch={onRematch}
      />
    );
  }

  return (
    <GameScreen
      room={room}
      connection={connection}
      pending={pending}
      onCommand={onCommand}
      onTutorial={onTutorial}
      ending
    />
  );
}

export default function App() {
  const session = useRoomSession();
  const [globalOverlay, setGlobalOverlay] = useState<Overlay>(null);
  const errorKey = useMemo(() => session.error, [session.error]);

  useEffect(() => {
    if (session.room?.status === "POST_GAME") setGlobalOverlay(null);
  }, [session.room?.status]);

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
        onTutorial={() => setGlobalOverlay("TUTORIAL")}
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
      <PostGameTransition
        room={session.room}
        connection={session.connection}
        pending={session.pending}
        onCommand={session.sendGameCommand}
        onTutorial={() => setGlobalOverlay("TUTORIAL")}
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
        onTutorial={() => setGlobalOverlay("TUTORIAL")}
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
      {globalOverlay === "TUTORIAL" && <TutorialSheet onClose={() => setGlobalOverlay(null)} />}
    </>
  );
}
