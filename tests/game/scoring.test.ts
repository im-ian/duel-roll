import { describe, expect, it } from "vitest";
import { calculateResult, scoreLane } from "../../src/game/scoring";
import { activeState, board, die } from "../helpers";

describe("scoreLane", () => {
  it("scores singles, doubles, and triples from the documented formula", () => {
    expect(scoreLane([die("a", 5)])).toBe(5);
    expect(scoreLane([die("a", 5), die("b", 5)])).toBe(15);
    expect(
      scoreLane([die("a", 5), die("b", 5), die("c", 5)]),
    ).toBe(25);
    expect(
      scoreLane([
        die("a", 5),
        die("b", 5),
        die("c", 5),
        die("d", 5),
        die("e", 5),
      ]),
    ).toBe(45);
    expect(
      scoreLane([die("a", 5), die("b", 5), die("c", 2)]),
    ).toBe(17);
  });

  it("includes shields in duplicate bonuses", () => {
    expect(
      scoreLane([
        die("normal", 5),
        die("shield", 5, "SHIELD"),
        die("two", 2),
      ]),
    ).toBe(17);
  });
});
describe("calculateResult", () => {
  it("uses total score when lane wins are tied", () => {
    const state = activeState({
      boards: {
        A: board(
          [die("a20-1", 6), die("a20-2", 6), die("a20-3", 2)],
          [die("a7-1", 3), die("a7-2", 4)],
          [die("a10-1", 4), die("a10-2", 6)],
        ),
        B: board(
          [die("b18-1", 6), die("b18-2", 6)],
          [die("b12-1", 4), die("b12-2", 4)],
          [die("b10-1", 4), die("b10-2", 6)],
        ),
      },
    });

    const result = calculateResult(state, "NORMAL");

    expect(result.laneWins).toEqual({ A: 1, B: 1 });
    expect(result.totalScores).toEqual({ A: 37, B: 40 });
    expect(result.winnerPlayerId).toBe("B");
  });

  it("returns a draw when lane wins and totals are equal", () => {
    const state = activeState({
      boards: {
        A: board([die("a1", 6)], [die("a2", 2)], [die("a3", 4)]),
        B: board([die("b1", 2)], [die("b2", 6)], [die("b3", 4)]),
      },
    });

    expect(calculateResult(state, "NORMAL").winnerPlayerId).toBeNull();
  });
});
