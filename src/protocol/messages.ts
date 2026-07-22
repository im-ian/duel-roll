import { z } from "zod";
import type {
  GameEvent,
  GameState,
  LaneIndex,
  LegalActions,
  PlayerId,
} from "../game/types";

export type RoomStatus =
  | "WAITING_FOR_OPPONENT"
  | "LOBBY"
  | "IN_GAME"
  | "POST_GAME";

export type SeatView = {
  playerId: PlayerId;
  nickname: string;
  ready: boolean;
  connected: boolean;
};

export type GameView = {
  state: GameState;
  scores: Record<PlayerId, [number, number, number]>;
  legalActions: LegalActions;
};

export type RoomSnapshot = {
  roomCode: string;
  roomVersion: number;
  status: RoomStatus;
  selfPlayerId: PlayerId;
  seats: SeatView[];
  game: GameView | null;
  recentEvents: GameEvent[];
  rematchPlayerIds: PlayerId[];
  deadlineAt: string | null;
};

export type ServerMessage =
  | { type: "ROOM_SNAPSHOT"; room: RoomSnapshot }
  | {
      type: "GAME_EVENTS";
      gameId: string;
      version: number;
      actionId: string | null;
      events: GameEvent[];
    }
  | {
      type: "COMMAND_ACCEPTED";
      actionId: string;
      scope: "ROOM" | "GAME";
      version: number;
    }
  | {
      type: "COMMAND_REJECTED";
      actionId: string | null;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      room?: RoomSnapshot;
    }
  | { type: "PONG"; sentAt: number };

const LaneSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const ActionIdSchema = z.string().min(8).max(128);
const DieIdSchema = z.string().min(1).max(128);

export const GameCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLACE_OWN"), lane: LaneSchema }),
  z.object({ type: z.literal("ALKKAGI"), lane: LaneSchema }),
  z.object({ type: z.literal("USE_TAZZA") }),
  z.object({
    type: z.literal("USE_SWAP_ITEM"),
    lane: LaneSchema,
    ownDieId: DieIdSchema,
    opponentDieId: DieIdSchema,
  }),
  z.object({
    type: z.literal("USE_REROLL_ITEM"),
    boardOwnerPlayerId: z.string().min(1),
    lane: LaneSchema,
    dieId: DieIdSchema,
  }),
  z.object({ type: z.literal("USE_SHIELD_ITEM") }),
  z.object({ type: z.literal("USE_DROP_ITEM") }),
  z.object({
    type: z.literal("USE_DESTROY_ITEM"),
    boardOwnerPlayerId: z.string().min(1),
    lane: LaneSchema,
    dieId: DieIdSchema,
  }),
  z.object({
    type: z.literal("USE_PARITY_ITEM"),
    parity: z.enum(["ODD", "EVEN"]),
  }),
  z.object({
    type: z.literal("CHOOSE_TAZZA_DIE"),
    choice: z.enum(["ORIGINAL", "CANDIDATE"]),
  }),
  z.object({
    type: z.literal("PLACE_BONUS_SHIELD"),
    boardOwnerPlayerId: z.string().min(1),
    lane: LaneSchema,
  }),
  z.object({ type: z.literal("HOLD") }),
  z.object({ type: z.literal("SURRENDER") }),
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SET_READY"),
    actionId: ActionIdSchema,
    expectedRoomVersion: z.number().int().nonnegative(),
    ready: z.boolean(),
  }),
  z.object({
    type: z.literal("GAME_COMMAND"),
    actionId: ActionIdSchema,
    gameId: z.string().min(1),
    expectedVersion: z.number().int().nonnegative(),
    command: GameCommandSchema,
  }),
  z.object({
    type: z.literal("REMATCH"),
    actionId: ActionIdSchema,
    expectedRoomVersion: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("PING"),
    sentAt: z.number(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export function isLaneIndex(value: number): value is LaneIndex {
  return value === 0 || value === 1 || value === 2;
}
