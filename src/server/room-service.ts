import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import {
  applyCommand,
  boardOf,
  createGame,
  CryptoDiceRng,
  getLegalActions,
  RandomIdGenerator,
  RuleError,
  scoreBoard,
} from "../game";
import type {
  DiceRng,
  GameCommand,
  GameEvent,
  GameState,
  IdGenerator,
  PlayerId,
} from "../game/types";
import type {
  GameView,
  RoomSnapshot,
  RoomStatus,
} from "../protocol";
import { ApplicationError } from "./errors";

const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_RECENT_EVENTS = 12;

export type SessionRef = {
  roomId: string;
  playerId: PlayerId;
};

type SeatRecord = {
  playerId: PlayerId;
  nickname: string;
  ready: boolean;
};

type StoredActionResult = {
  requestKey: string;
  version: number;
};

type GameRecord = {
  state: GameState;
  events: GameEvent[];
  actionResults: Map<string, StoredActionResult>;
};

type RoomRecord = {
  roomId: string;
  roomCode: string;
  roomVersion: number;
  status: RoomStatus;
  seats: SeatRecord[];
  game: GameRecord | null;
  rematchPlayerIds: Set<PlayerId>;
  createdAt: number;
  updatedAt: number;
};

export type CreatedSession = {
  sessionToken: string;
  session: SessionRef;
};

export type GameCommandResult = {
  roomId: string;
  gameId: string;
  version: number;
  events: GameEvent[];
  duplicate: boolean;
};

type RoomServiceOptions = {
  rng?: DiceRng;
  ids?: IdGenerator;
};

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizeNickname(nickname: string): string {
  const normalized = nickname.trim().replace(/\s+/g, " ");
  const length = [...normalized].length;
  if (length < 1 || length > 16 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ApplicationError(
      "INVALID_NICKNAME",
      "Nickname must be between 1 and 16 visible characters.",
      400,
    );
  }
  return normalized;
}

function gameViewFor(state: GameState, viewerPlayerId: PlayerId): GameView {
  const publicState = structuredClone(state);
  if (
    publicState.phase === "TAZZA_CHOICE" &&
    publicState.currentPlayerId !== viewerPlayerId &&
    publicState.pending?.source === "TURN"
  ) {
    delete publicState.pending.candidate;
  }

  const scores = Object.fromEntries(
    state.players.map((playerId) => [playerId, scoreBoard(boardOf(state, playerId))]),
  ) as Record<PlayerId, [number, number, number]>;

  return {
    state: publicState,
    scores,
    legalActions: getLegalActions(state, viewerPlayerId),
  };
}

export class RoomService {
  private readonly roomsById = new Map<string, RoomRecord>();
  private readonly roomIdByCode = new Map<string, string>();
  private readonly sessionsByHash = new Map<string, SessionRef>();
  private readonly rng: DiceRng;
  private readonly ids: IdGenerator;

  constructor(options: RoomServiceOptions = {}) {
    this.rng = options.rng ?? new CryptoDiceRng();
    this.ids = options.ids ?? new RandomIdGenerator();
  }

  createRoom(nickname: string): CreatedSession {
    const roomId = `room_${randomUUID()}`;
    const playerId = `player_${randomUUID()}`;
    const now = Date.now();
    const room: RoomRecord = {
      roomId,
      roomCode: this.createUniqueRoomCode(),
      roomVersion: 0,
      status: "WAITING_FOR_OPPONENT",
      seats: [
        { playerId, nickname: normalizeNickname(nickname), ready: false },
      ],
      game: null,
      rematchPlayerIds: new Set(),
      createdAt: now,
      updatedAt: now,
    };
    this.roomsById.set(roomId, room);
    this.roomIdByCode.set(room.roomCode, roomId);
    return this.issueSession(roomId, playerId);
  }

  joinRoom(
    roomCode: string,
    nickname: string,
    existingSessionToken?: string,
  ): CreatedSession {
    const room = this.findRoomByCode(roomCode);
    const existingSession = existingSessionToken
      ? this.getSession(existingSessionToken)
      : null;
    if (existingSession?.roomId === room.roomId) {
      return { sessionToken: existingSessionToken as string, session: existingSession };
    }
    if (room.seats.length >= 2) {
      throw new ApplicationError("ROOM_FULL", "The room is already full.", 409);
    }
    if (room.status !== "WAITING_FOR_OPPONENT") {
      throw new ApplicationError(
        "INVALID_ROOM_PHASE",
        "The room can no longer be joined.",
        409,
      );
    }

    const playerId = `player_${randomUUID()}`;
    room.seats.push({
      playerId,
      nickname: normalizeNickname(nickname),
      ready: false,
    });
    room.status = "LOBBY";
    room.roomVersion += 1;
    room.updatedAt = Date.now();
    return this.issueSession(room.roomId, playerId);
  }

