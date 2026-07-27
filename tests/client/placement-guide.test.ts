import { describe, expect, it } from "vitest";
import { calculatePlacementHints } from "../../src/client/placement-guide";
import type { Board, Die, DieFace } from "../../src/game";

function die(id: string, face: DieFace): Die {
  return { id, face, kind: "NORMAL", createdBy: "player-a" };
}

describe("calculatePlacementHints", () => {
  it("recommends the legal lane with the largest immediate score gain", () => {
    const board: Board = [
      [die("five", 5)],
      [die("two", 2)],
      [],
    ];

    expect(calculatePlacementHints(board, die("current", 5), [0, 1, 2])).toEqual([
      { lane: 0, scoreGain: 10, isRecommended: true },
      { lane: 1, scoreGain: 5, isRecommended: false },
      { lane: 2, scoreGain: 5, isRecommended: false },
    ]);
  });

  it("marks tied best lanes and excludes illegal lanes", () => {
    const board: Board = [[], [die("six", 6)], []];

    expect(calculatePlacementHints(board, die("current", 3), [0, 2])).toEqual([
      { lane: 0, scoreGain: 3, isRecommended: true },
      { lane: 2, scoreGain: 3, isRecommended: true },
    ]);
  });

  it("does not mutate the board while projecting a placement", () => {
    const board: Board = [[die("one", 1)], [], []];

    calculatePlacementHints(board, die("current", 1), [0]);

    expect(board[0].map(({ id }) => id)).toEqual(["one"]);
  });
});
