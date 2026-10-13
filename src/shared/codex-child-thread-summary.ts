import type { ThreadItemEntry, ThreadStatus } from "@nodex/codex-app-server-protocol/v2";
import { projectAssistantText } from "./codex-canonical-item-projector";
import { projectCodexMarkdownToPlainText } from "./codex-markdown-text";

export interface CodexChildThreadSummaryInput {
  readonly hostId: string;
  readonly threadId: string;
}

export interface CodexChildThreadSummary extends CodexChildThreadSummaryInput {
  readonly title: string | null;
  readonly status: ThreadStatus;
  readonly latestReply: string | null;
}

export type CodexCreatedThreadResolveInput =
  | { readonly threadId: string; readonly expectedHostId?: string }
  | { readonly clientThreadId: string; readonly expectedHostId?: string };

export interface CodexCreatedThreadResolution {
  readonly hostId: string;
  readonly threadId: string | null;
  readonly clientThreadId?: string;
  readonly pendingWorktreeId?: string;
  readonly ready: boolean;
  readonly parentThreadId: string | null;
}

/** Reply previews share control-envelope and plain Markdown projection with compact labels. */
export function projectCodexChildReplyText(source: string): string {
  const content = projectAssistantText(source, false);
  return content === null ? "" : projectCodexMarkdownToPlainText(content);
}

/** Items arrive in native descending order. Commentary is a reply only when delivered async. */
export function selectCodexChildThreadReply(items: readonly ThreadItemEntry[]): string | null {
  for (const { item } of items) {
    if (item.type !== "agentMessage" || (item.phase === "commentary" && item.delivery !== "async"))
      continue;
    const reply = projectCodexChildReplyText(item.text);
    if (reply) return reply;
  }
  return null;
}