  getSession(sessionToken?: string): SessionRef | null {
    if (!sessionToken) return null;
    return this.sessionsByHash.get(hashSessionToken(sessionToken)) ?? null;
  }

  requireSession(sessionToken?: string): SessionRef {
    const session = this.getSession(sessionToken);
    if (!session) {
      throw new ApplicationError(
        "NOT_AUTHENTICATED",
        "A valid room session is required.",
        401,
      );
    }
    return session;
  }

  getRoomId(session: SessionRef): string {
    this.requireRoom(session.roomId);
    return session.roomId;
  }

  participants(roomId: string): SessionRef[] {
    const room = this.requireRoom(roomId);
    return room.seats.map((seat) => ({ roomId, playerId: seat.playerId }));
  }

  snapshotFor(
    session: SessionRef,
    isConnected: (playerId: PlayerId) => boolean,
  ): RoomSnapshot {
    const room = this.requireRoom(session.roomId);
    if (!room.seats.some((seat) => seat.playerId === session.playerId)) {
      throw new ApplicationError(
        "NOT_AUTHENTICATED",
        "The session does not own a seat in this room.",
        401,
      );
    }

    return {
      roomCode: room.roomCode,
      roomVersion: room.roomVersion,
      status: room.status,
      selfPlayerId: session.playerId,
      seats: room.seats.map((seat) => ({
        ...seat,
        connected: isConnected(seat.playerId),
      })),
      game: room.game
        ? gameViewFor(room.game.state, session.playerId)
        : null,
      recentEvents: room.game
        ? room.game.events.slice(-MAX_RECENT_EVENTS)
        : [],
      rematchPlayerIds: [...room.rematchPlayerIds],
      deadlineAt: null,
    };
  }

  setReady(
    session: SessionRef,
    expectedRoomVersion: number,
    ready: boolean,
  ): { roomId: string; roomVersion: number; events: GameEvent[] } {
    const room = this.requireRoom(session.roomId);
    this.assertRoomVersion(room, expectedRoomVersion);
    if (room.status !== "WAITING_FOR_OPPONENT" && room.status !== "LOBBY") {
      throw new ApplicationError(
        "INVALID_ROOM_PHASE",
        "Ready state can only change before a game starts.",
        409,
      );
    }
    const seat = this.requireSeat(room, session.playerId);
    seat.ready = ready;
    room.roomVersion += 1;
    room.updatedAt = Date.now();

    let events: GameEvent[] = [];
    if (room.seats.length === 2 && room.seats.every((candidate) => candidate.ready)) {
      const started = createGame(
        this.twoPlayers(room),
        { rng: this.rng, ids: this.ids },
      );
      room.game = {
        state: started.state,
        events: [...started.events],
        actionResults: new Map(),
      };
      room.status = "IN_GAME";
      room.rematchPlayerIds.clear();
      events = started.events;
    }

    return { roomId: room.roomId, roomVersion: room.roomVersion, events };
  }

  processGameCommand(
    session: SessionRef,
    input: {
      actionId: string;
      gameId: string;
      expectedVersion: number;
      command: GameCommand;
    },
  ): GameCommandResult {
    const room = this.requireRoom(session.roomId);
    const game = room.game;
    if (!game || game.state.gameId !== input.gameId) {
      throw new ApplicationError(
        "GAME_NOT_FOUND",
        "The requested game is not active in this room.",
        404,
      );
    }

    const actionKey = `${session.playerId}:${input.actionId}`;
    const requestKey = JSON.stringify(input.command);
    const previous = game.actionResults.get(actionKey);
    if (previous) {
      if (previous.requestKey !== requestKey) {
        throw new ApplicationError(
          "DUPLICATE_ACTION_MISMATCH",
          "The same actionId was reused with a different command.",
          409,
        );
      }
      return {
        roomId: room.roomId,
        gameId: game.state.gameId,
        version: previous.version,
        events: [],
        duplicate: true,
      };
    }

    if (game.state.version !== input.expectedVersion) {
      throw new ApplicationError(
        "STALE_VERSION",
        "The game state has changed. Refresh from the latest snapshot.",
        409,
        { latestVersion: game.state.version },
      );
    }

    const transition = applyCommand(
      game.state,
      session.playerId,
      input.command,
      { rng: this.rng, ids: this.ids },
    );
    game.state = transition.state;
    game.events.push(...transition.events);
    game.actionResults.set(actionKey, {
      requestKey,
      version: transition.state.version,
    });
    room.updatedAt = Date.now();

    if (transition.state.phase === "FINISHED") {
      room.status = "POST_GAME";
      room.roomVersion += 1;
      room.rematchPlayerIds.clear();
    }

    return {
      roomId: room.roomId,
      gameId: transition.state.gameId,
      version: transition.state.version,
      events: transition.events,
      duplicate: false,
    };
  }

