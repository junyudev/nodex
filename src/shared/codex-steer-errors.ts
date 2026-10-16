import { codexErrorMessages as messages } from "@nodex/agent-runtime/codex-conventions";

export { parseSteerTurnMismatchActualTurnId } from "@nodex/agent-runtime/codex-conventions";

export function createSteerTurnInactiveError(conversationId: string): Error {
  const error = new Error(
    `Cannot steer conversation ${conversationId} because its active turn already ended`,
  );
  error.name = "SteerTurnInactiveError";
  return error;
}
export function normalizeSteerTurnError(error: unknown, conversationId: string): unknown {
  return messages(error).at(-1) === "no active turn to steer"
    ? createSteerTurnInactiveError(conversationId)
    : error;
}
export function isSteerTurnInactiveError(error: unknown): boolean {
  return messages(error).some(
    (value) =>
      value.includes("SteerTurnInactiveError") ||
      /^Cannot steer conversation \S+ because its active turn already ended$/.test(value),
  );
}
export function isNoActiveTurnError(error: unknown): boolean {
  return messages(error).some((value) => value.includes("NoActiveTurn"));
}
