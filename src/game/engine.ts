import { RuleError } from "./errors";
import {
  BOARD_CAPACITY,
  ITEM_TYPES,
  LANE_CAPACITY,
  LANE_COUNT,
  LINE_MISSION_KINDS,
  LINE_PLACEMENT_MISSION_THRESHOLD,
  LINE_SCORE_MISSION_THRESHOLD,
  STARTING_ITEM_COUNT,
  STARTING_ITEM_TYPES,
} from "./constants";
import {
  boardOf,
  calculateResult,
  countDice,
  createEmptyBoard,
  isEligible,
  laneIndexes,
  opponentOf,
  scoreBoard,
  scoreLane,
} from "./scoring";
import type {
  Board,
  Die,
  DieFace,
  DieKind,
  DieParity,
  DroppedDiePlacement,
  EngineContext,
  GameCommand,
  GameEvent,
  GameState,
  ItemInventory,
  ItemType,
  LaneIndex,
  LegalActions,
  PlayerId,
  Transition,
} from "./types";

export function isDieEffectImmune(die: Die): boolean {
  return die.kind === "SHIELD";
}

const PARITY_FACES: Record<DieParity, readonly DieFace[]> = {
  ODD: [1, 3, 5],
  EVEN: [2, 4, 6],
};

function pickRandom<T>(
  values: readonly T[],
  context: EngineContext,
  emptyMessage: string,
): T {
  if (values.length === 0) {
    throw new RuleError("INVARIANT_VIOLATION", emptyMessage);
  }
  const index = context.rng.pickIndex(values.length);
  const value = values[index];
  if (!Number.isInteger(index) || index < 0 || value === undefined) {
    throw new RuleError(
      "INVARIANT_VIOLATION",
      `RNG returned invalid index ${index} for ${values.length} candidates.`,
    );
  }
  return value;
}

function availableSlotLanes(board: Board): LaneIndex[] {
  return laneIndexes().flatMap((lane) =>
    Array<LaneIndex>(LANE_CAPACITY - board[lane].length).fill(lane),
  );
}

function createStartingInventory(): ItemInventory {
  const inventory = Object.fromEntries(
    ITEM_TYPES.map((itemType) => [itemType, 0]),
  ) as ItemInventory;
  for (const itemType of STARTING_ITEM_TYPES) {
    inventory[itemType] = STARTING_ITEM_COUNT;
  }
  return inventory;
}

function dropRandomDie(
  state: GameState,
  boardOwnerPlayerId: PlayerId,
  createdByPlayerId: PlayerId,
  context: EngineContext,
): DroppedDiePlacement {
  const board = boardOf(state, boardOwnerPlayerId);
  const lane = pickRandom(
    availableSlotLanes(board),
    context,
    `No empty slot is available for ${boardOwnerPlayerId}.`,
  );
  const die = createDie(
    createdByPlayerId,
    context.rng.rollD6(),
    "NORMAL",
    context,
  );
  board[lane].push(die);
  return { boardOwnerPlayerId, lane, die };
}

function createDie(
  playerId: PlayerId,
  face: DieFace,
  kind: DieKind,
  context: EngineContext,
): Die {
  return {
    id: context.ids.next("die"),
    face,
    kind,
    createdBy: playerId,
  };
}

function assertPlayer(state: GameState, playerId: PlayerId): void {
  if (!state.players.includes(playerId)) {
    throw new RuleError("NOT_A_PLAYER", "Player does not belong to this game.");
  }
}

function assertCurrentPlayer(state: GameState, playerId: PlayerId): void {
  if (state.currentPlayerId !== playerId) {
    throw new RuleError("NOT_YOUR_TURN", "It is not this player's turn.");
  }
}

function assertLane(lane: number): asserts lane is LaneIndex {
  if (!Number.isInteger(lane) || lane < 0 || lane >= LANE_COUNT) {
    throw new RuleError(
      "INVALID_LANE",
      `Lane must be between 0 and ${LANE_COUNT - 1}.`,
    );
  }
}

function assertPhase(state: GameState, phases: GameState["phase"][]): void {
  if (!phases.includes(state.phase)) {
    throw new RuleError(
      "INVALID_PHASE",
      `Command is not allowed during ${state.phase}.`,
      { phase: state.phase },
    );
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new RuleError("INVARIANT_VIOLATION", message);
  }
}

function rollTurnDie(
  state: GameState,
  playerId: PlayerId,
  context: EngineContext,
  events: GameEvent[],
): void {
  state.turnNumber += 1;
  const die = createDie(playerId, context.rng.rollD6(), "NORMAL", context);
  state.currentPlayerId = playerId;
  state.phase = "TURN_ACTION";
  state.pending = { source: "TURN", original: die };
  state.itemUsedThisTurn = false;
  events.push({ type: "TURN_STARTED", playerId, turnNumber: state.turnNumber });
  events.push({ type: "DIE_ROLLED", playerId, die, source: "TURN" });
}

