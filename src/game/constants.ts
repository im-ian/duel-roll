import type { ItemType } from "./types";

export const LANE_COUNT = 3;
export const LANE_CAPACITY = 5;
export const BOARD_CAPACITY = LANE_COUNT * LANE_CAPACITY;

export const STARTING_ITEM_COUNT = 1;

export const ITEM_TYPES = [
  "SWAP",
  "REROLL",
  "SHIELD",
  "DROP",
  "DESTROY",
  "ODD",
  "EVEN",
] as const satisfies readonly ItemType[];