  requestRematch(
    session: SessionRef,
    expectedRoomVersion: number,
  ): { roomId: string; roomVersion: number; events: GameEvent[] } {
    const room = this.requireRoom(session.roomId);
    this.assertRoomVersion(room, expectedRoomVersion);
    if (room.status !== "POST_GAME" || !room.game) {
      throw new ApplicationError(
        "INVALID_ROOM_PHASE",
        "A rematch can only be requested after a completed game.",
        409,
      );
    }

    room.rematchPlayerIds.add(session.playerId);
    room.roomVersion += 1;
    room.updatedAt = Date.now();
    let events: GameEvent[] = [];

    if (room.seats.every((seat) => room.rematchPlayerIds.has(seat.playerId))) {
      const started = createGame(
        this.twoPlayers(room),
        { rng: this.rng, ids: this.ids },
      );
      room.game = {
        state: started.state,
        events: [...started.events],
        actionResults: new Map(),
      };
      room.status = "IN_GAME";
      room.rematchPlayerIds.clear();
      for (const seat of room.seats) seat.ready = true;
      events = started.events;
    }

    return { roomId: room.roomId, roomVersion: room.roomVersion, events };
  }

  private issueSession(roomId: string, playerId: PlayerId): CreatedSession {
    const sessionToken = randomBytes(32).toString("base64url");
    const session = { roomId, playerId };
    this.sessionsByHash.set(hashSessionToken(sessionToken), session);
    return { sessionToken, session };
  }

  private createUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = "";
      for (let index = 0; index < 6; index += 1) {
        const character = ROOM_ALPHABET.at(randomInt(0, ROOM_ALPHABET.length));
        if (!character) throw new Error("Room code alphabet is empty.");
        code += character;
      }
      if (!this.roomIdByCode.has(code)) return code;
    }
    throw new Error("Could not allocate a unique room code.");
  }

  private findRoomByCode(roomCode: string): RoomRecord {
    const normalized = roomCode.trim().toUpperCase().replace(/[\s-]/g, "");
    const roomId = this.roomIdByCode.get(normalized);
    if (!roomId) {
      throw new ApplicationError("ROOM_NOT_FOUND", "Room not found.", 404);
    }
    return this.requireRoom(roomId);
  }

  private requireRoom(roomId: string): RoomRecord {
    const room = this.roomsById.get(roomId);
    if (!room) {
      throw new ApplicationError("ROOM_NOT_FOUND", "Room not found.", 404);
    }
    return room;
  }

  private requireSeat(room: RoomRecord, playerId: PlayerId): SeatRecord {
    const seat = room.seats.find((candidate) => candidate.playerId === playerId);
    if (!seat) {
      throw new ApplicationError(
        "NOT_AUTHENTICATED",
        "The player does not own a seat in this room.",
        401,
      );
    }
    return seat;
  }

  private twoPlayers(room: RoomRecord): [PlayerId, PlayerId] {
    const first = room.seats[0];
    const second = room.seats[1];
    if (!first || !second || room.seats.length !== 2) {
      throw new Error("A game can only start with exactly two occupied seats.");
    }
    return [first.playerId, second.playerId];
  }

  private assertRoomVersion(room: RoomRecord, expectedVersion: number): void {
    if (room.roomVersion !== expectedVersion) {
      throw new ApplicationError(
        "STALE_VERSION",
        "The room state has changed. Refresh from the latest snapshot.",
        409,
        { latestVersion: room.roomVersion },
      );
    }
  }
}

export function errorPayload(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  statusCode: number;
} {
  if (error instanceof ApplicationError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      statusCode: error.statusCode,
    };
  }
  if (error instanceof RuleError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      statusCode: 409,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected server error occurred.",
    statusCode: 500,
  };
}