function inventoryOf(state: GameState, playerId: PlayerId): ItemInventory {
  const inventory = state.inventory[playerId];
  if (!inventory) {
    throw new RuleError(
      "INVARIANT_VIOLATION",
      `Missing inventory for ${playerId}.`,
    );
  }
  return inventory;
}

function consumeItem(
  state: GameState,
  playerId: PlayerId,
  itemType: ItemType,
): void {
  assertPhase(state, ["TURN_ACTION"]);
  if (state.itemUsedThisTurn) {
    throw new RuleError(
      "ITEM_ALREADY_USED_THIS_TURN",
      "Only one item can be used during a turn.",
    );
  }

  const inventory = inventoryOf(state, playerId);
  if (inventory[itemType] <= 0) {
    throw new RuleError(
      "ITEM_NOT_AVAILABLE",
      `The ${itemType.toLowerCase()} item is no longer available.`,
      { itemType },
    );
  }

  inventory[itemType] -= 1;
  state.itemUsedThisTurn = true;
}

function hasCompletedLineMission(
  state: GameState,
  playerId: PlayerId,
): boolean {
  const mission = state.lineMission;
  const lane = boardOf(state, playerId)[mission.lane];
  return mission.kind === "PLACEMENT_COUNT"
    ? lane.length >= mission.threshold
    : scoreLane(lane) > mission.threshold;
}

function claimLineMissionRewards(
  state: GameState,
  possiblePlayers: readonly PlayerId[],
  context: EngineContext,
  events: GameEvent[],
): void {
  const mission = state.lineMission;
  const possiblePlayerSet = new Set(possiblePlayers);

  for (const playerId of state.players) {
    if (
      !possiblePlayerSet.has(playerId) ||
      mission.rewardItems[playerId] !== null ||
      !hasCompletedLineMission(state, playerId)
    ) {
      continue;
    }

    const itemType = pickRandom(
      ITEM_TYPES,
      context,
      "No item is available for the line mission reward.",
    );
    inventoryOf(state, playerId)[itemType] += 1;
    mission.rewardItems[playerId] = itemType;
    events.push({
      type: "LINE_MISSION_REWARD_CLAIMED",
      playerId,
      lane: mission.lane,
      missionKind: mission.kind,
      threshold: mission.threshold,
      itemType,
    });
  }
}

function finishNormally(state: GameState, events: GameEvent[]): void {
  state.phase = "FINISHED";
  state.pending = null;
  state.finalTurnPlayerId = null;
  state.result = calculateResult(state, "NORMAL");
  events.push({ type: "GAME_FINISHED", result: state.result });
}

function hasCompletedBoard(state: GameState): boolean {
  return state.players.some(
    (playerId) => countDice(boardOf(state, playerId)) >= BOARD_CAPACITY,
  );
}

function startFinalTurnIfNeeded(state: GameState): void {
  if (state.finalTurnPlayerId !== null || !hasCompletedBoard(state)) return;
  state.finalTurnPlayerId = opponentOf(state.players, state.firstPlayerId);
}

function advanceOrFinish(
  state: GameState,
  actorPlayerId: PlayerId,
  context: EngineContext,
  events: GameEvent[],
): void {
  startFinalTurnIfNeeded(state);

  const finalTurnPlayerId = state.finalTurnPlayerId;
  if (finalTurnPlayerId !== null) {
    if (
      actorPlayerId === finalTurnPlayerId ||
      state.held[finalTurnPlayerId]
    ) {
      finishNormally(state, events);
      return;
    }

    rollTurnDie(state, finalTurnPlayerId, context, events);
    return;
  }

  const opponentPlayerId = opponentOf(state.players, actorPlayerId);

  if (isEligible(state, opponentPlayerId)) {
    rollTurnDie(state, opponentPlayerId, context, events);
    return;
  }
  if (isEligible(state, actorPlayerId)) {
    rollTurnDie(state, actorPlayerId, context, events);
    return;
  }
  finishNormally(state, events);
}

function activeTurnDie(state: GameState): Die {
  if (state.pending?.source !== "TURN") {
    throw new RuleError("INVALID_PHASE", "There is no active turn die.");
  }
  return state.pending.original;
}

