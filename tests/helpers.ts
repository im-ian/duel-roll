import type {
  Board,
  DiceRng,
  Die,
  DieFace,
  DieKind,
  EngineContext,
  GameState,
  IdGenerator,
  PlayerId,
} from "../src/game/types";

export class ScriptedRng implements DiceRng {
  private readonly firstPlayer: PlayerId;
  private readonly rolls: DieFace[];
  private readonly differentRolls: DieFace[];
  private readonly indexes: number[];

  constructor(options?: {
    firstPlayer?: PlayerId;
    rolls?: DieFace[];
    differentRolls?: DieFace[];
    indexes?: number[];
  }) {
    this.firstPlayer = options?.firstPlayer ?? "A";
    this.rolls = [...(options?.rolls ?? [1])];
    this.differentRolls = [...(options?.differentRolls ?? [2])];
    this.indexes = [...(options?.indexes ?? [0, 0])];
  }

  chooseFirstPlayer(players: [PlayerId, PlayerId]): PlayerId {
    if (!players.includes(this.firstPlayer)) {
      throw new Error("Scripted first player is not in the game.");
    }
    return this.firstPlayer;
  }

  rollD6(): DieFace {
    const face = this.rolls.shift();
    if (!face) throw new Error("Scripted d6 rolls exhausted.");
    return face;
  }

  rollDifferentFace(excluded: DieFace): DieFace {
    const face = this.differentRolls.shift();
    if (!face) throw new Error("Scripted different-face rolls exhausted.");
    if (face === excluded) {
      throw new Error("Scripted different face matched the excluded face.");
    }
    return face;
  }

  pickIndex(upperBound: number): number {
    const index = this.indexes.shift();
    if (index === undefined) throw new Error("Scripted indexes exhausted.");
    if (!Number.isInteger(index) || index < 0 || index >= upperBound) {
      throw new Error(`Scripted index ${index} is outside 0..${upperBound - 1}.`);
    }
    return index;
  }
}
export class SequentialIds implements IdGenerator {
  private sequence = 0;

  next(prefix: "game" | "die"): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}

export function context(options?: {
  firstPlayer?: PlayerId;
  rolls?: DieFace[];
  differentRolls?: DieFace[];
  indexes?: number[];
}): EngineContext {
  return {
    rng: new ScriptedRng(options),
    ids: new SequentialIds(),
  };
}

export function die(
  id: string,
  face: DieFace,
  kind: DieKind = "NORMAL",
  createdBy: PlayerId = "A",
): Die {
  return { id, face, kind, createdBy };
}

export function board(...lanes: [Die[], Die[], Die[]]): Board {
  return lanes;
}

export function activeState(options?: {
  currentPlayerId?: PlayerId;
  pendingFace?: DieFace;
  pendingKind?: DieKind;
  boards?: Record<PlayerId, Board>;
  held?: Record<PlayerId, boolean>;
  tazzaUsed?: Record<PlayerId, boolean>;
  inventory?: GameState["inventory"];
  itemUsedThisTurn?: boolean;
  lineMission?: GameState["lineMission"];
}): GameState {
  const currentPlayerId = options?.currentPlayerId ?? "A";
  return {
    schemaVersion: 7,
    gameId: "game_test",
    version: 0,
    players: ["A", "B"],
    firstPlayerId: "A",
    currentPlayerId,
    phase: "TURN_ACTION",
    turnNumber: 3,
    boards: options?.boards ?? {
      A: board([], [], []),
      B: board([], [], []),
    },
    pending: {
      source: "TURN",
      original: die(
        "pending",
        options?.pendingFace ?? 6,
        options?.pendingKind ?? "NORMAL",
        currentPlayerId,
      ),
    },
    tazzaUsed: options?.tazzaUsed ?? { A: false, B: false },
    inventory: options?.inventory ?? {
      A: {
        SWAP: 1,
        REROLL: 1,
        SHIELD: 1,
        DROP: 1,
        DESTROY: 1,
        TURN_REROLL: 0,
        ODD: 1,
        EVEN: 1,
      },
      B: {
        SWAP: 1,
        REROLL: 1,
        SHIELD: 1,
        DROP: 1,
        DESTROY: 1,
        TURN_REROLL: 0,
        ODD: 1,
        EVEN: 1,
      },
    },
    itemUsedThisTurn: options?.itemUsedThisTurn ?? false,
    lineMission: options?.lineMission ?? {
      kind: "PLACEMENT_COUNT",
      lane: 0,
      threshold: 3,
      rewardItems: { A: "SHIELD", B: "SHIELD" },
    },
    held: options?.held ?? { A: false, B: false },
    result: null,
  };
}
