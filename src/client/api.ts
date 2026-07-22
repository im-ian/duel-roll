import type { RoomSnapshot } from "../protocol";

type RoomResponse = { room: RoomSnapshot };

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      error.error?.code ?? "REQUEST_FAILED",
      error.error?.message ?? "요청을 처리하지 못했습니다.",
    );
  }
  return payload as T;
}

export async function restoreSession(): Promise<RoomSnapshot | null> {
  const response = await request<{ room: RoomSnapshot | null }>("/api/session");
  return response.room;
}

export async function createRoom(nickname: string): Promise<RoomSnapshot> {
  const response = await request<RoomResponse>("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ nickname }),
  });
  return response.room;
}

export async function joinRoom(
  roomCode: string,
  nickname: string,
): Promise<RoomSnapshot> {
  const response = await request<RoomResponse>(
    `/api/rooms/${encodeURIComponent(roomCode)}/join`,
    {
      method: "POST",
      body: JSON.stringify({ nickname }),
    },
  );
  return response.room;
}
