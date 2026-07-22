export type PlayerId = string;
export type LaneIndex = 0 | 1 | 2;
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DieKind = "NORMAL" | "SHIELD";

export type Die = {
  id: string;
  face: DieFace;
  kind: DieKind;
  createdBy: PlayerId;
};
export type Board = [Die[], Die[], Die[]];

export type TurnPending =
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

export type GamePhase =
  | "TURN_ACTION"
  | "TAZZA_CHOICE"
  | "BONUS_PLACEMENT"
  | "FINISHED";

export type GameResultReason =
  | "NORMAL"
  | "SURRENDER"
  | "DISCONNECT_FORFEIT";

export type GameResult = {
  reason: GameResultReason;
  winnerPlayerId: PlayerId | null;
  laneScores: Record<PlayerId, [number, number, number]>;
  laneWins: Record<PlayerId, number>;
  totalScores: Record<PlayerId, number>;
};

export type GameState = {
  schemaVersion: 1;
  rulesVersion: "1";
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
  held: Record<PlayerId, boolean>;
  result: GameResult | null;
};

export type GameCommand =
  | { type: "PLACE_OWN"; lane: LaneIndex }
  | { type: "ALKKAGI"; lane: LaneIndex }
  | { type: "USE_TAZZA" }
  | {
      type: "CHOOSE_TAZZA_DIE";
      choice: "ORIGINAL" | "CANDIDATE";
    }
  | {
      type: "PLACE_BONUS_SHIELD";
      boardOwnerPlayerId: PlayerId;
      lane: LaneIndex;
    }
  | { type: "HOLD" }
  | { type: "SURRENDER" };

export type GameEvent =
  | { type: "GAME_STARTED"; firstPlayerId: PlayerId }
  | { type: "TURN_STARTED"; playerId: PlayerId; turnNumber: number }
  | {
      type: "DIE_ROLLED";
      playerId: PlayerId;
      die: Die;
      source: "TURN" | "BONUS";
    }
  | {
      type: "DIE_PLACED";
      playerId: PlayerId;
      boardOwnerPlayerId: PlayerId;
      lane: LaneIndex;
      die: Die;
    }
  | {
      type: "DIE_SPENT";
      playerId: PlayerId;
      die: Die;
      reason: "ALKKAGI" | "HOLD";
    }
  | {
      type: "DICE_REMOVED";
      byPlayerId: PlayerId;
      fromPlayerId: PlayerId;
      lane: LaneIndex;
      dice: Die[];
    }
  | { type: "TAZZA_USED"; playerId: PlayerId }
  | {
      type: "TAZZA_SELECTED";
      playerId: PlayerId;
      die: Die;
    }
  | { type: "PLAYER_HELD"; playerId: PlayerId }
  | { type: "PLAYER_SURRENDERED"; playerId: PlayerId }
  | { type: "GAME_FINISHED"; result: GameResult };

export type LegalActions = {
  canUseTazza: boolean;
  canHold: boolean;
  canSurrender: boolean;
  canChooseTazza: boolean;
  ownPlacementLanes: LaneIndex[];
  alkkagiLanes: LaneIndex[];
  bonusTargets: Array<{
    boardOwnerPlayerId: PlayerId;
    lane: LaneIndex;
  }>;
};

export interface DiceRng {
  chooseFirstPlayer(players: [PlayerId, PlayerId]): PlayerId;
  rollD6(): DieFace;
  rollDifferentFace(excluded: DieFace): DieFace;
}

export interface IdGenerator {
  next(prefix: "game" | "die"): string;
}

export type EngineContext = {
  rng: DiceRng;
  ids: IdGenerator;
};

export type Transition = {
  state: GameState;
  events: GameEvent[];
};