export function createGame(
  players: [PlayerId, PlayerId],
  context: EngineContext,
): Transition {
  if (players[0] === players[1]) {
    throw new RuleError(
      "INVARIANT_VIOLATION",
      "A game requires two distinct players.",
    );
  }

  const firstPlayerId = context.rng.chooseFirstPlayer(players);
  if (!players.includes(firstPlayerId)) {
    throw new RuleError(
      "INVARIANT_VIOLATION",
      "RNG returned a player outside the game.",
    );
  }

  const openingDie = createDie(
    firstPlayerId,
    context.rng.rollD6(),
    "SHIELD",
    context,
  );
  const missionLane = pickRandom(
    laneIndexes(),
    context,
    "No lane is available for the line mission.",
  );
  const missionKind = pickRandom(
    LINE_MISSION_KINDS,
    context,
    "No line mission kind is available.",
  );
  const state: GameState = {
    schemaVersion: 8,
    gameId: context.ids.next("game"),
    version: 0,
    players,
    firstPlayerId,
    currentPlayerId: firstPlayerId,
    phase: "TURN_ACTION",
    turnNumber: 1,
    boards: {
      [players[0]]: createEmptyBoard(),
      [players[1]]: createEmptyBoard(),
    },
    pending: { source: "TURN", original: openingDie },
    tazzaUsed: {
      [players[0]]: false,
      [players[1]]: false,
    },
    inventory: {
      [players[0]]: createStartingInventory(),
      [players[1]]: createStartingInventory(),
    },
    itemUsedThisTurn: false,
    lineMission: missionKind === "PLACEMENT_COUNT"
      ? {
          kind: missionKind,
          lane: missionLane,
          threshold: LINE_PLACEMENT_MISSION_THRESHOLD,
          rewardItems: { [players[0]]: null, [players[1]]: null },
        }
      : {
          kind: missionKind,
          lane: missionLane,
          threshold: LINE_SCORE_MISSION_THRESHOLD,
          rewardItems: { [players[0]]: null, [players[1]]: null },
        },
    finalTurnPlayerId: null,
    held: {
      [players[0]]: false,
      [players[1]]: false,
    },
    result: null,
  };
  const events: GameEvent[] = [
    { type: "GAME_STARTED", firstPlayerId },
    { type: "TURN_STARTED", playerId: firstPlayerId, turnNumber: 1 },
    {
      type: "DIE_ROLLED",
      playerId: firstPlayerId,
      die: openingDie,
      source: "TURN",
    },
  ];

  assertGameInvariants(state);
  return { state, events };
}

