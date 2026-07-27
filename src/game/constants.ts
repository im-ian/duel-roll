import type { ItemType, LineMissionKind } from "./types";

export const LANE_COUNT = 3;
export const LANE_CAPACITY = 5;
export const BOARD_CAPACITY = LANE_COUNT * LANE_CAPACITY;
export const LINE_PLACEMENT_MISSION_THRESHOLD = 3;
export const LINE_SCORE_MISSION_THRESHOLD = 15;
export const LINE_MISSION_KINDS = [
  "PLACEMENT_COUNT",
  "SCORE_OVER",
] as const satisfies readonly LineMissionKind[];

export const STARTING_ITEM_COUNT = 1;

export const ITEM_TYPES = [
  "SWAP",
  "REROLL",
  "SHIELD",
  "DROP",
  "DESTROY",
  "TURN_REROLL",
  "ODD",
  "EVEN",
] as const satisfies readonly ItemType[];

export const ITEM_TURN_BEHAVIOR = {
  SWAP: "END",
  REROLL: "END",
  SHIELD: "CONTINUE",
  DROP: "END",
  DESTROY: "END",
  TURN_REROLL: "CONTINUE",
  ODD: "CONTINUE",
  EVEN: "CONTINUE",
} as const satisfies Record<ItemType, "CONTINUE" | "END">;

// The item catalog and starting grants are intentionally separate so future
// rewards and loadouts do not implicitly grant every newly added item.
export const STARTING_ITEM_TYPES = [
  "SHIELD",
  "DESTROY",
  "ODD",
  "EVEN",
] as const satisfies readonly ItemType[];
