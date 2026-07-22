import type {
  Board,
  Die,
  GameResult,
  GameResultReason,
  GameState,
  LaneIndex,
  PlayerId,
} from "./types";

export function createEmptyBoard(): Board {
  return [[], [], []];
}

export function scoreLane(dice: readonly Die[]): number {
  const counts = new Map<number, number>();

  for (const die of dice) {
    counts.set(die.face, (counts.get(die.face) ?? 0) + 1);
  }

  let score = 0;
  for (const [face, count] of counts) {
    score += face * (2 * count - 1);
  }
  return score;
}

export function scoreBoard(board: Board): [number, number, number] {
  return [scoreLane(board[0]), scoreLane(board[1]), scoreLane(board[2])];
}

export function countDice(board: Board): number {
  return board[0].length + board[1].length + board[2].length;
}

export function boardOf(state: GameState, playerId: PlayerId): Board {
  const board = state.boards[playerId];
  if (!board) throw new Error(`Missing board for player: ${playerId}`);
  return board;
}

export function isEligible(state: GameState, playerId: PlayerId): boolean {
  const held = state.held[playerId];
  if (held === undefined) {
    throw new Error(`Missing held state for player: ${playerId}`);
  }
  return !held && countDice(boardOf(state, playerId)) < 9;
}

export function opponentOf(
  players: [PlayerId, PlayerId],
  playerId: PlayerId,
): PlayerId {
  if (players[0] === playerId) return players[1];
  if (players[1] === playerId) return players[0];
  throw new Error(`Unknown player: ${playerId}`);
}

export function laneIndexes(): LaneIndex[] {
  return [0, 1, 2];
}

export function calculateResult(
  state: GameState,
  reason: GameResultReason,
  forcedWinnerPlayerId?: PlayerId,
): GameResult {
  const [playerA, playerB] = state.players;
  const scoresA = scoreBoard(boardOf(state, playerA));
  const scoresB = scoreBoard(boardOf(state, playerB));

  let winsA = 0;
  let winsB = 0;
  for (const lane of laneIndexes()) {
    if (scoresA[lane] > scoresB[lane]) winsA += 1;
    if (scoresB[lane] > scoresA[lane]) winsB += 1;
  }

  const totalA = scoresA.reduce((sum, score) => sum + score, 0);
  const totalB = scoresB.reduce((sum, score) => sum + score, 0);

  let winnerPlayerId: PlayerId | null = forcedWinnerPlayerId ?? null;
  if (forcedWinnerPlayerId === undefined) {
    if (winsA !== winsB) {
      winnerPlayerId = winsA > winsB ? playerA : playerB;
    } else if (totalA !== totalB) {
      winnerPlayerId = totalA > totalB ? playerA : playerB;
    }
  }

  return {
    reason,
    winnerPlayerId,
    laneScores: {
      [playerA]: scoresA,
      [playerB]: scoresB,
    },
    laneWins: {
      [playerA]: winsA,
      [playerB]: winsB,
    },
    totalScores: {
      [playerA]: totalA,
      [playerB]: totalB,
    },
  };
}
