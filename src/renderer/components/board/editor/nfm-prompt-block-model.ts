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

/** The send button's square, and the gap between it and the text it follows. */
export const NFM_PROMPT_SEND_SIZE = 24;
export const NFM_PROMPT_SEND_GAP = 4;

/** A line of the Prompt's text, measured relative to the Prompt's text column. */
export interface NfmPromptLineBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export type NfmPromptSendAnchor =
  | { readonly placement: "inline"; readonly left: number; readonly top: number }
  | { readonly placement: "below"; readonly left: 0; readonly top: number };

/**
 * Where the send button sits. It follows the last line of text when that line has room for it,
 * and otherwise takes a row of its own beneath the text. Only the horizontal room decides, so the
 * row reserved for the lower placement cannot change which placement applies.
 */
export function resolveNfmPromptSendAnchor(input: {
  readonly lastLine: NfmPromptLineBox | null;
  readonly width: number;
}): NfmPromptSendAnchor {
  const { lastLine } = input;
  if (!lastLine) return { placement: "inline", left: 0, top: 0 };
  const left = lastLine.right + NFM_PROMPT_SEND_GAP;
  if (left + NFM_PROMPT_SEND_SIZE <= input.width) {
    const lineHeight = lastLine.bottom - lastLine.top;
    return {
      placement: "inline",
      left,
      top: lastLine.top + (lineHeight - NFM_PROMPT_SEND_SIZE) / 2,
    };
  }
  return { placement: "below", left: 0, top: lastLine.bottom + NFM_PROMPT_SEND_GAP };
}

/** The Page editor surface a Prompt turns its caret block into. */
interface PromptTurnEditor {
  getTextCursorPosition: () => { block: { id: string } };
  updateBlock: (blockId: string, update: { type: "prompt" }) => unknown;
}

/** Turns the block holding the caret into a Prompt, keeping its text and children. */
export function turnCaretBlockIntoPrompt(editor: PromptTurnEditor): void {
  editor.updateBlock(editor.getTextCursorPosition().block.id, { type: "prompt" });
}

export const NODEX_AGENT_MENTION_TITLE = "Nodex";

/** `@` offers Nodex for an empty query or one that starts its name, so `@no` and `@age` find it. */
export function matchesNodexAgentMention(query: string): boolean {
  const term = query.trim().toLowerCase();
  return !term || "nodex".startsWith(term) || "agent".startsWith(term);
}
