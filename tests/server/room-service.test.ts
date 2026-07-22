import { describe, expect, it } from "vitest";
import type { DiceRng, DieFace, PlayerId } from "../../src/game/types";
import { ApplicationError } from "../../src/server/errors";
import { RoomService } from "../../src/server/room-service";
import { SequentialIds } from "../helpers";

class RoomTestRng implements DiceRng {
  private nextFace = 1;

  chooseFirstPlayer(players: [PlayerId, PlayerId]): PlayerId {
    return players[0];
  }

  rollD6(): DieFace {
    const face = this.nextFace as DieFace;
    this.nextFace = (this.nextFace % 6) + 1;
    return face;
  }

  rollDifferentFace(excluded: DieFace): DieFace {
    return (excluded === 6 ? 1 : excluded + 1) as DieFace;
  }
}

function createStartedRoom() {
  const rooms = new RoomService({
    rng: new RoomTestRng(),
    ids: new SequentialIds(),
  });
  const host = rooms.createRoom("Host");
  const waiting = rooms.snapshotFor(host.session, () => false);
  const guest = rooms.joinRoom(waiting.roomCode, "Guest");
  const joined = rooms.snapshotFor(host.session, () => false);

  rooms.setReady(host.session, joined.roomVersion, true);
  const hostReady = rooms.snapshotFor(host.session, () => false);
  rooms.setReady(guest.session, hostReady.roomVersion, true);

  return { rooms, host, guest };
}

describe("RoomService", () => {
  it("creates a private seat session and starts only after both players are ready", () => {
    const rooms = new RoomService({
      rng: new RoomTestRng(),
      ids: new SequentialIds(),
    });
    const host = rooms.createRoom("  Dice   Master  ");
    const waiting = rooms.snapshotFor(host.session, () => false);

    expect(waiting.status).toBe("WAITING_FOR_OPPONENT");
    expect(waiting.seats[0]?.nickname).toBe("Dice Master");
    expect(rooms.getSession(host.sessionToken)).toEqual(host.session);
    expect(rooms.getSession(waiting.roomCode)).toBeNull();

    const guest = rooms.joinRoom(waiting.roomCode.toLowerCase(), "Guest");
    const lobby = rooms.snapshotFor(host.session, () => false);
    expect(lobby.status).toBe("LOBBY");
    expect(lobby.seats).toHaveLength(2);

    const firstReady = rooms.setReady(
      host.session,
      lobby.roomVersion,
      true,
    );
    expect(firstReady.events).toEqual([]);
    const beforeStart = rooms.snapshotFor(guest.session, () => false);
    expect(beforeStart.game).toBeNull();

    const started = rooms.setReady(
      guest.session,
      beforeStart.roomVersion,
      true,
    );
    expect(started.events.map((event) => event.type)).toEqual([
      "GAME_STARTED",
      "TURN_STARTED",
      "DIE_ROLLED",
    ]);
    expect(rooms.snapshotFor(host.session, () => false)).toMatchObject({
      status: "IN_GAME",
      game: {
        state: {
          currentPlayerId: host.session.playerId,
          phase: "TURN_ACTION",
        },
      },
    });
  });

  it("applies an action id once and rejects stale or mismatched commands", () => {
    const { rooms, host } = createStartedRoom();
    const initial = rooms.snapshotFor(host.session, () => false);
    const game = initial.game;
    expect(game).not.toBeNull();
    if (!game) return;

    const input = {
      actionId: "action-0001",
      gameId: game.state.gameId,
      expectedVersion: game.state.version,
      command: { type: "PLACE_OWN" as const, lane: 0 as const },
    };
    const applied = rooms.processGameCommand(host.session, input);
    const duplicate = rooms.processGameCommand(host.session, input);

    expect(applied.duplicate).toBe(false);
    expect(duplicate).toMatchObject({
      duplicate: true,
      version: applied.version,
      events: [],
    });
    const after = rooms.snapshotFor(host.session, () => false);
    expect(after.game?.state.boards[host.session.playerId]?.[0]).toHaveLength(1);

    try {
      rooms.processGameCommand(host.session, {
        ...input,
        actionId: "action-0002",
      });
      throw new Error("Expected stale version rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      if (!(error instanceof ApplicationError)) throw error;
      expect(error.code).toBe("STALE_VERSION");
    }

    try {
      rooms.processGameCommand(host.session, {
        ...input,
        command: { type: "PLACE_OWN", lane: 1 },
      });
      throw new Error("Expected duplicate action mismatch rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      if (!(error instanceof ApplicationError)) throw error;
      expect(error.code).toBe("DUPLICATE_ACTION_MISMATCH");
    }
  });

  it("reveals the Tazza candidate only to the player choosing it", () => {
    const { rooms, host, guest } = createStartedRoom();
    const game = rooms.snapshotFor(host.session, () => false).game;
    expect(game).not.toBeNull();
    if (!game) return;

    rooms.processGameCommand(host.session, {
      actionId: "action-tazza",
      gameId: game.state.gameId,
      expectedVersion: game.state.version,
      command: { type: "USE_TAZZA" },
    });

    const hostPending = rooms.snapshotFor(host.session, () => false).game?.state
      .pending;
    const guestPending = rooms.snapshotFor(guest.session, () => false).game?.state
      .pending;
    expect(hostPending).toMatchObject({
      source: "TURN",
      candidate: { face: 2 },
    });
    expect(guestPending).toMatchObject({ source: "TURN", original: { face: 1 } });
    expect(guestPending).not.toHaveProperty("candidate");
  });

  it("starts a fresh game only after both players request a rematch", () => {
    const { rooms, host, guest } = createStartedRoom();
    const initial = rooms.snapshotFor(host.session, () => false);
    const firstGameId = initial.game?.state.gameId;
    expect(firstGameId).toBeTruthy();
    if (!initial.game) return;

    rooms.processGameCommand(guest.session, {
      actionId: "action-give-up",
      gameId: initial.game.state.gameId,
      expectedVersion: initial.game.state.version,
      command: { type: "SURRENDER" },
    });
    const finished = rooms.snapshotFor(host.session, () => false);
    expect(finished.status).toBe("POST_GAME");

    rooms.requestRematch(host.session, finished.roomVersion);
    const oneReady = rooms.snapshotFor(guest.session, () => false);
    expect(oneReady.status).toBe("POST_GAME");
    expect(oneReady.rematchPlayerIds).toEqual([host.session.playerId]);

    rooms.requestRematch(guest.session, oneReady.roomVersion);
    const rematch = rooms.snapshotFor(host.session, () => false);
    expect(rematch.status).toBe("IN_GAME");
    expect(rematch.game?.state.gameId).not.toBe(firstGameId);
    expect(rematch.rematchPlayerIds).toEqual([]);
  });
});