export function applyCommand(
  inputState: GameState,
  actorPlayerId: PlayerId,
  command: GameCommand,
  context: EngineContext,
): Transition {
  assertGameInvariants(inputState);
  assertPlayer(inputState, actorPlayerId);

  if (inputState.phase === "FINISHED") {
    throw new RuleError("GAME_FINISHED", "The game is already finished.");
  }

  const state = structuredClone(inputState);
  const events: GameEvent[] = [];

  if (command.type === "SURRENDER") {
    const winnerPlayerId = opponentOf(state.players, actorPlayerId);
    state.phase = "FINISHED";
    state.pending = null;
    state.finalTurnPlayerId = null;
    state.result = calculateResult(state, "SURRENDER", winnerPlayerId);
    events.push({ type: "PLAYER_SURRENDERED", playerId: actorPlayerId });
    events.push({ type: "GAME_FINISHED", result: state.result });
    state.version += 1;
    assertGameInvariants(state);
    return { state, events };
  }

  assertCurrentPlayer(state, actorPlayerId);

  switch (command.type) {
    case "PLACE_OWN": {
      assertPhase(state, ["TURN_ACTION"]);
      assertLane(command.lane);
      const lane = boardOf(state, actorPlayerId)[command.lane];
      if (lane.length >= LANE_CAPACITY) {
        throw new RuleError("LANE_FULL", "The selected lane is full.");
      }

      const die = activeTurnDie(state);
      lane.push(die);
      state.pending = null;
      events.push({
        type: "DIE_PLACED",
        playerId: actorPlayerId,
        boardOwnerPlayerId: actorPlayerId,
        lane: command.lane,
        die,
      });
      if (command.lane === state.lineMission.lane) {
        claimLineMissionRewards(state, [actorPlayerId], context, events);
      }
      advanceOrFinish(state, actorPlayerId, context, events);
      break;
    }

    case "ALKKAGI": {
      assertPhase(state, ["TURN_ACTION"]);
      assertLane(command.lane);
      const die = activeTurnDie(state);
      const opponentPlayerId = opponentOf(state.players, actorPlayerId);
      const ownBoard = boardOf(state, actorPlayerId);
      const opponentBoard = boardOf(state, opponentPlayerId);
      const ownLane = ownBoard[command.lane];
      const opponentLane = opponentBoard[command.lane];

      if (isDieEffectImmune(die)) {
        throw new RuleError(
          "ALKKAGI_NOT_AVAILABLE",
          "Only a normal turn die can perform alkkagi.",
          { reason: "DIE_IS_SHIELD" },
        );
      }
      if (ownLane.length >= LANE_CAPACITY) {
        throw new RuleError(
          "ALKKAGI_NOT_AVAILABLE",
          "The actor's corresponding lane is full.",
          { reason: "ACTOR_LANE_FULL" },
        );
      }

      const removed = opponentLane.filter(
        (target) => !isDieEffectImmune(target) && target.face === die.face,
      );
      if (removed.length === 0) {
        throw new RuleError(
          "ALKKAGI_NOT_AVAILABLE",
          "There is no matching normal die in the opponent lane.",
          { reason: "NO_MATCHING_NORMAL_DIE" },
        );
      }

      opponentBoard[command.lane] = opponentLane.filter(
        (target) => !removed.some((removedDie) => removedDie.id === target.id),
      );
      events.push({
        type: "DIE_SPENT",
        playerId: actorPlayerId,
        die,
        reason: "ALKKAGI",
      });
      events.push({
        type: "DICE_REMOVED",
        byPlayerId: actorPlayerId,
        fromPlayerId: opponentPlayerId,
        lane: command.lane,
        dice: removed,
      });

      const bonusDie = createDie(
        actorPlayerId,
        context.rng.rollD6(),
        "SHIELD",
        context,
      );
      state.phase = "BONUS_PLACEMENT";
      state.pending = {
        source: "BONUS",
        die: bonusDie,
        attackedPlayerId: opponentPlayerId,
        attackedLane: command.lane,
      };
      events.push({
        type: "DIE_ROLLED",
        playerId: actorPlayerId,
        die: bonusDie,
        source: "BONUS",
      });
      break;
    }

    case "USE_TAZZA": {
      assertPhase(state, ["TURN_ACTION"]);
      if (state.tazzaUsed[actorPlayerId]) {
        throw new RuleError(
          "TAZZA_ALREADY_USED",
          "Tazza has already been used in this game.",
        );
      }

      const original = activeTurnDie(state);
      const candidate = createDie(
        actorPlayerId,
        context.rng.rollDifferentFace(original.face),
        original.kind,
        context,
      );
      if (candidate.face === original.face) {
        throw new RuleError(
          "INVARIANT_VIOLATION",
          "Tazza candidate must differ from the original face.",
        );
      }

      state.tazzaUsed[actorPlayerId] = true;
      state.phase = "TAZZA_CHOICE";
      state.pending = { source: "TURN", original, candidate };
      events.push({ type: "TAZZA_USED", playerId: actorPlayerId });
      break;
    }

    case "USE_SWAP_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      assertLane(command.lane);
      consumeItem(state, actorPlayerId, "SWAP");

      const opponentPlayerId = opponentOf(state.players, actorPlayerId);
      const ownLane = boardOf(state, actorPlayerId)[command.lane];
      const opponentLane = boardOf(state, opponentPlayerId)[command.lane];
      const ownIndex = ownLane.findIndex((die) => die.id === command.ownDieId);
      const opponentIndex = opponentLane.findIndex(
        (die) => die.id === command.opponentDieId,
      );
      if (ownIndex < 0 || opponentIndex < 0) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Swap targets must be placed dice on opposite boards in the same lane.",
          { itemType: "SWAP", lane: command.lane },
        );
      }

      const ownDie = ownLane[ownIndex];
      const opponentDie = opponentLane[opponentIndex];
      invariant(ownDie && opponentDie, "Swap targets disappeared unexpectedly.");
      if (isDieEffectImmune(ownDie) || isDieEffectImmune(opponentDie)) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Shield dice cannot be targeted by swap items.",
          { itemType: "SWAP", lane: command.lane, reason: "DIE_IS_PROTECTED" },
        );
      }
      ownLane[ownIndex] = opponentDie;
      opponentLane[opponentIndex] = ownDie;
      events.push({
        type: "DICE_SWAPPED",
        playerId: actorPlayerId,
        lane: command.lane,
        ownDie,
        opponentDie,
      });
      if (
        state.lineMission.kind === "SCORE_OVER" &&
        command.lane === state.lineMission.lane
      ) {
        claimLineMissionRewards(
          state,
          [actorPlayerId, opponentPlayerId],
          context,
          events,
        );
      }
      break;
    }

    case "USE_REROLL_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      assertLane(command.lane);
      if (!state.players.includes(command.boardOwnerPlayerId)) {
        throw new RuleError(
          "INVALID_BOARD_OWNER",
          "Reroll target must belong to a player in this game.",
        );
      }
      consumeItem(state, actorPlayerId, "REROLL");

      const lane = boardOf(state, command.boardOwnerPlayerId)[command.lane];
      const targetIndex = lane.findIndex((die) => die.id === command.dieId);
      const target = lane[targetIndex];
      if (targetIndex < 0 || !target) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Reroll target must be a placed die in the selected lane.",
          { itemType: "REROLL", lane: command.lane },
        );
      }
      if (isDieEffectImmune(target)) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Shield dice cannot be targeted by reroll items.",
          { itemType: "REROLL", lane: command.lane, reason: "DIE_IS_PROTECTED" },
        );
      }

      const nextFace = context.rng.rollDifferentFace(target.face);
      if (nextFace === target.face) {
        throw new RuleError(
          "INVARIANT_VIOLATION",
          "Reroll item must produce a different face.",
        );
      }
      const rerolledDie = { ...target, face: nextFace };
      lane[targetIndex] = rerolledDie;
      events.push({
        type: "DIE_REROLLED",
        playerId: actorPlayerId,
        boardOwnerPlayerId: command.boardOwnerPlayerId,
        lane: command.lane,
        previousDie: target,
        die: rerolledDie,
      });
      if (
        state.lineMission.kind === "SCORE_OVER" &&
        command.lane === state.lineMission.lane
      ) {
        claimLineMissionRewards(
          state,
          [command.boardOwnerPlayerId],
          context,
          events,
        );
      }
      break;
    }

    case "USE_SHIELD_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      const previousDie = activeTurnDie(state);
      consumeItem(state, actorPlayerId, "SHIELD");
      if (isDieEffectImmune(previousDie)) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "The current die is already protected by a shield.",
          { itemType: "SHIELD", reason: "DIE_IS_PROTECTED" },
        );
      }

      const shieldedDie: Die = { ...previousDie, kind: "SHIELD" };
      state.pending = { source: "TURN", original: shieldedDie };
      events.push({
        type: "DIE_SHIELDED",
        playerId: actorPlayerId,
        previousDie,
        die: shieldedDie,
      });
      break;
    }

    case "USE_DROP_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      consumeItem(state, actorPlayerId, "DROP");
      const opponentPlayerId = opponentOf(state.players, actorPlayerId);
      const placements: [DroppedDiePlacement, DroppedDiePlacement] = [
        dropRandomDie(state, actorPlayerId, actorPlayerId, context),
        dropRandomDie(state, opponentPlayerId, actorPlayerId, context),
      ];

      events.push({
        type: "DICE_DROPPED",
        playerId: actorPlayerId,
        placements,
      });
      claimLineMissionRewards(
        state,
        placements
          .filter(({ lane }) => lane === state.lineMission.lane)
          .map(({ boardOwnerPlayerId }) => boardOwnerPlayerId),
        context,
        events,
      );
      startFinalTurnIfNeeded(state);
      break;
    }

    case "USE_DESTROY_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      assertLane(command.lane);
      if (!state.players.includes(command.boardOwnerPlayerId)) {
        throw new RuleError(
          "INVALID_BOARD_OWNER",
          "Destroy target must belong to a player in this game.",
        );
      }
      consumeItem(state, actorPlayerId, "DESTROY");

      const lane = boardOf(state, command.boardOwnerPlayerId)[command.lane];
      const targetIndex = lane.findIndex((die) => die.id === command.dieId);
      const target = lane[targetIndex];
      if (targetIndex < 0 || !target) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Destroy target must be a placed die in the selected lane.",
          { itemType: "DESTROY", lane: command.lane },
        );
      }
      if (isDieEffectImmune(target)) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Shield dice cannot be targeted by destroy items.",
          { itemType: "DESTROY", lane: command.lane, reason: "DIE_IS_PROTECTED" },
        );
      }

      lane.splice(targetIndex, 1);
      events.push({
        type: "DIE_DESTROYED",
        playerId: actorPlayerId,
        boardOwnerPlayerId: command.boardOwnerPlayerId,
        lane: command.lane,
        die: target,
      });
      break;
    }

    case "USE_TURN_REROLL_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      const previousDie = activeTurnDie(state);
      consumeItem(state, actorPlayerId, "TURN_REROLL");
      if (isDieEffectImmune(previousDie)) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Shield dice cannot be targeted by turn reroll items.",
          { itemType: "TURN_REROLL", reason: "DIE_IS_PROTECTED" },
        );
      }

      const face = context.rng.rollDifferentFace(previousDie.face);
      if (face === previousDie.face) {
        throw new RuleError(
          "INVARIANT_VIOLATION",
          "Turn reroll item must produce a different face.",
        );
      }
      const rerolledDie: Die = { ...previousDie, face };
      state.pending = { source: "TURN", original: rerolledDie };
      events.push({
        type: "TURN_DIE_REROLLED",
        playerId: actorPlayerId,
        previousDie,
        die: rerolledDie,
      });
      break;
    }

    case "USE_PARITY_ITEM": {
      assertPhase(state, ["TURN_ACTION"]);
      const previousDie = activeTurnDie(state);
      consumeItem(state, actorPlayerId, command.parity);
      if (isDieEffectImmune(previousDie)) {
        throw new RuleError(
          "INVALID_ITEM_TARGET",
          "Shield dice cannot be targeted by parity items.",
          { itemType: command.parity, reason: "DIE_IS_PROTECTED" },
        );
      }

      const candidates = PARITY_FACES[command.parity].filter(
        (face) => face !== previousDie.face,
      );
      const face = pickRandom(
        candidates,
        context,
        `No ${command.parity.toLowerCase()} face is available.`,
      );
      const changedDie: Die = { ...previousDie, face };
      state.pending = { source: "TURN", original: changedDie };
      events.push({
        type: "TURN_DIE_PARITY_CHANGED",
        playerId: actorPlayerId,
        parity: command.parity,
        previousDie,
        die: changedDie,
      });
      break;
    }

    case "CHOOSE_TAZZA_DIE": {
      assertPhase(state, ["TAZZA_CHOICE"]);
      if (state.pending?.source !== "TURN" || !state.pending.candidate) {
        throw new RuleError(
          "TAZZA_CHOICE_MISSING",
          "There is no Tazza candidate to choose.",
        );
      }

      const chosen =
        command.choice === "ORIGINAL"
          ? state.pending.original
          : state.pending.candidate;
      state.phase = "TURN_ACTION";
      state.pending = { source: "TURN", original: chosen };
      events.push({
        type: "TAZZA_SELECTED",
        playerId: actorPlayerId,
        die: chosen,
      });
      break;
    }

    case "PLACE_BONUS_SHIELD": {
      assertPhase(state, ["BONUS_PLACEMENT"]);
      assertLane(command.lane);
      if (!state.players.includes(command.boardOwnerPlayerId)) {
        throw new RuleError(
          "INVALID_BOARD_OWNER",
          "Bonus shield target must be a player in this game.",
        );
      }
      if (state.pending?.source !== "BONUS") {
        throw new RuleError(
          "INVALID_PHASE",
          "There is no bonus shield to place.",
        );
      }

      const lane = boardOf(state, command.boardOwnerPlayerId)[command.lane];
      if (lane.length >= LANE_CAPACITY) {
        throw new RuleError("LANE_FULL", "The selected lane is full.");
      }

      const die = state.pending.die;
      lane.push(die);
      state.pending = null;
      events.push({
        type: "DIE_PLACED",
        playerId: actorPlayerId,
        boardOwnerPlayerId: command.boardOwnerPlayerId,
        lane: command.lane,
        die,
      });
      if (command.lane === state.lineMission.lane) {
        claimLineMissionRewards(
          state,
          [command.boardOwnerPlayerId],
          context,
          events,
        );
      }
      advanceOrFinish(state, actorPlayerId, context, events);
      break;
    }

    case "HOLD": {
      assertPhase(state, ["TURN_ACTION", "TAZZA_CHOICE"]);
      if (state.pending?.source === "TURN") {
        events.push({
          type: "DIE_SPENT",
          playerId: actorPlayerId,
          die: state.pending.original,
          reason: "HOLD",
        });
      }
      state.pending = null;
      state.held[actorPlayerId] = true;
      events.push({ type: "PLAYER_HELD", playerId: actorPlayerId });
      advanceOrFinish(state, actorPlayerId, context, events);
      break;
    }
  }

  state.version += 1;
  assertGameInvariants(state);
  return { state, events };
}

