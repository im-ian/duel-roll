export type ApplicationErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_NICKNAME"
  | "NOT_AUTHENTICATED"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_NOT_READY"
  | "INVALID_ROOM_PHASE"
  | "STALE_VERSION"
  | "DUPLICATE_ACTION_MISMATCH"
  | "GAME_NOT_FOUND";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
