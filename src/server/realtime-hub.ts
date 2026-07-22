import { WebSocket } from "ws";
import type { PlayerId } from "../game/types";
import type { ServerMessage } from "../protocol";
import type { RoomService, SessionRef } from "./room-service";

type Connection = {
  roomId: string;
  playerId: PlayerId;
  socket: WebSocket;
};

export class RealtimeHub {
  private readonly connections = new Map<PlayerId, Connection>();

  attach(session: SessionRef, socket: WebSocket): void {
    const previous = this.connections.get(session.playerId);
    if (previous && previous.socket !== socket) {
      previous.socket.close(4001, "Replaced by a newer connection.");
    }
    this.connections.set(session.playerId, { ...session, socket });
  }

  detach(playerId: PlayerId, socket: WebSocket): boolean {
    const current = this.connections.get(playerId);
    if (!current || current.socket !== socket) return false;
    this.connections.delete(playerId);
    return true;
  }

  isConnected(playerId: PlayerId): boolean {
    return this.connections.get(playerId)?.socket.readyState === WebSocket.OPEN;
  }

  send(playerId: PlayerId, message: ServerMessage): void {
    const connection = this.connections.get(playerId);
    if (connection?.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(message));
    }
  }

  broadcastRoomSnapshots(roomId: string, rooms: RoomService): void {
    for (const participant of rooms.participants(roomId)) {
      if (!this.isConnected(participant.playerId)) continue;
      this.send(participant.playerId, {
        type: "ROOM_SNAPSHOT",
        room: rooms.snapshotFor(participant, (playerId) =>
          this.isConnected(playerId),
        ),
      });
    }
  }

  broadcastGameEvents(
    roomId: string,
    rooms: RoomService,
    message: Extract<ServerMessage, { type: "GAME_EVENTS" }>,
  ): void {
    for (const participant of rooms.participants(roomId)) {
      this.send(participant.playerId, message);
    }
  }
}
