/**
 * Codex wire conventions shared by Desktop and Agent execution, so either owner speaks to
 * Codex the same way. Dependency-free: Desktop renderers import it directly.
 */

/**
 * Codex asks optional questions in an asynchronous assistant message and reads the user's
 * replies from this envelope, steered into the Turn that asked.
 */
export interface CodexAsyncQuestionReply {
  readonly questionItemId: string;
  readonly question: string;
  readonly answer: string;
}

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";

/** A stable identity for one question in a message, even when the message asks several. */
export const codexAsyncQuestionId = (messageItemId: string, questionIndex: number): string =>
  JSON.stringify(["request_user_input_async", messageItemId, questionIndex]);

export function encodeCodexAsyncQuestionReplies(
  replies: readonly CodexAsyncQuestionReply[],
): string {
  return `${OPEN}\n${JSON.stringify(replies)}\n${CLOSE}`;
}

export function decodeCodexAsyncQuestionReplies(text: string): CodexAsyncQuestionReply[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(OPEN.length, -CLOSE.length));
    const replies: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (!replies.length || !replies.every(isReply)) return null;
    return replies;
  } catch {
    return null;
  }
}

function isReply(value: unknown): value is CodexAsyncQuestionReply {
  if (!value || typeof value !== "object") return false;
  return (
    "questionItemId" in value &&
    typeof value.questionItemId === "string" &&
    "question" in value &&
    typeof value.question === "string" &&
    "answer" in value &&
    typeof value.answer === "string"
  );
}

/** Every message along an error's cause chain, outermost first. */
export function codexErrorMessages(error: unknown): string[] {
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

/**
 * Codex refuses a steer whose expected Turn is no longer the active one and names the Turn
 * that is; the caller may retry once against it. Transport wrappers are looked through.
 */
export function parseSteerTurnMismatchActualTurnId(error: unknown): string | null {
  const message = codexErrorMessages(error).at(-1) ?? String(error);
  return (
    message.match(/expected active turn id `?[^`\s]+`? but found `?([^`\s]+)`?/)?.[1] ??
    message.match(/ExpectedTurnMismatch\s*\{[^}]*actual:\s*"([^"]+)"/)?.[1] ??
    null
  );
}
