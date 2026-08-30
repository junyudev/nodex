import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodexHostMessage } from "./types";
import type {
  CodexSidebarRefreshPolicy,
  CodexSidebarRefreshReason,
  CodexSidebarSnapshot,
  CodexSidebarSyncResult,
  Project,
} from "./types";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import {
  subscribeCodexAutomationRunsUpdates,
  subscribeCodexHostMessages,
  subscribeCodexPendingWorktreesChanged,
  subscribeProjectChanges,
  subscribeProjectSessionChanges,
  subscribeWindowFocusChanges,
} from "./api";
import {
  readCodexSidebarSnapshot,
  reorderCodexSidebarPinnedThreads,
  setCodexSidebarThreadPinned,
  synchronizeCodexSidebar,
} from "./codex-sidebar-runtime";
import { listPendingWorktrees } from "./pending-worktree-runtime";
import { queryKeys } from "./query-keys";
import {
  buildSidebarThreadSyncModel,
  mergePendingWorktreesIntoSidebarSnapshot,
  type CodexSidebarThreadSyncModel,
} from "./codex-sidebar-thread-sync";
import { invalidateProjectSessionScope } from "./project-session-query-cache";

const EMPTY_SIDEBAR_SNAPSHOT: CodexSidebarSnapshot = {
  items: [],
  pinnedThreadIds: [],
  projectAssignments: {},
  projectlessThreadIds: [],
  revision: 0,
  generatedAt: 0,
};

const SIDEBAR_THREAD_SYNC_HEARTBEAT_MS = 60_000;
const SIDEBAR_THREAD_SYNC_DEBOUNCE_MS = 300;
const SIDEBAR_THREAD_SYNC_MOUNT_IDLE_MS = 1_500;

function resolveSidebarSyncReasonForHostMessage(
  message: CodexHostMessage,
): CodexSidebarRefreshReason | null {
  if (message.type === "threadTitleUpdated" || message.type === "threadDeleted")
    return "host-message";
  if (message.type === "sidebarSyncUpdated") return null;
  if (message.type !== "sharedObjectUpdated") return null;
  if (message.object.objectType === "connection") return "app-server-reconnect";
  if (
    message.object.objectType === "threadSummary" ||
    message.object.objectType === "threadStartProgress"
  ) {
    return "host-message";
  }
  return null;
}

function hasSidebarSyncAffectedSessions(result: CodexSidebarSyncResult): boolean {
  return (
    result.changedProjectIds.length > 0 ||
    result.projectlessChanged ||
    result.materializedSessionIds.length > 0 ||
    result.failedThreadIds.length > 0
  );
}

