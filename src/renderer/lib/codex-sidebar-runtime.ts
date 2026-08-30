import type {
  CodexSidebarRefreshPolicy,
  CodexSidebarRefreshReason,
  CodexSidebarSnapshot,
  CodexSidebarSyncResult,
} from "./types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

const setPinnedThreadCommand = defineRendererCommand({
  key: "codex_sidebar.thread.set_pinned",
  channel: "codex:threads:pinned:set",
  authority: "main",
  owner: "CodexSidebar",
  protocol: { kind: "returned_value" },
});

const reorderPinnedThreadsCommand = defineRendererCommand({
  key: "codex_sidebar.threads.reorder_pinned",
  channel: "codex:threads:pinned:reorder",
  authority: "main",
  owner: "CodexSidebar",
  protocol: { kind: "returned_value" },
});

export function readCodexSidebarSnapshot(): Promise<CodexSidebarSnapshot> {
  return invokeRendererQuery("codex:sidebar:snapshot", { refresh: false });
}

export function synchronizeCodexSidebar(
  policy: CodexSidebarRefreshPolicy,
  reason: CodexSidebarRefreshReason,
): Promise<CodexSidebarSyncResult> {
  return invokeRendererControl("codex:sidebar:sync", { policy, reason });
}

export function setCodexSidebarThreadPinned(
  threadId: string,
  pinned: boolean,
): Promise<CodexSidebarSnapshot> {
  return invokePlainCommand(setPinnedThreadCommand, threadId, { pinned });
}

export function reorderCodexSidebarPinnedThreads(
  orderedThreadIds: readonly string[],
): Promise<CodexSidebarSnapshot> {
  return invokePlainCommand(reorderPinnedThreadsCommand, [...orderedThreadIds]);
}
