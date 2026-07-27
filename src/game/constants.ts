import type { ItemType } from "./types";

export const LANE_COUNT = 3;
export const LANE_CAPACITY = 5;
export const BOARD_CAPACITY = LANE_COUNT * LANE_CAPACITY;
export const LINE_REWARD_THRESHOLD = 3;

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

// The item catalog and starting grants are intentionally separate so future
// rewards and loadouts do not implicitly grant every newly added item.
export const STARTING_ITEM_TYPES = [
  "SHIELD",
  "DESTROY",
  "ODD",
  "EVEN",
] as const satisfies readonly ItemType[];