export function getLegalActions(
  state: GameState,
  viewerPlayerId: PlayerId,
): LegalActions {
  const legal: LegalActions = {
    canUseTazza: false,
    canUseSwapItem: false,
    canUseRerollItem: false,
    canUseShieldItem: false,
    canUseDropItem: false,
    canUseDestroyItem: false,
    canUseTurnRerollItem: false,
    canUseOddItem: false,
    canUseEvenItem: false,
    canHold: false,
    canSurrender:
      state.phase !== "FINISHED" && state.players.includes(viewerPlayerId),
    canChooseTazza: false,
    ownPlacementLanes: [],
    alkkagiLanes: [],
    swapItemLanes: [],
    rerollItemTargets: [],
    destroyItemTargets: [],
    bonusTargets: [],
  };

  if (
    state.phase === "FINISHED" ||
    state.currentPlayerId !== viewerPlayerId
  ) {
    return legal;
  }

  if (state.phase === "TURN_ACTION" && state.pending?.source === "TURN") {
    legal.canUseTazza = state.tazzaUsed[viewerPlayerId] === false;
    legal.canHold = true;
    const viewerBoard = boardOf(state, viewerPlayerId);
    legal.ownPlacementLanes = laneIndexes().filter(
      (lane) => viewerBoard[lane].length < LANE_CAPACITY,
    );

    const opponentPlayerId = opponentOf(state.players, viewerPlayerId);
    const opponentBoard = boardOf(state, opponentPlayerId);
    if (!state.itemUsedThisTurn) {
      const inventory = inventoryOf(state, viewerPlayerId);
      if (inventory.SWAP > 0) {
        legal.swapItemLanes = laneIndexes().filter(
          (lane) =>
            viewerBoard[lane].some((die) => !isDieEffectImmune(die)) &&
            opponentBoard[lane].some((die) => !isDieEffectImmune(die)),
        );
        legal.canUseSwapItem = legal.swapItemLanes.length > 0;
      }
      const normalTargets: LegalActions["rerollItemTargets"] = [];
      if (inventory.REROLL > 0 || inventory.DESTROY > 0) {
        for (const boardOwnerPlayerId of state.players) {
          const board = boardOf(state, boardOwnerPlayerId);
          for (const lane of laneIndexes()) {
            for (const die of board[lane]) {
              if (isDieEffectImmune(die)) continue;
              normalTargets.push({
                boardOwnerPlayerId,
                lane,
                dieId: die.id,
              });
            }
          }
        }
      }
      if (inventory.REROLL > 0) {
        legal.rerollItemTargets = [...normalTargets];
        legal.canUseRerollItem = legal.rerollItemTargets.length > 0;
      }
      if (inventory.DESTROY > 0) {
        legal.destroyItemTargets = [...normalTargets];
        legal.canUseDestroyItem = legal.destroyItemTargets.length > 0;
      }
      legal.canUseShieldItem =
        inventory.SHIELD > 0 && !isDieEffectImmune(state.pending.original);
      legal.canUseDropItem =
        inventory.DROP > 0 &&
        state.players.every(
          (playerId) => availableSlotLanes(boardOf(state, playerId)).length > 0,
        );
      const canChangePending = !isDieEffectImmune(state.pending.original);
      legal.canUseTurnRerollItem =
        inventory.TURN_REROLL > 0 && canChangePending;
      legal.canUseOddItem = inventory.ODD > 0 && canChangePending;
      legal.canUseEvenItem = inventory.EVEN > 0 && canChangePending;
    }

    if (!isDieEffectImmune(state.pending.original)) {
      const pendingFace = state.pending.original.face;
      legal.alkkagiLanes = laneIndexes().filter(
        (lane) =>
          viewerBoard[lane].length < LANE_CAPACITY &&
          opponentBoard[lane].some(
            (die) =>
              !isDieEffectImmune(die) && die.face === pendingFace,
          ),
      );
    }
  }

  if (state.phase === "TAZZA_CHOICE") {
    legal.canChooseTazza = true;
    legal.canHold = true;
  }

  if (state.phase === "BONUS_PLACEMENT") {
    for (const boardOwnerPlayerId of state.players) {
      const board = boardOf(state, boardOwnerPlayerId);
      for (const lane of laneIndexes()) {
        if (board[lane].length < LANE_CAPACITY) {
          legal.bonusTargets.push({ boardOwnerPlayerId, lane });
        }
      }
    }
  }

  return legal;
}