export function useSidebarThreadSyncModel(input: { projects: readonly Project[] }): {
  snapshot: CodexSidebarSnapshot;
  model: CodexSidebarThreadSyncModel;
  loading: boolean;
  applySnapshot: (snapshot: CodexSidebarSnapshot) => void;
  refresh: () => Promise<CodexSidebarSnapshot>;
  setPinned: (threadId: string, pinned: boolean) => Promise<CodexSidebarSnapshot>;
  reorderPinned: (orderedThreadIds: readonly string[]) => Promise<CodexSidebarSnapshot>;
} {
  const { projects } = input;
  const queryClient = useQueryClient();
  const focusedRef = useRef(true);
  const [pendingWorktrees, setPendingWorktrees] = useState<readonly CodexPendingWorktreeEntry[]>(
    [],
  );
  const hostMessageSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery({
    queryKey: queryKeys.codexSidebar.snapshot(),
    queryFn: readCodexSidebarSnapshot,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const applySidebarSyncResult = useCallback(
    (result: CodexSidebarSyncResult) => {
      const queryKey = queryKeys.codexSidebar.snapshot();
      const currentSnapshot = queryClient.getQueryData<CodexSidebarSnapshot>(queryKey);
      const currentRevision = currentSnapshot?.revision;
      const nextRevision = result.snapshot.revision;
      const sameRevision =
        currentRevision !== undefined &&
        nextRevision !== undefined &&
        currentRevision === nextRevision;
      if (!sameRevision) {
        queryClient.setQueryData(queryKey, result.snapshot);
      }
      if (!sameRevision || hasSidebarSyncAffectedSessions(result)) {
        void invalidateProjectSessionScope(queryClient, {
          summaryScopes: [
            ...result.changedProjectIds.map((projectId) => ({
              kind: "project" as const,
              projectId,
            })),
            ...(result.projectlessChanged ? [{ kind: "projectless" as const }] : []),
          ],
          detailInvalidation: {
            kind: "sessions",
            sessionIds: result.materializedSessionIds,
          },
          changeType: "update",
        }).catch(() => undefined);
      }
    },
    [queryClient],
  );

  const requestSidebarSync = useCallback(
    async (
      policy: CodexSidebarRefreshPolicy,
      reason: CodexSidebarRefreshReason,
    ): Promise<CodexSidebarSyncResult> => {
      return await synchronizeCodexSidebar(policy, reason);
    },
    [],
  );

  const syncSidebarThreads = useCallback(
    async (
      policy: CodexSidebarRefreshPolicy,
      reason: CodexSidebarRefreshReason,
    ): Promise<CodexSidebarSyncResult> => {
      const result = await requestSidebarSync(policy, reason);
      applySidebarSyncResult(result);
      return result;
    },
    [applySidebarSyncResult, requestSidebarSync],
  );

  const scheduleHostMessageSync = useCallback(
    (reason: CodexSidebarRefreshReason) => {
      if (hostMessageSyncTimerRef.current !== null) {
        clearTimeout(hostMessageSyncTimerRef.current);
      }
      hostMessageSyncTimerRef.current = setTimeout(() => {
        hostMessageSyncTimerRef.current = null;
        void syncSidebarThreads("stale", reason).catch(() => undefined);
      }, SIDEBAR_THREAD_SYNC_DEBOUNCE_MS);
    },
    [syncSidebarThreads],
  );

  useEffect(
    () => () => {
      if (hostMessageSyncTimerRef.current !== null) {
        clearTimeout(hostMessageSyncTimerRef.current);
        hostMessageSyncTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handle = window.setTimeout(() => {
      void syncSidebarThreads("stale", "mount").catch(() => undefined);
    }, SIDEBAR_THREAD_SYNC_MOUNT_IDLE_MS);
    return () => window.clearTimeout(handle);
  }, [syncSidebarThreads]);

  useEffect(
    () =>
      subscribeCodexHostMessages((message) => {
        if (message.type === "sidebarSyncUpdated") {
          applySidebarSyncResult(message.result);
          return;
        }
        const reason = resolveSidebarSyncReasonForHostMessage(message);
        if (reason) scheduleHostMessageSync(reason);
      }),
    [applySidebarSyncResult, scheduleHostMessageSync],
  );

  useEffect(
    () =>
      subscribeCodexAutomationRunsUpdates(() => {
        void syncSidebarThreads("stale", "host-message").catch(() => undefined);
      }),
    [syncSidebarThreads],
  );

  useEffect(() => {
    let disposed = false;
    void listPendingWorktrees()
      .then((entries) => {
        if (!disposed) setPendingWorktrees(Array.isArray(entries) ? entries : []);
      })
      .catch(() => undefined);
    const unsubscribe = subscribeCodexPendingWorktreesChanged((entries) => {
      setPendingWorktrees([...entries]);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(
    () =>
      subscribeProjectChanges(() => {
        void syncSidebarThreads("force", "project-change").catch(() => undefined);
      }),
    [syncSidebarThreads],
  );

  useEffect(() => {
    const handleProjectSessionChange = (event: ProjectSessionsChangeEvent) => {
      void invalidateProjectSessionScope(queryClient, event).catch(() => undefined);
    };
    return subscribeProjectSessionChanges(handleProjectSessionChange);
  }, [queryClient]);

  useEffect(
    () =>
      subscribeWindowFocusChanges((focused) => {
        focusedRef.current = focused;
        if (focused) void syncSidebarThreads("stale", "focus").catch(() => undefined);
      }),
    [syncSidebarThreads],
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handle = window.setInterval(() => {
      const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
      if (!visible || !focusedRef.current) return;
      void syncSidebarThreads("stale", "heartbeat").catch(() => undefined);
    }, SIDEBAR_THREAD_SYNC_HEARTBEAT_MS);
    return () => window.clearInterval(handle);
  }, [syncSidebarThreads]);

  const snapshot = useMemo(
    () =>
      mergePendingWorktreesIntoSidebarSnapshot(
        query.data ?? EMPTY_SIDEBAR_SNAPSHOT,
        pendingWorktrees,
      ),
    [pendingWorktrees, query.data],
  );
  const model = useMemo(
    () =>
      buildSidebarThreadSyncModel({
        snapshot,
        projects,
      }),
    [projects, snapshot],
  );

  const applySnapshot = useCallback(
    (nextSnapshot: CodexSidebarSnapshot) => {
      queryClient.setQueryData(queryKeys.codexSidebar.snapshot(), nextSnapshot);
      queryClient.setQueryData(
        queryKeys.codexSidebar.pinnedThreads(),
        nextSnapshot.pinnedThreadIds,
      );
    },
    [queryClient],
  );

  const refresh = useCallback(async () => {
    const result = await syncSidebarThreads("force", "manual");
    return result.snapshot;
  }, [syncSidebarThreads]);

  const setPinned = useCallback(
    async (threadId: string, pinned: boolean) => {
      const refreshed = await setCodexSidebarThreadPinned(threadId, pinned);
      applySnapshot(refreshed);
      return refreshed;
    },
    [applySnapshot],
  );

  const reorderPinned = useCallback(
    async (orderedThreadIds: readonly string[]) => {
      const refreshed = await reorderCodexSidebarPinnedThreads(orderedThreadIds);
      applySnapshot(refreshed);
      return refreshed;
    },
    [applySnapshot],
  );

  return {
    snapshot,
    model,
    loading: query.isLoading,
    applySnapshot,
    refresh,
    setPinned,
    reorderPinned,
  };
}
