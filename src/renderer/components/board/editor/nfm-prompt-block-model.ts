import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import type { PromptTurnPhase } from "../../../../shared/prompt-turn";

/** Where a Prompt's send button goes: the chat beside the Page, or a new chat. */
export type NfmPromptDestination =
  | { readonly kind: "beside"; readonly sessionId: string; readonly title: string }
  | { readonly kind: "new-chat" };

export type NfmPromptStatusTone = "working" | "attention" | "done" | "idle";

export interface NfmPromptSentPresentation {
  readonly tone: NfmPromptStatusTone;
  readonly label: string;
}

/** When the Prompt went, for a record whose Turn says nothing more. */
export function describeNfmPromptSentAt(sentAt: string, nowMs?: number): string {
  const sentAtMs = Date.parse(sentAt);
  if (!Number.isFinite(sentAtMs)) return "Sent";
  const elapsed = formatCompactRelativeTime(sentAtMs, nowMs);
  return elapsed === "now" ? "Sent just now" : `Sent ${elapsed} ago`;
}

/**
 * The last send, as its own Turn stands: what the chat does with other messages never shows here.
 * A record without a known Turn only says when it went.
 */
export function resolveNfmPromptSentPresentation(input: {
  readonly phase: PromptTurnPhase | null;
  readonly sentAt: string;
  readonly nowMs?: number;
}): NfmPromptSentPresentation {
  switch (input.phase) {
    case "queued":
      return { tone: "idle", label: "Queued" };
    case "working":
      return { tone: "working", label: "Working…" };
    case "waiting":
      return { tone: "attention", label: "Needs you" };
    case "done":
      return { tone: "done", label: "Answered" };
    case "failed":
      return { tone: "attention", label: "Failed" };
    case "interrupted":
      return { tone: "idle", label: "Stopped" };
    default:
      return { tone: "idle", label: describeNfmPromptSentAt(input.sentAt, input.nowMs) };
  }
}

/** What the Prompt's Turn is doing, for when there is no reply to show yet. */
export function describeNfmPromptTurnState(phase: PromptTurnPhase | null): string {
  switch (phase) {
    case "queued":
      return "Queued until the chat finishes its current turn.";
    case "working":
      return "The chat is working on this.";
    case "waiting":
      return "The chat needs your answer to continue.";
    case "done":
      return "The chat finished without a written reply.";
    case "failed":
      return "This turn failed. Open the chat to see why.";
    case "interrupted":
      return "This turn was stopped before it finished.";
    default:
      return "The chat no longer has a record of this send.";
  }
}

export function describeNfmPromptSend(
  destination: NfmPromptDestination,
  sentBefore: boolean,
): string {
  const where = destination.kind === "beside" ? destination.title : "a new chat";
  return sentBefore ? `Send again to ${where}` : `Send to ${where}`;
}

interface PromptContentNode {
  readonly type?: string;
  readonly content?: unknown;
  readonly children?: readonly unknown[];
}

/** Agent config anywhere in a Prompt makes its send a Turn of its own, never a steer. */
export function nfmPromptStartsNewTurn(block: PromptContentNode): boolean {
  const inline = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.some((item: PromptContentNode) => item?.type === "agentConfig" || inline(item?.content));
  return (
    inline(block.content) ||
    (block.children ?? []).some((child) => nfmPromptStartsNewTurn(child as PromptContentNode))
  );
}

interface PromptTreeEditor {
  getTextCursorPosition: () => { block: { id: string } };
  getParentBlock: (id: string) => { id: string; type: string } | undefined;
  getBlock: (id: string) => { id: string; type: string } | undefined;
}

/** The Prompt holding the caret, through any depth of its own child Blocks. */
export function findNfmPromptBlockAtCaret(editor: PromptTreeEditor): string | null {
  let current: { id: string; type: string } | undefined;
  try {
    current = editor.getBlock(editor.getTextCursorPosition().block.id);
  } catch {
    return null;
  }
  while (current) {
    if (current.type === "prompt") return current.id;
    current = editor.getParentBlock(current.id);
  }
  return null;
}
