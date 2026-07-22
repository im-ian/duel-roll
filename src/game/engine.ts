import { RuleError } from "./errors";
import {
  boardOf,
  calculateResult,
  createEmptyBoard,
  isEligible,
  laneIndexes,
  opponentOf,
  scoreBoard,
} from "./scoring";
import type {
  Die,
  DieFace,
  DieKind,
  EngineContext,
  GameCommand,
  GameEvent,
  GameState,
  LaneIndex,
  LegalActions,
  PlayerId,
  Transition,
} from "./types";

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
  if (!Number.isInteger(lane) || lane < 0 || lane > 2) {
    throw new RuleError("INVALID_LANE", "Lane must be 0, 1, or 2.");
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
  events.push({ type: "TURN_STARTED", playerId, turnNumber: state.turnNumber });
  events.push({ type: "DIE_ROLLED", playerId, die, source: "TURN" });
}

function finishNormally(state: GameState, events: GameEvent[]): void {
  state.phase = "FINISHED";
  state.pending = null;
  state.result = calculateResult(state, "NORMAL");
  events.push({ type: "GAME_FINISHED", result: state.result });
}

function advanceOrFinish(
  state: GameState,
  actorPlayerId: PlayerId,
  context: EngineContext,
  events: GameEvent[],
): void {
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
  const state: GameState = {
    schemaVersion: 1,
    rulesVersion: "1",
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
      if (lane.length >= 3) {
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

      if (die.kind !== "NORMAL") {
        throw new RuleError(
          "ALKKAGI_NOT_AVAILABLE",
          "Only a normal turn die can perform alkkagi.",
          { reason: "DIE_IS_SHIELD" },
        );
      }
      if (ownLane.length >= 3) {
        throw new RuleError(
          "ALKKAGI_NOT_AVAILABLE",
          "The actor's corresponding lane is full.",
          { reason: "ACTOR_LANE_FULL" },
        );
      }

      const removed = opponentLane.filter(
        (target) => target.kind === "NORMAL" && target.face === die.face,
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
      if (lane.length >= 3) {
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
    canHold: false,
    canSurrender:
      state.phase !== "FINISHED" && state.players.includes(viewerPlayerId),
    canChooseTazza: false,
    ownPlacementLanes: [],
    alkkagiLanes: [],
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
      (lane) => viewerBoard[lane].length < 3,
    );

    if (state.pending.original.kind === "NORMAL") {
      const opponentPlayerId = opponentOf(state.players, viewerPlayerId);
      const opponentBoard = boardOf(state, opponentPlayerId);
      const pendingFace = state.pending.original.face;
      legal.alkkagiLanes = laneIndexes().filter(
        (lane) =>
          viewerBoard[lane].length < 3 &&
          opponentBoard[lane].some(
            (die) =>
              die.kind === "NORMAL" && die.face === pendingFace,
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
        if (board[lane].length < 3) {
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

  if (state.players.length !== 2 || state.players[0] === state.players[1]) {
    fail("Game must contain two distinct players.");
  }
  if (!state.players.includes(state.currentPlayerId)) {
    fail("Current player must belong to the game.");
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
    if (board.length !== 3) fail(`Invalid board for ${playerId}.`);
    for (const lane of board) {
      if (lane.length > 3) fail("A lane cannot contain more than three dice.");
      for (const die of lane) visitDie(die);
    }
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
  } else {
    if (state.result) fail("Active game cannot have a result.");
    if (!isEligible(state, state.currentPlayerId)) {
      fail("Current player must be eligible while the game is active.");
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
