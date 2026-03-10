import type { CodexThreadSummary, CodexTurnSummary } from "../../shared/types";
import type { CodexThreadSnapshot } from "./codex-link-repository";

const UNTITLED_THREAD_LABEL = "Untitled thread";
const MAX_NOTIFICATION_BODY_CHARS = 220;

function normalizeNotificationText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function truncateNotificationBody(value: string): string {
  if (value.length <= MAX_NOTIFICATION_BODY_CHARS) return value;
  return `${value.slice(0, MAX_NOTIFICATION_BODY_CHARS - 1).trimEnd()}\u2026`;
}

function stringifyToolCallResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function pickLastTurnMessage(snapshot: CodexThreadSnapshot | null, turnId: string): string {
  if (!snapshot) return "";

  const turnItems = snapshot.items.filter((item) => item.turnId === turnId);
  if (turnItems.length === 0) return "";

  const assistantItems = turnItems.filter((item) =>
    item.role === "assistant" || item.normalizedKind === "assistantMessage"
  );
  const candidates = assistantItems.length > 0 ? assistantItems : turnItems;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index];
    if (!item) continue;

    const message = normalizeNotificationText(
      item.markdownText ?? stringifyToolCallResult(item.toolCall?.result),
    );
    if (!message) continue;
    return truncateNotificationBody(message);
  }

  return "";
}

function buildStatusFallback(turn: CodexTurnSummary): string {
  const normalizedError = normalizeNotificationText(turn.errorMessage);
  if (normalizedError) return truncateNotificationBody(normalizedError);
  if (turn.status === "failed") return "Thread failed.";
  if (turn.status === "interrupted") return "Thread stopped.";
  return "Thread finished.";
}

export function resolveThreadCompletionNotificationContent(input: {
  thread: CodexThreadSummary | null;
  snapshot: CodexThreadSnapshot | null;
  turn: CodexTurnSummary;
}): { title: string; body: string } | null {
  if (input.turn.status === "inProgress") return null;
  if (!input.thread) return null;

  const title = normalizeNotificationText(input.thread.threadName) || UNTITLED_THREAD_LABEL;
  const body =
    pickLastTurnMessage(input.snapshot, input.turn.turnId) ||
    normalizeNotificationText(input.thread.threadPreview) ||
    buildStatusFallback(input.turn);

  return { title, body };
}
