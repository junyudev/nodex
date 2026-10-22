import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { CodexThreadSummary } from "../../../shared/types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { workspaceSessionCommands } from "../../lib/workspace-catalog-commands";
import { projectAgentConversation } from "../../../shared/agent-conversation-presentation";
import { copyReadOnlyConversationMarkdown } from "./copy-conversation-markdown";
import type { ConversationRuntime } from "./conversation-runtime";
import type { ConversationProviderPresentation } from "./thread-stage-types";
import {
  acquireNativeConversationHistoryOwner,
  type NativeConversationHistoryOwner,
} from "./native-conversation-history-owner";

const connected = { status: "connected", retries: 0 } as const;
const noChildren = [] as const;

export function createNativeConversationHistoryRuntime(input: {
  readonly sessionId: string;
  readonly summary: Pick<CodexThreadSummary, "threadId" | "executionHostId">;
  readonly backend: Exclude<AgentBackendBinding["kind"], "codex">;
  readonly owner: NativeConversationHistoryOwner;
  readonly retain: () => () => void;
}): ConversationRuntime {
  const { sessionId, summary, backend, owner, retain } = input;
  const matches = (id: string | null) => id === summary.threadId;
  return {
    kind: backend,
    hostId: summary.executionHostId ?? "local",
    sessionId,
    read: (id) => (matches(id) ? owner.getSnapshot().view : null),
    subscribe: (id, listener) => (matches(id) ? owner.subscribe(listener) : () => {}),
    attachment: (id) => {
      if (!matches(id)) return { status: "idle" };
      const current = owner.getSnapshot();
      if (current.error) return { status: "failed", message: current.error };
      return current.view ? { status: "attached" } : { status: "attaching" };
    },
    connection: () => connected,
    role: (id) => (matches(id) && owner.getSnapshot().view ? "follower" : null),
    primaryRequest: () => null,
    children: () => noChildren,
    retain: (id) => (matches(id) ? retain() : () => {}),
    loadHistory: (id) => (matches(id) ? owner.refresh() : Promise.resolve()),
    resume: (id) => (matches(id) ? owner.refresh() : Promise.resolve()),
    markRead: async (id) => {
      if (matches(id)) await workspaceSessionCommands.markUnread(sessionId, { unread: false });
    },
    setPresented: async () => {},
  };
}

/** A native import is a retained history read, not an execution fallback. */
export function useNativeConversationHistoryAdapter(input: {
  readonly sessionId: string;
  readonly summary: CodexThreadSummary;
  readonly backend: Exclude<AgentBackendBinding["kind"], "codex">;
}) {
  const { sessionId, summary, backend } = input;
  const lease = acquireNativeConversationHistoryOwner(sessionId, summary);
  const { owner } = lease;
  useEffect(() => owner.updateSummary(summary), [owner, summary]);
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const runtime = useMemo(
    () =>
      createNativeConversationHistoryRuntime({
        backend,
        summary: { threadId: summary.threadId, executionHostId: summary.executionHostId },
        sessionId,
        owner,
        retain: lease.retain,
      }),
    [backend, lease, owner, sessionId, summary.threadId, summary.executionHostId],
  );
  const provider: ConversationProviderPresentation = {
    kind: backend,
    label: backend === "claude" ? "Claude" : backend === "opencode" ? "OpenCode" : "ACP",
    selection: backend,
    options: [],
    select: () => {
      throw new Error("Native history has no execution owner");
    },
    commands: [],
    error: state.error,
    history: {
      hasOlder: state.hasOlder,
      loading: state.loading,
      windowFull: state.windowFull,
      loadOlder: owner.loadOlder,
    },
    resolveHistoryImage: (reference) =>
      agentBackendRuntime.historyImage({
        threadId: summary.threadId,
        expectedSessionId: reference.sessionId,
        nativeMessageId: reference.nativeMessageId,
        index: reference.index,
      }),
    readToolOutput: (reference) =>
      agentBackendRuntime.toolOutput({
        threadId: summary.threadId,
        expectedSessionId: reference.sessionId,
        nativeMessageId: reference.nativeMessageId,
        toolUseId: reference.toolUseId,
      }),
  };
  const copyMarkdown = () =>
    copyReadOnlyConversationMarkdown({
      title: summary.threadName ?? "Nodex conversation",
      cwd: summary.cwd,
      readPage: async (cursor) => {
        const snapshot = await agentBackendRuntime.history({
          threadId: summary.threadId,
          limit: 50,
          ...(cursor ? { before: cursor } : {}),
        });
        if (snapshot.threadId !== summary.threadId)
          throw new Error("Native history returned another Thread");
        if (snapshot.history?.hasOlder && !snapshot.history.cursor)
          throw new Error("Native history cursor is unavailable");
        return {
          turns: projectAgentConversation({ snapshot }, summary).turns,
          olderCursor: snapshot.history?.hasOlder ? (snapshot.history.cursor ?? null) : null,
        };
      },
    });
  return { runtime, provider, copyMarkdown };
}
