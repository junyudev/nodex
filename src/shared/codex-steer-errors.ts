export function createSteerTurnInactiveError(conversationId: string): Error {
  const error = new Error(
    `Cannot steer conversation ${conversationId} because its active turn already ended`,
  );
  error.name = "SteerTurnInactiveError";
  return error;
}
function messages(error: unknown): string[] {
  const result: string[] = [];
  const visited = new Set<unknown>();
  while (error != null && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    for (const key of ["name", "message", "errorMessage"]) {
      const value: unknown = Reflect.get(error, key);
      if (typeof value === "string") result.push(value);
    }
    error = Reflect.get(error, "cause");
  }
  if (typeof error === "string") result.push(error);
  return result;
}

/** Parse the native mismatch grammar after removing local transport wrappers. */
export function parseSteerTurnMismatchActualTurnId(error: unknown): string | null {
  const message = messages(error).at(-1) ?? String(error);
  return (
    message.match(/expected active turn id `?[^`\s]+`? but found `?([^`\s]+)`?/)?.[1] ??
    message.match(/ExpectedTurnMismatch\s*\{[^}]*actual:\s*"([^"]+)"/)?.[1] ??
    null
  );
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
