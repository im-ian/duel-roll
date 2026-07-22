import { describe, expect, it } from "vitest";
import {
  applyCommand,
  assertGameInvariants,
  createGame,
  getLegalActions,
  isDieEffectImmune,
} from "../../src/game/engine";
import { RuleError } from "../../src/game/errors";
import { isEligible } from "../../src/game/scoring";
import type { ItemInventory } from "../../src/game/types";
import { activeState, board, context, die } from "../helpers";

const STARTING_INVENTORY: ItemInventory = {
  SWAP: 1,
  REROLL: 1,
  SHIELD: 1,
  DROP: 1,
  DESTROY: 1,
  ODD: 1,
  EVEN: 1,
};

function inventory(overrides: Partial<ItemInventory> = {}): ItemInventory {
  return { ...STARTING_INVENTORY, ...overrides };
}

function fullLane(prefix: string, createdBy = "A") {
  return ([1, 2, 3, 4, 5] as const).map((face, index) =>
    die(`${prefix}-${index + 1}`, face, "NORMAL", createdBy),
  );
}

function oneLane(prefix: string, count = 5, createdBy = "A") {
  return Array.from({ length: count }, (_, index) =>
    die(`${prefix}-${index + 1}`, 1, "NORMAL", createdBy),
  );
}

describe("game engine", () => {
  it("uses the shield kind as the shared effect-immunity rule", () => {
    expect(isDieEffectImmune(die("normal", 1))).toBe(false);
    expect(isDieEffectImmune(die("shield", 1, "SHIELD"))).toBe(true);
  });

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
      A: inventory(),
      B: inventory(),
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

  it.each([
    ["first", "A", "B"],
    ["second", "B", "A"],
  ] as const)(
    "finishes immediately when the %s player completes 15 slots",
    (_order, completingPlayerId, opponentPlayerId) => {
      const state = activeState({
        currentPlayerId: completingPlayerId,
        pendingFace: 1,
        boards: {
          [completingPlayerId]: board(
            oneLane(`${completingPlayerId}-lane-1`, 5, completingPlayerId),
            oneLane(`${completingPlayerId}-lane-2`, 5, completingPlayerId),
            oneLane(`${completingPlayerId}-lane-3`, 4, completingPlayerId),
          ),
          [opponentPlayerId]: board(
            [
              die(`${opponentPlayerId}-6-1`, 6, "NORMAL", opponentPlayerId),
              die(`${opponentPlayerId}-6-2`, 6, "NORMAL", opponentPlayerId),
            ],
            [
              die(`${opponentPlayerId}-6-3`, 6, "NORMAL", opponentPlayerId),
              die(`${opponentPlayerId}-6-4`, 6, "NORMAL", opponentPlayerId),
            ],
            [],
          ),
        },
      });
      const completed = applyCommand(
        state,
        completingPlayerId,
        { type: "PLACE_OWN", lane: 2 },
        context(),
      );

      expect(completed.state.phase).toBe("FINISHED");
      expect(completed.state.pending).toBeNull();
      expect(completed.state.result).toMatchObject({
        reason: "NORMAL",
        winnerPlayerId: opponentPlayerId,
      });
      expect(completed.events.map((event) => event.type)).toEqual([
        "DIE_PLACED",
        "GAME_FINISHED",
      ]);
    },
  );

  it("also finishes when a bonus shield completes the actor's board", () => {
    const state = activeState({
      pendingFace: 6,
      boards: {
        A: board(
          oneLane("a-lane-1"),
          oneLane("a-lane-2"),
          oneLane("a-lane-3", 4),
        ),
        B: board([], [], [die("target", 6, "NORMAL", "B")]),
      },
    });
    const engineContext = context({ rolls: [2] });
    const attacked = applyCommand(
      state,
      "A",
      { type: "ALKKAGI", lane: 2 },
      engineContext,
    );
    const completed = applyCommand(
      attacked.state,
      "A",
      { type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: "A", lane: 2 },
      engineContext,
    );

    expect(completed.state.boards.A?.[2]).toHaveLength(5);
    expect(completed.state.phase).toBe("FINISHED");
    expect(completed.events.at(-1)?.type).toBe("GAME_FINISHED");
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
        B: board([die("opponent", 6, "NORMAL", "B")], [], []),
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
      die("opponent", 6, "NORMAL", "B"),
    ]);
    expect(swapped.state.boards.B?.[0]).toEqual([
      die("own", 2, "NORMAL", "A"),
    ]);
    expect(swapped.state.inventory.A).toEqual(inventory({ SWAP: 0 }));
    expect(swapped.state.itemUsedThisTurn).toBe(true);
    expect(swapped.state.currentPlayerId).toBe("A");
    expect(swapped.state.pending).toEqual(state.pending);
    expect(swapped.events).toMatchObject([
      { type: "DICE_SWAPPED", playerId: "A", lane: 0 },
    ]);
  });

  it("rerolls an opponent normal die while preserving its identity", () => {
    const state = activeState({
      boards: {
        A: board([], [], []),
        B: board([], [], [die("target", 4, "NORMAL", "B")]),
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
      die("target", 6, "NORMAL", "B"),
    ]);
    expect(rerolled.state.inventory.A).toEqual(inventory({ REROLL: 0 }));
    expect(rerolled.state.itemUsedThisTurn).toBe(true);
    expect(rerolled.state.pending).toEqual(state.pending);
    expect(rerolled.events).toMatchObject([
      {
        type: "DIE_REROLLED",
        playerId: "A",
        boardOwnerPlayerId: "B",
        previousDie: { face: 4 },
        die: { id: "target", face: 6, kind: "NORMAL" },
      },
    ]);
  });

  it("turns the current normal die into a protected shield without ending the turn", () => {
    const state = activeState({
      pendingFace: 4,
      boards: {
        A: board([], [], []),
        B: board([die("attack-target", 4, "NORMAL", "B")], [], []),
      },
    });

    expect(getLegalActions(state, "A")).toMatchObject({
      canUseShieldItem: true,
      alkkagiLanes: [0],
    });

    const shielded = applyCommand(
      state,
      "A",
      { type: "USE_SHIELD_ITEM" },
      context(),
    );

    expect(shielded.state.pending).toMatchObject({
      source: "TURN",
      original: {
        id: "pending",
        face: 4,
        kind: "SHIELD",
        createdBy: "A",
      },
    });
    expect(shielded.state.inventory.A).toEqual(inventory({ SHIELD: 0 }));
    expect(shielded.state.itemUsedThisTurn).toBe(true);
    expect(shielded.state.currentPlayerId).toBe("A");
    expect(shielded.events).toMatchObject([
      {
        type: "DIE_SHIELDED",
        playerId: "A",
        previousDie: { id: "pending", face: 4, kind: "NORMAL" },
        die: { id: "pending", face: 4, kind: "SHIELD" },
      },
    ]);
    expect(getLegalActions(shielded.state, "A")).toMatchObject({
      canUseSwapItem: false,
      canUseRerollItem: false,
      canUseShieldItem: false,
      alkkagiLanes: [],
    });

    const placed = applyCommand(
      shielded.state,
      "A",
      { type: "PLACE_OWN", lane: 1 },
      context({ rolls: [2] }),
    );
    expect(placed.state.boards.A?.[1]).toEqual([
      die("pending", 4, "SHIELD", "A"),
    ]);
    expect(placed.state.currentPlayerId).toBe("B");
  });

  it("excludes every shield die from swap and reroll item targets", () => {
    const state = activeState({
      boards: {
        A: board(
          [
            die("own-shield", 2, "SHIELD", "A"),
            die("own-normal", 3, "NORMAL", "A"),
          ],
          [],
          [],
        ),
        B: board(
          [
            die("opponent-shield", 5, "SHIELD", "B"),
            die("opponent-normal", 6, "NORMAL", "B"),
          ],
          [],
          [],
        ),
      },
    });

    const legal = getLegalActions(state, "A");
    expect(legal.swapItemLanes).toEqual([0]);
    expect(legal.rerollItemTargets.map((target) => target.dieId).sort()).toEqual([
      "opponent-normal",
      "own-normal",
    ]);

    expect(() =>
      applyCommand(
        state,
        "A",
        {
          type: "USE_SWAP_ITEM",
          lane: 0,
          ownDieId: "own-normal",
          opponentDieId: "opponent-shield",
        },
        context(),
      ),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_ITEM_TARGET",
      details: expect.objectContaining({ reason: "DIE_IS_PROTECTED" }),
    }));
    expect(() =>
      applyCommand(
        state,
        "A",
        {
          type: "USE_REROLL_ITEM",
          boardOwnerPlayerId: "A",
          lane: 0,
          dieId: "own-shield",
        },
        context({ differentRolls: [4] }),
      ),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_ITEM_TARGET",
      details: expect.objectContaining({ reason: "DIE_IS_PROTECTED" }),
    }));
    expect(state.inventory.A).toEqual(inventory());
    expect(state.itemUsedThisTurn).toBe(false);
  });

  it("does not offer the shield item for an already protected turn die", () => {
    const state = activeState({ pendingKind: "SHIELD" });

    expect(getLegalActions(state, "A").canUseShieldItem).toBe(false);
    expect(() =>
      applyCommand(state, "A", { type: "USE_SHIELD_ITEM" }, context()),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_ITEM_TARGET",
      details: expect.objectContaining({ reason: "DIE_IS_PROTECTED" }),
    }));
    expect(state.inventory.A).toMatchObject({ SHIELD: 1 });
  });

  it("drops one random normal die into a uniformly selected empty slot on each board", () => {
    const state = activeState();
    const dropped = applyCommand(
      state,
      "A",
      { type: "USE_DROP_ITEM" },
      context({ indexes: [6, 14], rolls: [2, 5] }),
    );

    expect(dropped.state.boards.A?.[1]).toMatchObject([
      { face: 2, kind: "NORMAL", createdBy: "A" },
    ]);
    expect(dropped.state.boards.B?.[2]).toMatchObject([
      { face: 5, kind: "NORMAL", createdBy: "A" },
    ]);
    expect(dropped.state.pending).toEqual(state.pending);
    expect(dropped.state.inventory.A).toEqual(inventory({ DROP: 0 }));
    expect(dropped.state.itemUsedThisTurn).toBe(true);
    expect(dropped.events).toMatchObject([
      {
        type: "DICE_DROPPED",
        playerId: "A",
        placements: [
          { boardOwnerPlayerId: "A", lane: 1, die: { face: 2 } },
          { boardOwnerPlayerId: "B", lane: 2, die: { face: 5 } },
        ],
      },
    ]);
  });

  it("resolves both random drops before finishing when they fill both boards", () => {
    const state = activeState({
      boards: {
        A: board(oneLane("a-1"), oneLane("a-2"), oneLane("a-3", 4)),
        B: board(
          oneLane("b-1", 5, "B"),
          oneLane("b-2", 5, "B"),
          oneLane("b-3", 4, "B"),
        ),
      },
    });
    const dropped = applyCommand(
      state,
      "A",
      { type: "USE_DROP_ITEM" },
      context({ indexes: [0, 0], rolls: [2, 3] }),
    );

    expect(dropped.state.boards.A?.[2]).toHaveLength(5);
    expect(dropped.state.boards.B?.[2]).toHaveLength(5);
    expect(dropped.state.phase).toBe("FINISHED");
    expect(dropped.state.pending).toBeNull();
    expect(dropped.events.map((event) => event.type)).toEqual([
      "DICE_DROPPED",
      "GAME_FINISHED",
    ]);
  });

  it("destroys a selected normal die on either board and excludes shields", () => {
    const state = activeState({
      inventory: {
        A: inventory({ REROLL: 0 }),
        B: inventory(),
      },
      boards: {
        A: board(
          [
            die("own-shield", 2, "SHIELD", "A"),
            die("own-normal", 3, "NORMAL", "A"),
          ],
          [],
          [],
        ),
        B: board([die("opponent-normal", 6, "NORMAL", "B")], [], []),
      },
    });

    const legal = getLegalActions(state, "A");
    expect(legal.canUseRerollItem).toBe(false);
    expect(legal.destroyItemTargets.map((target) => target.dieId).sort()).toEqual([
      "opponent-normal",
      "own-normal",
    ]);
    expect(() =>
      applyCommand(
        state,
        "A",
        {
          type: "USE_DESTROY_ITEM",
          boardOwnerPlayerId: "A",
          lane: 0,
          dieId: "own-shield",
        },
        context(),
      ),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_ITEM_TARGET",
      details: expect.objectContaining({ reason: "DIE_IS_PROTECTED" }),
    }));

    const destroyed = applyCommand(
      state,
      "A",
      {
        type: "USE_DESTROY_ITEM",
        boardOwnerPlayerId: "B",
        lane: 0,
        dieId: "opponent-normal",
      },
      context(),
    );
    expect(destroyed.state.boards.B?.[0]).toEqual([]);
    expect(destroyed.state.pending).toEqual(state.pending);
    expect(destroyed.state.inventory.A).toEqual(inventory({
      REROLL: 0,
      DESTROY: 0,
    }));
    expect(destroyed.events).toMatchObject([
      {
        type: "DIE_DESTROYED",
        playerId: "A",
        boardOwnerPlayerId: "B",
        die: { id: "opponent-normal", face: 6 },
      },
    ]);
  });

  it.each([
    ["ODD", 3, 1, 5],
    ["EVEN", 3, 1, 4],
  ] as const)(
    "changes the current die to a different random %s face without ending the turn",
    (parity, currentFace, index, expectedFace) => {
      const state = activeState({
        pendingFace: currentFace,
        boards: {
          A: board([], [], []),
          B: board([die("new-attack", expectedFace, "NORMAL", "B")], [], []),
        },
      });
      const changed = applyCommand(
        state,
        "A",
        { type: "USE_PARITY_ITEM", parity },
        context({ indexes: [index] }),
      );

      expect(changed.state.pending).toMatchObject({
        source: "TURN",
        original: {
          id: "pending",
          face: expectedFace,
          kind: "NORMAL",
          createdBy: "A",
        },
      });
      expect(changed.state.inventory.A).toEqual(inventory({ [parity]: 0 }));
      expect(changed.state.currentPlayerId).toBe("A");
      expect(getLegalActions(changed.state, "A").alkkagiLanes).toEqual([0]);
      expect(changed.events).toMatchObject([
        {
          type: "TURN_DIE_PARITY_CHANGED",
          playerId: "A",
          parity,
          previousDie: { face: currentFace },
          die: { face: expectedFace },
        },
      ]);
    },
  );

  it("does not allow parity items to modify a shield turn die", () => {
    const state = activeState({ pendingKind: "SHIELD" });
    const legal = getLegalActions(state, "A");

    expect(legal.canUseOddItem).toBe(false);
    expect(legal.canUseEvenItem).toBe(false);
    expect(() =>
      applyCommand(
        state,
        "A",
        { type: "USE_PARITY_ITEM", parity: "ODD" },
        context({ indexes: [0] }),
      ),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_ITEM_TARGET",
      details: expect.objectContaining({ reason: "DIE_IS_PROTECTED" }),
    }));
    expect(state.inventory.A).toEqual(inventory());
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
      canUseShieldItem: false,
      canUseDropItem: false,
      canUseDestroyItem: false,
      canUseOddItem: false,
      canUseEvenItem: false,
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
      canUseShieldItem: true,
      canUseDropItem: true,
      canUseDestroyItem: true,
      canUseOddItem: true,
      canUseEvenItem: true,
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
    expect(state.inventory.A).toEqual(inventory());
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
      canUseShieldItem: true,
      canUseDropItem: true,
      canUseDestroyItem: true,
      canUseOddItem: true,
      canUseEvenItem: true,
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
