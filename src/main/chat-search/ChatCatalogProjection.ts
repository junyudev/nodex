import type { components } from "@nodex/core-protocol";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { type ChatActivity, type ChatCatalogEntry } from "../../shared/chat-search";
import {
  summaryOf,
  withSessionMetadata,
  type SessionListingSummary,
} from "../app-tools/SessionDiscovery";

export type ChatListingItem =
  components["schemas"]["CollectionWindow_ProjectWorkspaceSessionListingItem"]["items"][number];
export type ChatRuntimeMetadata = AgentRuntimeOperations["sessions.metadata"]["output"][number];

export const CHAT_CATALOG_MAX_ENTRIES = 10_000;
/** A Member's search through a Space host reads their chats on every request, so fewer. */
export const MEMBER_CHAT_CATALOG_MAX_ENTRIES = 1_000;
const CHAT_PREVIEW_MAX_CHARS = 240;
export interface ChatCatalogItem extends ChatCatalogEntry {
  readonly preview: string;
  readonly opens: { readonly openedAt: number; readonly score: number } | null;
  readonly binding: SessionListingSummary["binding"];
  readonly backend: SessionListingSummary["backend"];
}

const activityOf = (status: string, flags: readonly string[]): ChatActivity => {
  if (status === "systemError") return "error";
  if (flags.includes("waitingOnApproval")) return "waitingOnApproval";
  if (flags.includes("waitingOnUserInput")) return "waitingOnUserInput";
  return status === "active" ? "running" : "idle";
};

/** Catalog and message hits share Core placement and the same bounded presentation. */
export const projectChat = (
  item: ChatListingItem,
  metadata?: ChatRuntimeMetadata,
  includeArchived = false,
): ChatCatalogItem | null => {
  if (
    (!includeArchived && (item.task.session.archived || item.task.thread?.archived)) ||
    item.task.thread?.parent_thread_id ||
    metadata?.relationshipToParent === "subagent"
  )
    return null;
  const base = summaryOf(item);
  const summary = metadata ? withSessionMetadata(base, metadata) : base;
  const createdAt = item.task.thread?.created_at ?? Date.parse(item.task.session.created_at);
  return {
    sessionId: summary.sessionId,
    binding: summary.binding,
    backend: summary.backend,
    threadId: summary.binding?.threadId ?? null,
    title: summary.title,
    preview: Array.from(summary.preview).slice(0, CHAT_PREVIEW_MAX_CHARS).join(""),
    projectId: summary.projectId,
    projectName: summary.projectName,
    cwd: summary.worktreePath ?? item.task.thread?.cwd ?? null,
    branch: summary.branch,
    pullRequests: summary.pullRequests.map(({ number, title, url, repository }) => ({
      number,
      title,
      url,
      repository,
    })),
    pinned: summary.pinned,
    pinnedOrder: item.task.session.pinned_order ?? null,
    unread: item.task.session.unread,
    activity: activityOf(summary.status.status_type, summary.status.active_flags),
    createdAt,
    recencyAt: summary.recencyAt ?? createdAt,
    opens: summary.opens ? { openedAt: summary.opens.openedAt, score: summary.opens.score } : null,
  };
};