export function assertGameInvariants(state: GameState): void {
  const fail = (message: string): never => {
    throw new RuleError("INVARIANT_VIOLATION", message);
  };

  if (state.schemaVersion !== 8) {
    fail("Unsupported game state schema version.");
  }
  if (state.players.length !== 2 || state.players[0] === state.players[1]) {
    fail("Game must contain two distinct players.");
  }
  if (!state.players.includes(state.currentPlayerId)) {
    fail("Current player must belong to the game.");
  }
  if (!state.players.includes(state.firstPlayerId)) {
    fail("First player must belong to the game.");
  }

  const seenDice = new Set<string>();
  const visitDie = (die: Die): void => {
    if (!Number.isInteger(die.face) || die.face < 1 || die.face > 6) {
      fail(`Invalid die face: ${die.face}`);
    }
    if (seenDice.has(die.id)) {
      fail(`Duplicate die id: ${die.id}`);
    }
    seenDice.add(die.id);
  };

  for (const playerId of state.players) {
    const board = state.boards[playerId];
    invariant(board, `Missing board for ${playerId}.`);
    if (board.length !== LANE_COUNT) fail(`Invalid board for ${playerId}.`);
    for (const lane of board) {
      if (lane.length > LANE_CAPACITY) {
        fail(`A lane cannot contain more than ${LANE_CAPACITY} dice.`);
      }
      for (const die of lane) visitDie(die);
    }

    const inventory = state.inventory[playerId];
    invariant(inventory, `Missing inventory for ${playerId}.`);
    for (const itemType of ITEM_TYPES) {
      const count = inventory[itemType];
      if (!Number.isInteger(count) || count < 0) {
        fail(`Invalid ${itemType} item count for ${playerId}.`);
      }
    }
  }

  if (typeof state.itemUsedThisTurn !== "boolean") {
    fail("itemUsedThisTurn must be a boolean.");
  }

  const lineMission = state.lineMission;
  invariant(lineMission, "Game must contain a line mission.");
  if (
    !Number.isInteger(lineMission.lane) ||
    lineMission.lane < 0 ||
    lineMission.lane >= LANE_COUNT
  ) {
    fail("Line mission must target a valid lane.");
  }
  if (
    lineMission.kind === "PLACEMENT_COUNT"
      ? lineMission.threshold !== LINE_PLACEMENT_MISSION_THRESHOLD
      : lineMission.kind === "SCORE_OVER"
        ? lineMission.threshold !== LINE_SCORE_MISSION_THRESHOLD
        : true
  ) {
    fail("Line mission kind and threshold must be a supported pair.");
  }
  const rewardPlayerIds = Object.keys(lineMission.rewardItems);
  if (
    rewardPlayerIds.length !== state.players.length ||
    rewardPlayerIds.some((playerId) => !state.players.includes(playerId))
  ) {
    fail("Line mission rewards must contain exactly the game players.");
  }
  for (const playerId of state.players) {
    if (!(playerId in lineMission.rewardItems)) {
      fail(`Missing line mission reward record for ${playerId}.`);
    }
    const itemType = lineMission.rewardItems[playerId];
    if (itemType === null) continue;
    invariant(
      itemType !== undefined,
      `Missing line mission reward record for ${playerId}.`,
    );
    if (!ITEM_TYPES.includes(itemType)) {
      fail("Line mission reward item must belong to the item catalog.");
    }
  }

  const expectedFinalTurnPlayerId = opponentOf(
    state.players,
    state.firstPlayerId,
  );
  if (
    state.finalTurnPlayerId !== null &&
    state.finalTurnPlayerId !== expectedFinalTurnPlayerId
  ) {
    fail("Only the second player can own the final turn.");
  }

  if (state.pending?.source === "TURN") {
    visitDie(state.pending.original);
    if (state.pending.candidate) visitDie(state.pending.candidate);
  }
  if (state.pending?.source === "BONUS") {
    visitDie(state.pending.die);
  }

  if (state.phase === "TURN_ACTION") {
    if (state.pending?.source !== "TURN" || state.pending.candidate) {
      fail("TURN_ACTION requires exactly one turn die.");
    }
  }
  if (state.phase === "TAZZA_CHOICE") {
    const pending = state.pending;
    invariant(
      pending?.source === "TURN" && pending.candidate,
      "TAZZA_CHOICE requires two candidate dice.",
    );
    if (pending.original.face === pending.candidate.face) {
      fail("Tazza candidate face must differ from the original.");
    }
    if (pending.original.kind !== pending.candidate.kind) {
      fail("Tazza candidates must preserve the same die kind.");
    }
  }
  if (state.phase === "BONUS_PLACEMENT") {
    if (
      state.pending?.source !== "BONUS" ||
      state.pending.die.kind !== "SHIELD"
    ) {
      fail("BONUS_PLACEMENT requires one shield die.");
    }
  }
  if (state.phase === "FINISHED") {
    if (!state.result) fail("FINISHED game must have a result.");
    if (state.pending) fail("FINISHED game cannot keep pending dice.");
    if (state.finalTurnPlayerId !== null) {
      fail("FINISHED game cannot keep a final turn pending.");
    }
  } else {
    if (state.result) fail("Active game cannot have a result.");
    if (hasCompletedBoard(state) && state.finalTurnPlayerId === null) {
      fail("A completed board must schedule the second player's final turn.");
    }
    if (
      state.finalTurnPlayerId === null &&
      !isEligible(state, state.currentPlayerId)
    ) {
      fail("Current player must be eligible while the game is active.");
    }
    if (state.held[state.currentPlayerId]) {
      fail("The active player cannot already be held.");
    }
  }

  if (state.result) {
    for (const playerId of state.players) {
      const expected = scoreBoard(boardOf(state, playerId));
      const stored = state.result.laneScores[playerId];
      invariant(stored, `Missing stored score for ${playerId}.`);
      if (expected.some((score, lane) => score !== stored[lane])) {
        fail(`Stored result score does not match board for ${playerId}.`);
      }
    }
  }
}
