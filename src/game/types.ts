export type PlayerId = string;
export type LaneIndex = 0 | 1 | 2;
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DieKind = "NORMAL" | "SHIELD";
export type DieParity = "ODD" | "EVEN";
export type ItemType =
  | "SWAP"
  | "REROLL"
  | "SHIELD"
  | "DROP"
  | "DESTROY"
  | "TURN_REROLL"
  | DieParity;

export type ItemInventory = Record<ItemType, number>;

export type Die = {
  id: string;
  face: DieFace;
  kind: DieKind;
  createdBy: PlayerId;
};
export type Board = [Die[], Die[], Die[]];

export type LineReward = {
  lane: LaneIndex;
  threshold: 3;
  claimedByPlayerId: PlayerId | null;
  itemType: ItemType | null;
};

export type DroppedDiePlacement = {
  boardOwnerPlayerId: PlayerId;
  lane: LaneIndex;
  die: Die;
};

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
  schemaVersion: 5;
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
  lineReward: LineReward;
  held: Record<PlayerId, boolean>;
  result: GameResult | null;
};

export type GameCommand =
  | { type: "PLACE_OWN"; lane: LaneIndex }
  | { type: "ALKKAGI"; lane: LaneIndex }
  | { type: "USE_TAZZA" }
  | {
      type: "USE_SWAP_ITEM";
      lane: LaneIndex;
      ownDieId: string;
      opponentDieId: string;
    }
  | {
      type: "USE_REROLL_ITEM";
      boardOwnerPlayerId: PlayerId;
      lane: LaneIndex;
      dieId: string;
    }
  | { type: "USE_SHIELD_ITEM" }
  | { type: "USE_DROP_ITEM" }
  | {
      type: "USE_DESTROY_ITEM";
      boardOwnerPlayerId: PlayerId;
      lane: LaneIndex;
      dieId: string;
    }
  | { type: "USE_TURN_REROLL_ITEM" }
  | { type: "USE_PARITY_ITEM"; parity: DieParity }
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
      type: "DICE_SWAPPED";
      playerId: PlayerId;
      lane: LaneIndex;
      ownDie: Die;
      opponentDie: Die;
    }
  | {
      type: "DIE_REROLLED";
      playerId: PlayerId;
      boardOwnerPlayerId: PlayerId;
      lane: LaneIndex;
      previousDie: Die;
      die: Die;
    }
  | {
      type: "DIE_SHIELDED";
      playerId: PlayerId;
      previousDie: Die;
      die: Die;
    }
  | {
      type: "DICE_DROPPED";
      playerId: PlayerId;
      placements: [DroppedDiePlacement, DroppedDiePlacement];
    }
  | {
      type: "DIE_DESTROYED";
      playerId: PlayerId;
      boardOwnerPlayerId: PlayerId;
      lane: LaneIndex;
      die: Die;
    }
  | {
      type: "TURN_DIE_PARITY_CHANGED";
      playerId: PlayerId;
      parity: DieParity;
      previousDie: Die;
      die: Die;
    }
  | {
      type: "TURN_DIE_REROLLED";
      playerId: PlayerId;
      previousDie: Die;
      die: Die;
    }
  | {
      type: "LINE_REWARD_CLAIMED";
      playerId: PlayerId;
      lane: LaneIndex;
      threshold: 3;
      itemType: ItemType;
    }
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
  canUseSwapItem: boolean;
  canUseRerollItem: boolean;
  canUseShieldItem: boolean;
  canUseDropItem: boolean;
  canUseDestroyItem: boolean;
  canUseTurnRerollItem: boolean;
  canUseOddItem: boolean;
  canUseEvenItem: boolean;
  canHold: boolean;
  canSurrender: boolean;
  canChooseTazza: boolean;
  ownPlacementLanes: LaneIndex[];
  alkkagiLanes: LaneIndex[];
  swapItemLanes: LaneIndex[];
  rerollItemTargets: Array<{
    boardOwnerPlayerId: PlayerId;
    lane: LaneIndex;
    dieId: string;
  }>;
  destroyItemTargets: Array<{
    boardOwnerPlayerId: PlayerId;
    lane: LaneIndex;
    dieId: string;
  }>;
  bonusTargets: Array<{
    boardOwnerPlayerId: PlayerId;
    lane: LaneIndex;
  }>;
};

export interface DiceRng {
  chooseFirstPlayer(players: [PlayerId, PlayerId]): PlayerId;
  rollD6(): DieFace;
  rollDifferentFace(excluded: DieFace): DieFace;
  pickIndex(upperBound: number): number;
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
