export type RuleErrorCode =
  | "NOT_A_PLAYER"
  | "NOT_YOUR_TURN"
  | "INVALID_PHASE"
  | "INVALID_LANE"
  | "LANE_FULL"
  | "ALKKAGI_NOT_AVAILABLE"
  | "SWAP_NOT_AVAILABLE"
  | "TAZZA_ALREADY_USED"
  | "TAZZA_CHOICE_MISSING"
  | "INVALID_BOARD_OWNER"
  | "GAME_FINISHED"
  | "INVARIANT_VIOLATION";

export class RuleError extends Error {
  readonly code: RuleErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuleErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuleError";
    this.code = code;
    this.details = details;
  }
}
