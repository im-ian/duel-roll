import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("HTTP room API", () => {
  it("creates, joins, and restores room sessions from HttpOnly cookies", async () => {
    app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { nickname: "Host" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers["set-cookie"]).toContain("HttpOnly");
    const createdBody = created.json();
    const roomCode: string = createdBody.room.roomCode;

    const joined = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomCode}/join`,
      payload: { nickname: "Guest" },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().room.seats).toHaveLength(2);

    const setCookie = created.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = cookieHeader?.split(";")[0];
    expect(cookie).toBeTruthy();
    const restored = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookie ?? "" },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().room).toMatchObject({
      roomCode,
      selfPlayerId: createdBody.room.selfPlayerId,
    });
  });

  it("rejects malformed requests and cross-origin mutations", async () => {
    app = await buildApp();

    const invalid = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { nickname: "" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_NICKNAME");

    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { origin: "https://attacker.example", host: "game.example" },
      payload: { nickname: "Host" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe("INVALID_REQUEST");
  });
});
