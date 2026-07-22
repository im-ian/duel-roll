import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import { ClientMessageSchema, type ServerMessage } from "../protocol";
import { ApplicationError } from "./errors";
import { RealtimeHub } from "./realtime-hub";
import { errorPayload, RoomService } from "./room-service";

const SESSION_COOKIE = "rtd_session";
const NicknameBodySchema = z.object({
  nickname: z.string(),
});
const JoinParamsSchema = z.object({
  roomCode: z.string().min(1),
});

type BuildAppOptions = {
  rooms?: RoomService;
  production?: boolean;
};

function cookieOptions(production: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: production,
    path: "/",
    maxAge: 60 * 60 * 24,
  };
}
function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  const configured = process.env.ALLOWED_ORIGIN;
  if (configured) return origin === configured;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function buildApp(options: BuildAppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const rooms = options.rooms ?? new RoomService();
  const hub = new RealtimeHub();
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 16 * 1024,
  });

  await app.register(cookie);
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
    },
  });

  app.addHook("onRequest", async (request) => {
    if (
      request.method !== "GET" &&
      !isAllowedOrigin(request.headers.origin, request.headers.host)
    ) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        "Request origin is not allowed.",
        403,
      );
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const payload = errorPayload(error);
    if (payload.statusCode >= 500) app.log.error(error);
    return reply.code(payload.statusCode).send({
      error: {
        code: payload.code,
        message: payload.message,
        details: payload.details,
      },
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.post("/api/rooms", async (request, reply) => {
    const parsed = NicknameBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        "A nickname is required.",
        400,
      );
    }
    const created = rooms.createRoom(parsed.data.nickname);
    reply.setCookie(
      SESSION_COOKIE,
      created.sessionToken,
      cookieOptions(production),
    );
    return {
      room: rooms.snapshotFor(created.session, (playerId) =>
        hub.isConnected(playerId),
      ),
    };
  });

  app.post("/api/rooms/:roomCode/join", async (request, reply) => {
    const body = NicknameBodySchema.safeParse(request.body);
    const params = JoinParamsSchema.safeParse(request.params);
    if (!body.success || !params.success) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        "A valid room code and nickname are required.",
        400,
      );
    }
    const joined = rooms.joinRoom(
      params.data.roomCode,
      body.data.nickname,
      request.cookies[SESSION_COOKIE],
    );
    reply.setCookie(
      SESSION_COOKIE,
      joined.sessionToken,
      cookieOptions(production),
    );
    return {
      room: rooms.snapshotFor(joined.session, (playerId) =>
        hub.isConnected(playerId),
      ),
    };
  });

  app.get("/api/session", async (request) => {
    const session = rooms.getSession(request.cookies[SESSION_COOKIE]);
    return {
      room: session
        ? rooms.snapshotFor(session, (playerId) => hub.isConnected(playerId))
        : null,
    };
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      socket.close(4403, "Origin not allowed.");
      return;
    }
    const session = rooms.getSession(request.cookies[SESSION_COOKIE]);
    if (!session) {
      socket.close(4401, "Not authenticated.");
      return;
    }

    hub.attach(session, socket);

    socket.on("message", (raw) => {
      let actionId: string | null = null;
      try {
        const decoded: unknown = JSON.parse(raw.toString());
        const parsed = ClientMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new ApplicationError(
            "INVALID_REQUEST",
            "WebSocket message did not match the protocol.",
            400,
            { issues: parsed.error.issues },
          );
        }

        const message = parsed.data;
        if (message.type === "PING") {
          const pong: ServerMessage = { type: "PONG", sentAt: message.sentAt };
          socket.send(JSON.stringify(pong));
          return;
        }
        actionId = message.actionId;

        if (message.type === "SET_READY") {
          const result = rooms.setReady(
            session,
            message.expectedRoomVersion,
            message.ready,
          );
          hub.send(session.playerId, {
            type: "COMMAND_ACCEPTED",
            actionId: message.actionId,
            scope: "ROOM",
            version: result.roomVersion,
          });
          if (result.events.length > 0) {
            const snapshot = rooms.snapshotFor(session, () => true);
            const gameId = snapshot.game?.state.gameId;
            const version = snapshot.game?.state.version;
            if (gameId && version !== undefined) {
              hub.broadcastGameEvents(result.roomId, rooms, {
                type: "GAME_EVENTS",
                gameId,
                version,
                actionId: message.actionId,
                events: result.events,
              });
            }
          }
          hub.broadcastRoomSnapshots(result.roomId, rooms);
          return;
        }

        if (message.type === "GAME_COMMAND") {
          const result = rooms.processGameCommand(session, message);
          hub.send(session.playerId, {
            type: "COMMAND_ACCEPTED",
            actionId: message.actionId,
            scope: "GAME",
            version: result.version,
          });
          if (!result.duplicate && result.events.length > 0) {
            hub.broadcastGameEvents(result.roomId, rooms, {
              type: "GAME_EVENTS",
              gameId: result.gameId,
              version: result.version,
              actionId: message.actionId,
              events: result.events,
            });
          }
          hub.broadcastRoomSnapshots(result.roomId, rooms);
          return;
        }

        const result = rooms.requestRematch(
          session,
          message.expectedRoomVersion,
        );
        hub.send(session.playerId, {
          type: "COMMAND_ACCEPTED",
          actionId: message.actionId,
          scope: "ROOM",
          version: result.roomVersion,
        });
        if (result.events.length > 0) {
          const snapshot = rooms.snapshotFor(session, () => true);
          const gameId = snapshot.game?.state.gameId;
          const version = snapshot.game?.state.version;
          if (gameId && version !== undefined) {
            hub.broadcastGameEvents(result.roomId, rooms, {
              type: "GAME_EVENTS",
              gameId,
              version,
              actionId: message.actionId,
              events: result.events,
            });
          }
        }
        hub.broadcastRoomSnapshots(result.roomId, rooms);
      } catch (error) {
        const payload = errorPayload(error);
        const rejected: ServerMessage = {
          type: "COMMAND_REJECTED",
          actionId,
          code: payload.code,
          message: payload.message,
          details: payload.details,
          room: rooms.snapshotFor(session, (playerId) =>
            hub.isConnected(playerId),
          ),
        };
        socket.send(JSON.stringify(rejected));
      }
    });

    socket.on("close", () => {
      if (hub.detach(session.playerId, socket)) {
        hub.broadcastRoomSnapshots(session.roomId, rooms);
      }
    });

    hub.broadcastRoomSnapshots(session.roomId, rooms);
  });

  const webRoot = path.resolve(process.cwd(), "dist");
  if (production && existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  return app;
}
