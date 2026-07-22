import { describe, expect, it } from "vitest";
import {
  applyCommand,
  assertGameInvariants,
  createGame,
  getLegalActions,
} from "../../src/game/engine";
import { RuleError } from "../../src/game/errors";
import { isEligible } from "../../src/game/scoring";
import { activeState, board, context, die } from "../helpers";

describe("game engine", () => {
  it("starts with a server-selected first player and an opening shield", () => {
    const transition = createGame(
      ["A", "B"],
      context({ firstPlayer: "B", rolls: [4] }),
    );

    expect(transition.state.firstPlayerId).toBe("B");
    expect(transition.state.currentPlayerId).toBe("B");
    expect(transition.state.pending).toMatchObject({
      source: "TURN",
      original: { face: 4, kind: "SHIELD", createdBy: "B" },
    });
    expect(transition.events.map((event) => event.type)).toEqual([
      "GAME_STARTED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);
  });

  it("preserves the shield kind when Tazza changes the opening face", () => {
    const engineContext = context({
      firstPlayer: "A",
      rolls: [1],
      differentRolls: [5],
    });
    const started = createGame(["A", "B"], engineContext);
    const offered = applyCommand(
      started.state,
      "A",
      { type: "USE_TAZZA" },
      engineContext,
    );

    expect(offered.state.phase).toBe("TAZZA_CHOICE");
    expect(offered.state.pending).toMatchObject({
      source: "TURN",
      original: { face: 1, kind: "SHIELD" },
      candidate: { face: 5, kind: "SHIELD" },
    });
    expect(offered.state.tazzaUsed.A).toBe(true);

    const selected = applyCommand(
      offered.state,
      "A",
      { type: "CHOOSE_TAZZA_DIE", choice: "CANDIDATE" },
      engineContext,
    );
    expect(selected.state.pending).toMatchObject({
      source: "TURN",
      original: { face: 5, kind: "SHIELD" },
    });
  });

  it("removes all matching normal dice, preserves shields, and creates one bonus shield", () => {
    const state = activeState({
      pendingFace: 6,
      boards: {
        A: board([], [], []),
        B: board(
          [
            die("normal-1", 6, "NORMAL", "B"),
            die("normal-2", 6, "NORMAL", "B"),
            die("shield", 6, "SHIELD", "B"),
          ],
          [],
          [],
        ),
      },
    });
    const engineContext = context({ rolls: [2, 4] });

    const attacked = applyCommand(
      state,
      "A",
      { type: "ALKKAGI", lane: 0 },
      engineContext,
    );

    expect(attacked.state.boards.B?.[0]).toEqual([
      die("shield", 6, "SHIELD", "B"),
    ]);
    expect(attacked.state.phase).toBe("BONUS_PLACEMENT");
    expect(attacked.state.pending).toMatchObject({
      source: "BONUS",
      die: { face: 2, kind: "SHIELD", createdBy: "A" },
      attackedPlayerId: "B",
      attackedLane: 0,
    });
    expect(
      attacked.events.find((event) => event.type === "DICE_REMOVED"),
    ).toMatchObject({ dice: [{ id: "normal-1" }, { id: "normal-2" }] });

    const placed = applyCommand(
      attacked.state,
      "A",
      { type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: "B", lane: 0 },
      engineContext,
    );
    expect(placed.state.boards.B?.[0].map((placedDie) => placedDie.kind)).toEqual([
      "SHIELD",
      "SHIELD",
    ]);
    expect(placed.state.currentPlayerId).toBe("B");
    expect(placed.state.pending).toMatchObject({
      source: "TURN",
      original: { face: 4, kind: "NORMAL", createdBy: "B" },
    });
  });

  it("rejects alkkagi when the actor's corresponding lane is full", () => {
    const state = activeState({
      pendingFace: 6,
      boards: {
        A: board(
          [die("a1", 1), die("a2", 2), die("a3", 3)],
          [],
          [],
        ),
        B: board([die("b6", 6, "NORMAL", "B")], [], []),
      },
    });

    try {
      applyCommand(
        state,
        "A",
        { type: "ALKKAGI", lane: 0 },
        context({ rolls: [1] }),
      );
      throw new Error("Expected ALKKAGI to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RuleError);
      expect(error).toMatchObject({
        code: "ALKKAGI_NOT_AVAILABLE",
        details: { reason: "ACTOR_LANE_FULL" },
      });
    }
  });

  it("lets a previously full player return after alkkagi opens the board", () => {
    const state = activeState({
      currentPlayerId: "B",
      pendingFace: 5,
      boards: {
        A: board(
          [die("a5", 5), die("a2", 2), die("a3", 3)],
          [die("a4", 1), die("a5b", 2), die("a6", 3)],
          [die("a7", 1), die("a8", 2), die("a9", 3)],
        ),
        B: board([], [], []),
      },
    });
    expect(isEligible(state, "A")).toBe(false);
    const engineContext = context({ rolls: [1, 6] });

    const attacked = applyCommand(
      state,
      "B",
      { type: "ALKKAGI", lane: 0 },
      engineContext,
    );
    const completed = applyCommand(
      attacked.state,
      "B",
      { type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: "B", lane: 0 },
      engineContext,
    );

    expect(completed.state.currentPlayerId).toBe("A");
    expect(completed.state.phase).toBe("TURN_ACTION");
    expect(completed.state.pending).toMatchObject({
      source: "TURN",
      original: { face: 6, kind: "NORMAL", createdBy: "A" },
    });
  });

  it("never makes a held player eligible again", () => {
    const state = activeState({
      held: { A: true, B: false },
      currentPlayerId: "B",
      pendingFace: 6,
      boards: {
        A: board([die("a", 1)], [], []),
        B: board(
          [die("b1", 1), die("b2", 2), die("b3", 3)],
          [die("b4", 1), die("b5", 2), die("b6", 3)],
          [die("b7", 1), die("b8", 2)],
        ),
      },
    });

    expect(isEligible(state, "A")).toBe(false);
    const finished = applyCommand(
      state,
      "B",
      { type: "PLACE_OWN", lane: 2 },
      context({ rolls: [1] }),
    );
    expect(finished.state.phase).toBe("FINISHED");
    expect(finished.state.result?.reason).toBe("NORMAL");
  });

  it("allows surrender from the non-current player", () => {
    const state = activeState({ currentPlayerId: "A" });
    const surrendered = applyCommand(
      state,
      "B",
      { type: "SURRENDER" },
      context({ rolls: [1] }),
    );

    expect(surrendered.state.result).toMatchObject({
      reason: "SURRENDER",
      winnerPlayerId: "A",
    });
  });

  it("exposes only currently legal lane actions", () => {
    const state = activeState({
      pendingFace: 4,
      boards: {
        A: board(
          [die("a1", 1), die("a2", 2), die("a3", 3)],
          [],
          [],
        ),
        B: board([die("b4-blocked", 4, "NORMAL", "B")], [die("b4", 4, "NORMAL", "B")], []),
      },
    });

    expect(getLegalActions(state, "A")).toMatchObject({
      ownPlacementLanes: [1, 2],
      alkkagiLanes: [1],
      canUseTazza: true,
      canHold: true,
    });
    expect(getLegalActions(state, "B")).toMatchObject({
      ownPlacementLanes: [],
      alkkagiLanes: [],
      canSurrender: true,
    });
    expect(() => assertGameInvariants(state)).not.toThrow();
  });

  it("swaps two dice between own and opponent lanes", () => {
    const state = activeState({
      pendingFace: 4,
      boards: {
        A: board([die("a1", 1, "NORMAL", "A"), die("a2", 2, "NORMAL", "A")], [], []),
        B: board([die("b1", 3, "NORMAL", "B"), die("b2", 4, "SHIELD", "B")], [], []),
      },
    });

    const result = applyCommand(
      state,
      "A",
      { type: "SWAP_DICE", lane: 0, ownDieId: "a2", opponentDieId: "b1" },
      context({ rolls: [5] }),
    );

    expect(result.state.boards.A?.[0].map((d) => d.id)).toEqual(["a1", "b1"]);
    expect(result.state.boards.B?.[0].map((d) => d.id)).toEqual(["a2", "b2"]);
    expect(result.state.phase).toBe("TURN_ACTION");
    expect(result.state.currentPlayerId).toBe("A");
    expect(result.events.find((e) => e.type === "DICE_SWAPPED")).toMatchObject({
      actorPlayerId: "A",
      lane: 0,
      ownDie: { id: "a2" },
      opponentDie: { id: "b1" },
    });
  });

  it("rejects swap when either die id is missing", () => {
    const state = activeState({
      boards: {
        A: board([die("a1", 1)], [], []),
        B: board([die("b1", 3)], [], []),
      },
    });

    try {
      applyCommand(
        state,
        "A",
        { type: "SWAP_DICE", lane: 0, ownDieId: "missing", opponentDieId: "b1" },
        context({ rolls: [1] }),
      );
      throw new Error("Expected SWAP_DICE to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RuleError);
      expect(error).toMatchObject({
        code: "SWAP_NOT_AVAILABLE",
        details: { reason: "OWN_DIE_NOT_FOUND" },
      });
    }
  });

  it("rejects swap when either lane is empty", () => {
    const state = activeState({
      boards: {
        A: board([], [], []),
        B: board([die("b1", 3)], [], []),
      },
    });

    try {
      applyCommand(
        state,
        "A",
        { type: "SWAP_DICE", lane: 0, ownDieId: "a1", opponentDieId: "b1" },
        context({ rolls: [1] }),
      );
      throw new Error("Expected SWAP_DICE to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RuleError);
      expect(error).toMatchObject({
        code: "SWAP_NOT_AVAILABLE",
        details: { reason: "EMPTY_LANE" },
      });
    }
  });

  it("only exposes swapTargets during TURN_ACTION for the current player", () => {
    const state = activeState({
      pendingFace: 4,
      boards: {
        A: board([die("a1", 1)], [], []),
        B: board([die("b1", 3)], [], []),
      },
    });

    const own = getLegalActions(state, "A");
    expect(own.swapTargets).toEqual([
      { lane: 0, ownDieIds: ["a1"], opponentDieIds: ["b1"] },
    ]);

    const opponent = getLegalActions(state, "B");
    expect(opponent.swapTargets).toEqual([]);
  });
});
