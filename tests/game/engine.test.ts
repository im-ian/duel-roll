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

function fullLane(prefix: string, createdBy = "A") {
  return ([1, 2, 3, 4, 5] as const).map((face, index) =>
    die(`${prefix}-${index + 1}`, face, "NORMAL", createdBy),
  );
}

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
    expect(transition.state.inventory).toEqual({
      A: { SWAP: 1, REROLL: 1 },
      B: { SWAP: 1, REROLL: 1 },
    });
    expect(transition.state.itemUsedThisTurn).toBe(false);
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
          fullLane("a"),
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
          fullLane("a-lane-1"),
          fullLane("a-lane-2"),
          fullLane("a-lane-3"),
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
          fullLane("b-lane-1", "B"),
          fullLane("b-lane-2", "B"),
          [
            die("b-lane-3-1", 1, "NORMAL", "B"),
            die("b-lane-3-2", 2, "NORMAL", "B"),
            die("b-lane-3-3", 3, "NORMAL", "B"),
            die("b-lane-3-4", 4, "NORMAL", "B"),
          ],
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

  it("allows five dice per lane and rejects a sixth placement", () => {
    const fourDice = fullLane("four").slice(0, 4);
    const placed = applyCommand(
      activeState({
        boards: {
          A: board(fourDice, [], []),
          B: board([], [], []),
        },
      }),
      "A",
      { type: "PLACE_OWN", lane: 0 },
      context({ rolls: [2] }),
    );
    expect(placed.state.boards.A?.[0]).toHaveLength(5);

    expect(() =>
      applyCommand(
        activeState({
          boards: {
            A: board(fullLane("full"), [], []),
            B: board([], [], []),
          },
        }),
        "A",
        { type: "PLACE_OWN", lane: 0 },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: "LANE_FULL" }));
  });

  it("swaps whole dice across the same lane without ending the turn", () => {
    const state = activeState({
      boards: {
        A: board([die("own", 2, "NORMAL", "A")], [], []),
        B: board([die("opponent", 6, "SHIELD", "B")], [], []),
      },
    });

    const swapped = applyCommand(
      state,
      "A",
      {
        type: "USE_SWAP_ITEM",
        lane: 0,
        ownDieId: "own",
        opponentDieId: "opponent",
      },
      context(),
    );

    expect(swapped.state.boards.A?.[0]).toEqual([
      die("opponent", 6, "SHIELD", "B"),
    ]);
    expect(swapped.state.boards.B?.[0]).toEqual([
      die("own", 2, "NORMAL", "A"),
    ]);
    expect(swapped.state.inventory.A).toEqual({ SWAP: 0, REROLL: 1 });
    expect(swapped.state.itemUsedThisTurn).toBe(true);
    expect(swapped.state.currentPlayerId).toBe("A");
    expect(swapped.state.pending).toEqual(state.pending);
    expect(swapped.events).toMatchObject([
      { type: "DICE_SWAPPED", playerId: "A", lane: 0 },
    ]);
  });

  it("rerolls an opponent shield while preserving its identity and kind", () => {
    const state = activeState({
      boards: {
        A: board([], [], []),
        B: board([], [], [die("target", 4, "SHIELD", "B")]),
      },
    });

    const rerolled = applyCommand(
      state,
      "A",
      {
        type: "USE_REROLL_ITEM",
        boardOwnerPlayerId: "B",
        lane: 2,
        dieId: "target",
      },
      context({ differentRolls: [6] }),
    );

    expect(rerolled.state.boards.B?.[2]).toEqual([
      die("target", 6, "SHIELD", "B"),
    ]);
    expect(rerolled.state.inventory.A).toEqual({ SWAP: 1, REROLL: 0 });
    expect(rerolled.state.itemUsedThisTurn).toBe(true);
    expect(rerolled.state.pending).toEqual(state.pending);
    expect(rerolled.events).toMatchObject([
      {
        type: "DIE_REROLLED",
        playerId: "A",
        boardOwnerPlayerId: "B",
        previousDie: { face: 4 },
        die: { id: "target", face: 6, kind: "SHIELD" },
      },
    ]);
  });

  it("allows placement after an item and resets the item limit on the next turn", () => {
    const state = activeState({
      boards: {
        A: board([die("own", 2)], [], []),
        B: board([die("opponent", 5, "NORMAL", "B")], [], []),
      },
    });
    const engineContext = context({ rolls: [3], differentRolls: [4] });
    const used = applyCommand(
      state,
      "A",
      {
        type: "USE_REROLL_ITEM",
        boardOwnerPlayerId: "B",
        lane: 0,
        dieId: "opponent",
      },
      engineContext,
    );
    expect(getLegalActions(used.state, "A")).toMatchObject({
      canUseSwapItem: false,
      canUseRerollItem: false,
      swapItemLanes: [],
      rerollItemTargets: [],
    });

    expect(() =>
      applyCommand(
        used.state,
        "A",
        {
          type: "USE_SWAP_ITEM",
          lane: 0,
          ownDieId: "own",
          opponentDieId: "opponent",
        },
        engineContext,
      ),
    ).toThrowError(expect.objectContaining({ code: "ITEM_ALREADY_USED_THIS_TURN" }));

    const placed = applyCommand(
      used.state,
      "A",
      { type: "PLACE_OWN", lane: 1 },
      engineContext,
    );
    expect(placed.state.boards.A?.[1]).toHaveLength(1);
    expect(placed.state.currentPlayerId).toBe("B");
    expect(placed.state.itemUsedThisTurn).toBe(false);
    expect(getLegalActions(placed.state, "B")).toMatchObject({
      canUseSwapItem: true,
      canUseRerollItem: true,
    });
  });

  it("rejects item targets that are not in the declared lane", () => {
    const state = activeState({
      boards: {
        A: board([die("own", 2)], [], []),
        B: board([], [die("opponent", 5, "NORMAL", "B")], []),
      },
    });

    expect(() =>
      applyCommand(
        state,
        "A",
        {
          type: "USE_SWAP_ITEM",
          lane: 0,
          ownDieId: "own",
          opponentDieId: "opponent",
        },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ITEM_TARGET" }));
    expect(state.inventory.A).toEqual({ SWAP: 1, REROLL: 1 });
    expect(state.itemUsedThisTurn).toBe(false);
  });

  it("exposes only currently legal lane actions", () => {
    const state = activeState({
      pendingFace: 4,
      boards: {
        A: board(
          fullLane("a"),
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
      canUseSwapItem: true,
      canUseRerollItem: true,
      swapItemLanes: [0],
      canHold: true,
    });
    expect(getLegalActions(state, "B")).toMatchObject({
      ownPlacementLanes: [],
      alkkagiLanes: [],
      canSurrender: true,
    });
    expect(() => assertGameInvariants(state)).not.toThrow();
  });
});
