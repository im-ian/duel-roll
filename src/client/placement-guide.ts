import { scoreLane } from "../game/scoring";
import type { Board, Die, LaneIndex } from "../game/types";

export type PlacementHint = {
  lane: LaneIndex;
  scoreGain: number;
  isRecommended: boolean;
};

export function calculatePlacementHints(
  board: Board,
  currentDie: Die,
  legalLanes: readonly LaneIndex[],
): PlacementHint[] {
  const candidates = legalLanes.map((lane) => ({
    lane,
    scoreGain:
      scoreLane([...board[lane], currentDie]) - scoreLane(board[lane]),
  }));

  if (candidates.length === 0) return [];

  const bestGain = Math.max(...candidates.map(({ scoreGain }) => scoreGain));
  return candidates.map((candidate) => ({
    ...candidate,
    isRecommended: candidate.scoreGain === bestGain,
  }));
}
