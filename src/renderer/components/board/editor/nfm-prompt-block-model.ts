import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import type { AgentRuntimeSessionActivity } from "../../../../shared/agent-runtime-api";

/** Where a Prompt's send button goes: the chat beside the Page, or a new chat. */
export type NfmPromptDestination =
  | { readonly kind: "beside"; readonly sessionId: string; readonly title: string }
  | { readonly kind: "new-chat" };

export type NfmPromptStatusTone = "working" | "attention" | "idle";

export interface NfmPromptSentPresentation {
  readonly tone: NfmPromptStatusTone;
  readonly label: string;
}

/** The last send, as the chat that received it is doing now. */
export function resolveNfmPromptSentPresentation(input: {
  readonly status: AgentRuntimeSessionActivity["status"] | null;
  readonly sentAt: string;
  readonly nowMs?: number;
}): NfmPromptSentPresentation {
  if (input.status === "running") return { tone: "working", label: "Working…" };
  if (input.status === "background") return { tone: "working", label: "Working in background" };
  if (input.status === "waiting") return { tone: "attention", label: "Needs you" };
  const sentAtMs = Date.parse(input.sentAt);
  if (!Number.isFinite(sentAtMs)) return { tone: "idle", label: "Sent" };
  const elapsed = formatCompactRelativeTime(sentAtMs, input.nowMs);
  return { tone: "idle", label: elapsed === "now" ? "Sent just now" : `Sent ${elapsed} ago` };
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
