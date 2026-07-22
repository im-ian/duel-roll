import { describe, expect, it } from "vitest";
import { GameCommandSchema } from "../../src/protocol/messages";

describe("GameCommandSchema", () => {
  it("accepts all server-authoritative item commands", () => {
    expect(
      GameCommandSchema.safeParse({
        type: "USE_SWAP_ITEM",
        lane: 1,
        ownDieId: "die-own",
        opponentDieId: "die-opponent",
      }).success,
    ).toBe(true);
    expect(
      GameCommandSchema.safeParse({
        type: "USE_REROLL_ITEM",
        boardOwnerPlayerId: "player-b",
        lane: 2,
        dieId: "die-target",
      }).success,
    ).toBe(true);
    expect(
      GameCommandSchema.safeParse({ type: "USE_SHIELD_ITEM" }).success,
    ).toBe(true);
  });

  it("rejects malformed item targets", () => {
    expect(
      GameCommandSchema.safeParse({
        type: "USE_SWAP_ITEM",
        lane: 3,
        ownDieId: "",
        opponentDieId: "die-opponent",
      }).success,
    ).toBe(false);
    expect(
      GameCommandSchema.safeParse({
        type: "USE_REROLL_ITEM",
        boardOwnerPlayerId: "player-b",
        lane: 0,
        dieId: "",
      }).success,
    ).toBe(false);
  });
});
