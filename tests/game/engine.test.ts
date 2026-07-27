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
  SWAP: 0,
  REROLL: 0,
  SHIELD: 1,
  DROP: 0,
  DESTROY: 1,
  TURN_REROLL: 0,
  ODD: 1,
  EVEN: 1,
};

const STOCKED_INVENTORY: ItemInventory = {
  SWAP: 1,
  REROLL: 1,
  SHIELD: 1,
  DROP: 1,
  DESTROY: 1,
  TURN_REROLL: 0,
  ODD: 1,
  EVEN: 1,
};

function inventory(overrides: Partial<ItemInventory> = {}): ItemInventory {
  return { ...STOCKED_INVENTORY, ...overrides };
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

  it("starts with a server-selected player, opening shield, and one placement mission", () => {
    const transition = createGame(
      ["A", "B"],
      context({ firstPlayer: "B", rolls: [4], indexes: [2, 0] }),
    );

    expect(transition.state.firstPlayerId).toBe("B");
    expect(transition.state.currentPlayerId).toBe("B");
    expect(transition.state.pending).toMatchObject({
      source: "TURN",
      original: { face: 4, kind: "SHIELD", createdBy: "B" },
    });
    expect(transition.state.inventory).toEqual({
      A: STARTING_INVENTORY,
      B: STARTING_INVENTORY,
    });
    expect(transition.state.itemUsedThisTurn).toBe(false);
    expect(transition.state.finalTurnPlayerId).toBeNull();
    expect(transition.state.lineMission).toEqual({
      kind: "PLACEMENT_COUNT",
      lane: 2,
      threshold: 3,
      rewardItems: { A: null, B: null },
    });
    expect(transition.events.map((event) => event.type)).toEqual([
      "GAME_STARTED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);
  });

  it("selects a score mission as an exclusive alternative for a game", () => {
    const transition = createGame(
      ["A", "B"],
      context({ rolls: [2], indexes: [1, 1] }),
    );

    expect(transition.state.lineMission).toEqual({
      kind: "SCORE_OVER",
      lane: 1,
      threshold: 15,
      rewardItems: { A: null, B: null },
    });
    expect(Object.keys(transition.state)).not.toContain("lineReward");
    expect(Object.keys(transition.state)).not.toContain("lineScoreReward");
  });

  it("awards each player independently for reaching three dice in the mission lane", () => {
    const state = activeState({
      boards: {
        A: board([], [die("a-1", 2), die("a-2", 4)], []),
        B: board([], [die("b-1", 1, "NORMAL", "B"), die("b-2", 3, "NORMAL", "B")], []),
      },
      lineMission: {
        kind: "PLACEMENT_COUNT",
        lane: 1,
        threshold: 3,
        rewardItems: { A: null, B: null },
      },
    });
    const engineContext = context({ rolls: [2, 3], indexes: [5, 6] });
    const awardedToA = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 1 },
      engineContext,
    );

    expect(awardedToA.state.lineMission).toEqual({
      kind: "PLACEMENT_COUNT",
      lane: 1,
      threshold: 3,
      rewardItems: { A: "TURN_REROLL", B: null },
    });
    expect(awardedToA.state.inventory.A?.TURN_REROLL).toBe(1);
    expect(awardedToA.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "LINE_MISSION_REWARD_CLAIMED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);
    expect(awardedToA.events[1]).toEqual({
      type: "LINE_MISSION_REWARD_CLAIMED",
      playerId: "A",
      lane: 1,
      missionKind: "PLACEMENT_COUNT",
      threshold: 3,
      itemType: "TURN_REROLL",
    });

    const awardedToB = applyCommand(
      awardedToA.state,
      "B",
      { type: "PLACE_OWN", lane: 1 },
      engineContext,
    );
    expect(awardedToB.state.lineMission.rewardItems).toEqual({
      A: "TURN_REROLL",
      B: "ODD",
    });
    expect(awardedToB.state.inventory.B?.ODD).toBe(2);
    expect(awardedToB.events[1]).toMatchObject({
      type: "LINE_MISSION_REWARD_CLAIMED",
      playerId: "B",
      missionKind: "PLACEMENT_COUNT",
      itemType: "ODD",
    });
  });

  it("does not award a placement mission before the threshold or in another lane", () => {
    const state = activeState({
      boards: {
        A: board([], [], [die("a-1", 2)]),
        B: board([], [], []),
      },
      lineMission: {
        kind: "PLACEMENT_COUNT",
        lane: 2,
        threshold: 3,
        rewardItems: { A: null, B: null },
      },
    });
    const placedElsewhere = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 0 },
      context({ rolls: [2] }),
    );

    expect(placedElsewhere.state.lineMission.rewardItems.A).toBeNull();
    expect(placedElsewhere.state.inventory.A).toEqual(state.inventory.A);
    expect(
      placedElsewhere.events.some(
        (event) => event.type === "LINE_MISSION_REWARD_CLAIMED",
      ),
    ).toBe(false);
  });

  it("never awards the same player twice for one line mission", () => {
    const state = activeState({
      boards: {
        A: board([die("a-1", 2), die("a-2", 4)], [], []),
        B: board([], [], []),
      },
      lineMission: {
        kind: "PLACEMENT_COUNT",
        lane: 0,
        threshold: 3,
        rewardItems: { A: "SWAP", B: null },
      },
    });
    const placed = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 0 },
      context({ rolls: [2], indexes: [7] }),
    );

    expect(placed.state.lineMission.rewardItems).toEqual({
      A: "SWAP",
      B: null,
    });
    expect(placed.state.inventory.A).toEqual(state.inventory.A);
    expect(
      placed.events.some(
        (event) => event.type === "LINE_MISSION_REWARD_CLAIMED",
      ),
    ).toBe(false);
  });

  it("requires more than 15 points and lets both players earn the score mission", () => {
    const state = activeState({
      pendingFace: 5,
      boards: {
        A: board([], [die("a-1", 5)], []),
        B: board([], [die("b-1", 6, "NORMAL", "B")], []),
      },
      lineMission: {
        kind: "SCORE_OVER",
        lane: 1,
        threshold: 15,
        rewardItems: { A: null, B: null },
      },
    });
    const engineContext = context({
      rolls: [6, 2, 3],
      indexes: [5, 6],
    });
    const exactlyFifteen = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 1 },
      engineContext,
    );

    expect(exactlyFifteen.state.boards.A?.[1]).toHaveLength(2);
    expect(exactlyFifteen.state.lineMission.rewardItems.A).toBeNull();
    expect(exactlyFifteen.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);

    const awardedToB = applyCommand(
      exactlyFifteen.state,
      "B",
      { type: "PLACE_OWN", lane: 1 },
      engineContext,
    );
    expect(awardedToB.state.lineMission.rewardItems).toEqual({
      A: null,
      B: "TURN_REROLL",
    });
    expect(awardedToB.events[1]).toMatchObject({
      type: "LINE_MISSION_REWARD_CLAIMED",
      playerId: "B",
      missionKind: "SCORE_OVER",
      threshold: 15,
    });

    const awardedToA = applyCommand(
      awardedToB.state,
      "A",
      { type: "PLACE_OWN", lane: 1 },
      engineContext,
    );
    expect(awardedToA.state.lineMission.rewardItems).toEqual({
      A: "ODD",
      B: "TURN_REROLL",
    });
    expect(awardedToA.state.inventory.A?.ODD).toBe(2);
  });

  it("does not award a score mission outside the mission lane", () => {
    const state = activeState({
      pendingFace: 5,
      boards: {
        A: board([die("a-off-target", 5)], [die("a-target", 4)], []),
        B: board([], [], []),
      },
      lineMission: {
        kind: "SCORE_OVER",
        lane: 1,
        threshold: 15,
        rewardItems: { A: null, B: null },
      },
    });
    const placedOutside = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 0 },
      context({ rolls: [2] }),
    );

    expect(placedOutside.state.lineMission.rewardItems.A).toBeNull();
    expect(
      placedOutside.events.some(
        (event) => event.type === "LINE_MISSION_REWARD_CLAIMED",
      ),
    ).toBe(false);
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

  it("gives the second player one final turn after the first player fills 15 slots", () => {
    const state = activeState({
      currentPlayerId: "A",
      pendingFace: 1,
      boards: {
        A: board(
          oneLane("a-lane-1"),
          oneLane("a-lane-2"),
          oneLane("a-lane-3", 4),
        ),
        B: board(
          [die("b-6-1", 6, "NORMAL", "B"), die("b-6-2", 6, "NORMAL", "B")],
          [die("b-6-3", 6, "NORMAL", "B"), die("b-6-4", 6, "NORMAL", "B")],
          [],
        ),
      },
    });
    const engineContext = context({ rolls: [4] });
    const completedByFirst = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 2 },
      engineContext,
    );

    expect(completedByFirst.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "B",
      finalTurnPlayerId: "B",
      result: null,
      pending: { source: "TURN", original: { face: 4, createdBy: "B" } },
    });
    expect(completedByFirst.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);

    const finished = applyCommand(
      completedByFirst.state,
      "B",
      { type: "PLACE_OWN", lane: 2 },
      engineContext,
    );
    expect(finished.state.phase).toBe("FINISHED");
    expect(finished.state.pending).toBeNull();
    expect(finished.state.finalTurnPlayerId).toBeNull();
    expect(finished.state.result).toMatchObject({
      reason: "NORMAL",
      winnerPlayerId: "B",
    });
    expect(finished.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "GAME_FINISHED",
    ]);
  });

  it("uses the randomized first player to identify who receives the final turn", () => {
    const state = activeState({
      firstPlayerId: "B",
      currentPlayerId: "B",
      pendingFace: 2,
      boards: {
        A: board([], [], []),
        B: board(
          oneLane("b-lane-1", 5, "B"),
          oneLane("b-lane-2", 5, "B"),
          oneLane("b-lane-3", 4, "B"),
        ),
      },
    });
    const completedByFirst = applyCommand(
      state,
      "B",
      { type: "PLACE_OWN", lane: 2 },
      context({ rolls: [5] }),
    );

    expect(completedByFirst.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "A",
      finalTurnPlayerId: "A",
      pending: { source: "TURN", original: { face: 5, createdBy: "A" } },
    });
  });

  it("finishes when the second player completes the last turn of the round", () => {
    const state = activeState({
      currentPlayerId: "B",
      pendingFace: 1,
      boards: {
        A: board(
          [die("a-6-1", 6), die("a-6-2", 6)],
          [die("a-6-3", 6), die("a-6-4", 6)],
          [],
        ),
        B: board(
          oneLane("b-lane-1", 5, "B"),
          oneLane("b-lane-2", 5, "B"),
          oneLane("b-lane-3", 4, "B"),
        ),
      },
    });
    const completedBySecond = applyCommand(
      state,
      "B",
      { type: "PLACE_OWN", lane: 2 },
      context(),
    );

    expect(completedBySecond.state.phase).toBe("FINISHED");
    expect(completedBySecond.state.finalTurnPlayerId).toBeNull();
    expect(completedBySecond.state.result).toMatchObject({
      reason: "NORMAL",
      winnerPlayerId: "A",
    });
    expect(completedBySecond.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "GAME_FINISHED",
    ]);
  });

  it("starts the second player's final turn when a bonus shield fills the first player's board", () => {
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
    const engineContext = context({ rolls: [2, 4] });
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
    expect(completed.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "B",
      finalTurnPlayerId: "B",
      pending: { source: "TURN", original: { face: 4, createdBy: "B" } },
    });
    expect(completed.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);
  });

  it("awards the board owner when a bonus shield completes a placement mission", () => {
    const state = activeState({
      pendingFace: 6,
      boards: {
        A: board([], [], []),
        B: board(
          [die("attack-target", 6, "NORMAL", "B")],
          [
            die("reward-1", 2, "NORMAL", "B"),
            die("reward-2", 4, "NORMAL", "B"),
          ],
          [],
        ),
      },
      lineMission: {
        kind: "PLACEMENT_COUNT",
        lane: 1,
        threshold: 3,
        rewardItems: { A: null, B: null },
      },
    });
    const engineContext = context({ rolls: [4, 2], indexes: [7] });
    const attacked = applyCommand(
      state,
      "A",
      { type: "ALKKAGI", lane: 0 },
      engineContext,
    );
    const awarded = applyCommand(
      attacked.state,
      "A",
      { type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: "B", lane: 1 },
      engineContext,
    );

    expect(awarded.state.lineMission.rewardItems.B).toBe("EVEN");
    expect(awarded.state.inventory.B?.EVEN).toBe(2);
    expect(awarded.events[1]).toMatchObject({
      type: "LINE_MISSION_REWARD_CLAIMED",
      playerId: "B",
      lane: 1,
      missionKind: "PLACEMENT_COUNT",
      itemType: "EVEN",
    });
  });

  it("awards the board owner when a bonus shield exceeds 15 points", () => {
    const state = activeState({
      pendingFace: 6,
      boards: {
        A: board([], [], []),
        B: board(
          [die("attack-target", 6, "NORMAL", "B")],
          [die("score-1", 6, "NORMAL", "B")],
          [],
        ),
      },
      lineMission: {
        kind: "SCORE_OVER",
        lane: 1,
        threshold: 15,
        rewardItems: { A: null, B: null },
      },
    });
    const engineContext = context({ rolls: [6, 2], indexes: [7] });
    const attacked = applyCommand(
      state,
      "A",
      { type: "ALKKAGI", lane: 0 },
      engineContext,
    );
    const awarded = applyCommand(
      attacked.state,
      "A",
      { type: "PLACE_BONUS_SHIELD", boardOwnerPlayerId: "B", lane: 1 },
      engineContext,
    );

    expect(awarded.state.lineMission.rewardItems.B).toBe("EVEN");
    expect(awarded.state.inventory.B?.EVEN).toBe(2);
    expect(awarded.events[1]).toMatchObject({
      type: "LINE_MISSION_REWARD_CLAIMED",
      playerId: "B",
      lane: 1,
      missionKind: "SCORE_OVER",
      threshold: 15,
      itemType: "EVEN",
    });
  });

  it("finishes without another turn when the second player already held", () => {
    const state = activeState({
      held: { A: false, B: true },
      currentPlayerId: "A",
      pendingFace: 6,
      boards: {
        A: board(
          fullLane("a-lane-1"),
          fullLane("a-lane-2"),
          [
            die("a-lane-3-1", 1),
            die("a-lane-3-2", 2),
            die("a-lane-3-3", 3),
            die("a-lane-3-4", 4),
          ],
        ),
        B: board([die("b", 1, "NORMAL", "B")], [], []),
      },
    });

    expect(isEligible(state, "B")).toBe(false);
    const finished = applyCommand(
      state,
      "A",
      { type: "PLACE_OWN", lane: 2 },
      context(),
    );
    expect(finished.state.phase).toBe("FINISHED");
    expect(finished.state.finalTurnPlayerId).toBeNull();
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

  it("swaps only the selected dice without reordering their lane neighbors", () => {
    const state = activeState({
      boards: {
        A: board(
          [die("own-1", 1, "NORMAL", "A"), die("own-2", 2, "NORMAL", "A")],
          [],
          [],
        ),
        B: board(
          [
            die("opponent-1", 3, "NORMAL", "B"),
            die("opponent-shield", 4, "SHIELD", "B"),
          ],
          [],
          [],
        ),
      },
    });

    const swapped = applyCommand(
      state,
      "A",
      {
        type: "USE_SWAP_ITEM",
        lane: 0,
        ownDieId: "own-2",
        opponentDieId: "opponent-1",
      },
      context(),
    );

    expect(swapped.state.boards.A?.[0].map((die) => die.id)).toEqual([
      "own-1",
      "opponent-1",
    ]);
    expect(swapped.state.boards.B?.[0].map((die) => die.id)).toEqual([
      "own-2",
      "opponent-shield",
    ]);
    expect(swapped.events).toMatchObject([
      {
        type: "DICE_SWAPPED",
        playerId: "A",
        ownDie: { id: "own-2" },
        opponentDie: { id: "opponent-1" },
      },
    ]);
  });

  it("awards a score mission when a swap pushes a board over 15 points", () => {
    const state = activeState({
      boards: {
        A: board([die("own-6", 6), die("own-4", 4)], [], []),
        B: board(
          [die("opponent-6", 6, "NORMAL", "B"), die("opponent-1", 1, "NORMAL", "B")],
          [],
          [],
        ),
      },
      lineMission: {
        kind: "SCORE_OVER",
        lane: 0,
        threshold: 15,
        rewardItems: { A: null, B: null },
      },
    });
    const swapped = applyCommand(
      state,
      "A",
      {
        type: "USE_SWAP_ITEM",
        lane: 0,
        ownDieId: "own-4",
        opponentDieId: "opponent-6",
      },
      context({ indexes: [5] }),
    );

    expect(swapped.state.lineMission.rewardItems.A).toBe("TURN_REROLL");
    expect(swapped.state.inventory.A?.TURN_REROLL).toBe(1);
    expect(swapped.events.map((event) => event.type)).toEqual([
      "DICE_SWAPPED",
      "LINE_MISSION_REWARD_CLAIMED",
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

  it("awards the board owner when a reroll pushes it over 15 points", () => {
    const state = activeState({
      boards: {
        A: board([], [], []),
        B: board(
          [],
          [],
          [die("matching", 6, "NORMAL", "B"), die("target", 4, "NORMAL", "B")],
        ),
      },
      lineMission: {
        kind: "SCORE_OVER",
        lane: 2,
        threshold: 15,
        rewardItems: { A: null, B: null },
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
      context({ differentRolls: [6], indexes: [5] }),
    );

    expect(rerolled.state.lineMission.rewardItems.B).toBe("TURN_REROLL");
    expect(rerolled.state.inventory.B?.TURN_REROLL).toBe(1);
    expect(rerolled.events.map((event) => event.type)).toEqual([
      "DIE_REROLLED",
      "LINE_MISSION_REWARD_CLAIMED",
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

  it("keeps the drop turn active and lets the second player finish even when both boards fill", () => {
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
    const engineContext = context({
      indexes: [0, 0],
      rolls: [2, 3, 4],
    });
    const dropped = applyCommand(
      state,
      "A",
      { type: "USE_DROP_ITEM" },
      engineContext,
    );

    expect(dropped.state.boards.A?.[2]).toHaveLength(5);
    expect(dropped.state.boards.B?.[2]).toHaveLength(5);
    expect(dropped.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "A",
      finalTurnPlayerId: "B",
      itemUsedThisTurn: true,
    });
    expect(dropped.state.pending).toEqual(state.pending);
    expect(dropped.events.map((event) => event.type)).toEqual(["DICE_DROPPED"]);

    const firstTurnEnded = applyCommand(
      dropped.state,
      "A",
      { type: "HOLD" },
      engineContext,
    );
    expect(firstTurnEnded.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "B",
      finalTurnPlayerId: "B",
      pending: { source: "TURN", original: { face: 4, createdBy: "B" } },
    });
    expect(firstTurnEnded.events.map((event) => event.type)).toEqual([
      "DIE_SPENT",
      "PLAYER_HELD",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);

    const finished = applyCommand(
      firstTurnEnded.state,
      "B",
      { type: "HOLD" },
      engineContext,
    );
    expect(finished.state.phase).toBe("FINISHED");
    expect(finished.state.finalTurnPlayerId).toBeNull();
    expect(finished.events.map((event) => event.type)).toEqual([
      "DIE_SPENT",
      "PLAYER_HELD",
      "GAME_FINISHED",
    ]);
  });

  it("lets the second player finish the current turn when its drop fills a board", () => {
    const state = activeState({
      currentPlayerId: "B",
      boards: {
        A: board(oneLane("a-1"), oneLane("a-2"), oneLane("a-3", 4)),
        B: board(
          oneLane("b-1", 5, "B"),
          oneLane("b-2", 5, "B"),
          oneLane("b-3", 4, "B"),
        ),
      },
    });
    const engineContext = context({ indexes: [0, 0], rolls: [2, 3] });
    const dropped = applyCommand(
      state,
      "B",
      { type: "USE_DROP_ITEM" },
      engineContext,
    );

    expect(dropped.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "B",
      finalTurnPlayerId: "B",
      result: null,
    });
    expect(dropped.state.pending).toEqual(state.pending);

    const finished = applyCommand(
      dropped.state,
      "B",
      { type: "HOLD" },
      engineContext,
    );
    expect(finished.state.phase).toBe("FINISHED");
    expect(finished.events.at(-1)?.type).toBe("GAME_FINISHED");
  });

  it("finishes after the final turn even if destruction reopens the completed board", () => {
    const state = activeState({
      currentPlayerId: "B",
      pendingFace: 4,
      finalTurnPlayerId: "B",
      boards: {
        A: board(oneLane("a-1"), oneLane("a-2"), oneLane("a-3")),
        B: board([], [], []),
      },
    });
    const engineContext = context();
    const destroyed = applyCommand(
      state,
      "B",
      {
        type: "USE_DESTROY_ITEM",
        boardOwnerPlayerId: "A",
        lane: 2,
        dieId: "a-3-5",
      },
      engineContext,
    );

    expect(destroyed.state.boards.A?.[2]).toHaveLength(4);
    expect(destroyed.state).toMatchObject({
      phase: "TURN_ACTION",
      currentPlayerId: "B",
      finalTurnPlayerId: "B",
      result: null,
    });

    const finished = applyCommand(
      destroyed.state,
      "B",
      { type: "PLACE_OWN", lane: 0 },
      engineContext,
    );
    expect(finished.state.phase).toBe("FINISHED");
    expect(finished.state.finalTurnPlayerId).toBeNull();
    expect(finished.events.map((event) => event.type)).toEqual([
      "DIE_PLACED",
      "GAME_FINISHED",
    ]);
  });

  it("awards both players when one drop completes both placement missions", () => {
    const state = activeState({
      boards: {
        A: board([die("a-1", 1), die("a-2", 2)], [], []),
        B: board(
          [
            die("b-1", 3, "NORMAL", "B"),
            die("b-2", 4, "NORMAL", "B"),
          ],
          [],
          [],
        ),
      },
      lineMission: {
        kind: "PLACEMENT_COUNT",
        lane: 0,
        threshold: 3,
        rewardItems: { A: null, B: null },
      },
    });
    const dropped = applyCommand(
      state,
      "A",
      { type: "USE_DROP_ITEM" },
      context({ indexes: [0, 0, 1, 0], rolls: [2, 3] }),
    );

    expect(dropped.state.boards.A?.[0]).toHaveLength(3);
    expect(dropped.state.boards.B?.[0]).toHaveLength(3);
    expect(dropped.state.lineMission.rewardItems).toEqual({
      A: "REROLL",
      B: "SWAP",
    });
    expect(dropped.state.inventory.A?.DROP).toBe(0);
    expect(dropped.state.inventory.A?.REROLL).toBe(2);
    expect(dropped.state.inventory.B?.SWAP).toBe(2);
    expect(dropped.events.map((event) => event.type)).toEqual([
      "DICE_DROPPED",
      "LINE_MISSION_REWARD_CLAIMED",
      "LINE_MISSION_REWARD_CLAIMED",
    ]);
  });

  it("awards both players when one drop completes both score missions", () => {
    const state = activeState({
      boards: {
        A: board([die("a-6", 6)], [], []),
        B: board([die("b-6", 6, "NORMAL", "B")], [], []),
      },
      lineMission: {
        kind: "SCORE_OVER",
        lane: 0,
        threshold: 15,
        rewardItems: { A: null, B: null },
      },
    });
    const dropped = applyCommand(
      state,
      "A",
      { type: "USE_DROP_ITEM" },
      context({ indexes: [0, 0, 1, 0], rolls: [6, 6] }),
    );

    expect(dropped.state.lineMission.rewardItems).toEqual({
      A: "REROLL",
      B: "SWAP",
    });
    expect(dropped.state.inventory.A?.DROP).toBe(0);
    expect(dropped.state.inventory.A?.REROLL).toBe(2);
    expect(dropped.state.inventory.B?.SWAP).toBe(2);
    expect(dropped.events.map((event) => event.type)).toEqual([
      "DICE_DROPPED",
      "LINE_MISSION_REWARD_CLAIMED",
      "LINE_MISSION_REWARD_CLAIMED",
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

  it("rerolls the current normal die to a different face without ending the turn", () => {
    const state = activeState({
      pendingFace: 2,
      inventory: {
        A: inventory({ TURN_REROLL: 1 }),
        B: inventory(),
      },
      boards: {
        A: board([], [], []),
        B: board([die("new-attack", 5, "NORMAL", "B")], [], []),
      },
    });
    expect(getLegalActions(state, "A").canUseTurnRerollItem).toBe(true);

    const rerolled = applyCommand(
      state,
      "A",
      { type: "USE_TURN_REROLL_ITEM" },
      context({ differentRolls: [5] }),
    );

    expect(rerolled.state.pending).toMatchObject({
      source: "TURN",
      original: {
        id: "pending",
        face: 5,
        kind: "NORMAL",
        createdBy: "A",
      },
    });
    expect(rerolled.state.inventory.A).toEqual(inventory({ TURN_REROLL: 0 }));
    expect(rerolled.state.currentPlayerId).toBe("A");
    expect(rerolled.state.itemUsedThisTurn).toBe(true);
    expect(getLegalActions(rerolled.state, "A").alkkagiLanes).toEqual([0]);
    expect(rerolled.events).toMatchObject([
      {
        type: "TURN_DIE_REROLLED",
        playerId: "A",
        previousDie: { face: 2 },
        die: { face: 5 },
      },
    ]);
  });

  it("does not allow a turn reroll item to modify a shield die", () => {
    const state = activeState({
      pendingKind: "SHIELD",
      inventory: {
        A: inventory({ TURN_REROLL: 1 }),
        B: inventory(),
      },
    });

    expect(getLegalActions(state, "A").canUseTurnRerollItem).toBe(false);
    expect(() =>
      applyCommand(
        state,
        "A",
        { type: "USE_TURN_REROLL_ITEM" },
        context({ differentRolls: [3] }),
      ),
    ).toThrowError(expect.objectContaining({
      code: "INVALID_ITEM_TARGET",
      details: expect.objectContaining({ reason: "DIE_IS_PROTECTED" }),
    }));
    expect(state.inventory.A).toEqual(inventory({ TURN_REROLL: 1 }));
    expect(state.itemUsedThisTurn).toBe(false);
  });

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
      canUseTurnRerollItem: false,
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
      canUseTurnRerollItem: false,
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
      canUseTurnRerollItem: false,
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
