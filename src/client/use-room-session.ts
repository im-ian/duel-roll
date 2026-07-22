import { useCallback, useEffect, useRef, useState } from "react";
import type { GameCommand } from "../game";
import type {
  ClientMessage,
  RoomSnapshot,
  ServerMessage,
} from "../protocol";
import {
  ApiError,
  createRoom as createRoomRequest,
  joinRoom as joinRoomRequest,
  restoreSession,
} from "./api";

export type ConnectionState =
  | "IDLE"
  | "CONNECTING"
  | "OPEN"
  | "RECONNECTING"
  | "DISCONNECTED";

type ActionMessage = Exclude<ClientMessage, { type: "PING" }>;

export type PendingAction = {
  actionId: string;
  label: string;
  message: ActionMessage;
};

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) {
    const byCode: Record<string, string> = {
      ROOM_NOT_FOUND: "방을 찾을 수 없습니다. 코드를 다시 확인해 주세요.",
      ROOM_FULL: "이미 두 명이 참가한 방입니다.",
      INVALID_NICKNAME: "닉네임은 1~16자로 입력해 주세요.",
      STALE_VERSION: "최신 게임 상태로 갱신했습니다.",
      NOT_YOUR_TURN: "지금은 상대 차례입니다.",
      LANE_FULL: "해당 라인에는 빈칸이 없습니다.",
      ALKKAGI_NOT_AVAILABLE: "지금은 그 라인을 공격할 수 없습니다.",
      ITEM_ALREADY_USED_THIS_TURN: "이번 턴에는 이미 아이템을 사용했습니다.",
      ITEM_NOT_AVAILABLE: "해당 아이템을 모두 사용했습니다.",
      INVALID_ITEM_TARGET: "선택한 주사위에는 이 아이템을 사용할 수 없습니다.",
    };
    return byCode[error.code] ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}

export function useRoomSession() {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("IDLE");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);

  const updatePending = useCallback((next: PendingAction | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  useEffect(() => {
    let active = true;
    restoreSession()
      .then((restored) => {
        if (active) setRoom(restored);
      })
      .catch((caught: unknown) => {
        if (active) setError(friendlyError(caught));
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!room?.roomCode) {
      setConnection("IDLE");
      return;
    }

    let stopped = false;
    let attempt = 0;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;

    const connect = () => {
      if (stopped) return;
      setConnection(attempt === 0 ? "CONNECTING" : "RECONNECTING");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (stopped) return;
        attempt = 0;
        setConnection("OPEN");
        setError(null);
        const unresolved = pendingRef.current;
        if (unresolved) socket.send(JSON.stringify(unresolved.message));
        heartbeatTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "PING", sentAt: Date.now() }));
          }
        }, 15_000);
      });

      socket.addEventListener("message", (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          setError("서버 응답을 읽지 못했습니다.");
          return;
        }

        if (message.type === "ROOM_SNAPSHOT") {
          setRoom(message.room);
          return;
        }
        if (message.type === "COMMAND_ACCEPTED") {
          if (pendingRef.current?.actionId === message.actionId) {
            updatePending(null);
          }
          return;
        }
        if (message.type === "COMMAND_REJECTED") {
          if (!message.actionId || pendingRef.current?.actionId === message.actionId) {
            updatePending(null);
          }
          if (message.room) setRoom(message.room);
          setError(friendlyError(new ApiError(message.code, message.message)));
        }
      });

      socket.addEventListener("close", (event) => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
        if (stopped) return;
        if (event.code === 4401) {
          stopped = true;
          socketRef.current = null;
          updatePending(null);
          setConnection("IDLE");
          setRoom(null);
          setError("방 세션이 만료되었습니다. 새 방을 만들거나 다시 참가해 주세요.");
          return;
        }
        if (event.code === 4001 || event.code === 4403) {
          stopped = true;
          socketRef.current = null;
          setConnection("DISCONNECTED");
          setError(
            event.code === 4001
              ? "같은 좌석이 다른 탭에서 연결되어 이 탭의 연결을 멈췄습니다."
              : "현재 주소에서는 게임 서버에 연결할 수 없습니다.",
          );
          return;
        }
        attempt += 1;
        setConnection("RECONNECTING");
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        reconnectTimer = window.setTimeout(connect, delay + Math.random() * 250);
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [room?.roomCode, updatePending]);

  const enterRoom = useCallback(
    async (request: () => Promise<RoomSnapshot>) => {
      setRequesting(true);
      setError(null);
      try {
        setRoom(await request());
      } catch (caught) {
        setError(friendlyError(caught));
      } finally {
        setRequesting(false);
      }
    },
    [],
  );

  const sendAction = useCallback(
    (label: string, message: ActionMessage): boolean => {
      const socket = socketRef.current;
      if (pendingRef.current || socket?.readyState !== WebSocket.OPEN) {
        setError("연결을 확인한 뒤 다시 시도해 주세요.");
        return false;
      }
      const action: PendingAction = {
        actionId: message.actionId,
        label,
        message,
      };
      updatePending(action);
      setError(null);
      socket.send(JSON.stringify(message));
      return true;
    },
    [updatePending],
  );

  const setReady = useCallback(
    (ready: boolean) => {
      if (!room) return false;
      return sendAction(ready ? "준비 중" : "준비 취소 중", {
        type: "SET_READY",
        actionId: crypto.randomUUID(),
        expectedRoomVersion: room.roomVersion,
        ready,
      });
    },
    [room, sendAction],
  );

  const sendGameCommand = useCallback(
    (command: GameCommand, label: string) => {
      if (!room?.game) return false;
      return sendAction(label, {
        type: "GAME_COMMAND",
        actionId: crypto.randomUUID(),
        gameId: room.game.state.gameId,
        expectedVersion: room.game.state.version,
        command,
      });
    },
    [room, sendAction],
  );

  const requestRematch = useCallback(() => {
    if (!room) return false;
    return sendAction("재대결 신청 중", {
      type: "REMATCH",
      actionId: crypto.randomUUID(),
      expectedRoomVersion: room.roomVersion,
    });
  }, [room, sendAction]);

  return {
    room,
    restoring,
    requesting,
    connection,
    pending,
    error,
    clearError: () => setError(null),
    createRoom: (nickname: string) =>
      enterRoom(() => createRoomRequest(nickname)),
    joinRoom: (code: string, nickname: string) =>
      enterRoom(() => joinRoomRequest(code, nickname)),
    setReady,
    sendGameCommand,
    requestRematch,
  };
}
