import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodexCreatedThreadResult } from "../../../shared/codex-created-thread-result";
import {
  childThreadSummaryQueryOptions,
  createdThreadResolutionQueryOptions,
  createdThreadResolveInput,
} from "../../lib/codex-created-thread-runtime";
import { subscribeCodexEvents } from "../../lib/api";
import { pendingWorktreeRouteTransport } from "../../lib/pending-worktree-runtime";
import { useExistingCreatedThreadHost } from "./created-thread-host-hooks";
import { truncateCreatedThreadReply } from "./projection/created-thread-card-state";

/** Resolution and reply observers share QueryClient; a visible card never starts an unknown host. */
export function useCreatedThreadCardState(result: CodexCreatedThreadResult) {
  const client = useQueryClient();
  const input = createdThreadResolveInput(result);
  const explicit =
    result.kind !== "chatgpt" && "threadId" in result && result.hostId !== undefined
      ? { hostId: result.hostId, threadId: result.threadId, ready: true, parentThreadId: null }
      : null;
  const resolutionOptions = createdThreadResolutionQueryOptions(explicit ? null : input);
  const resolutionQuery = useQuery(resolutionOptions);
  const resolution = explicit ?? resolutionQuery.data ?? null;
  const threadId = resolution?.ready ? resolution.threadId : null;
  const hostId = resolution?.hostId ?? null;
  const { manager, connected } = useExistingCreatedThreadHost(hostId);
  const subscribe = useCallback(
    (listener: () => void) =>
      manager && threadId ? manager.observeThreadMetadata(threadId, listener) : () => {},
    [manager, threadId],
  );
  const residentTitle = useSyncExternalStore(subscribe, () =>
    manager && threadId
      ? (manager.readConversation(threadId)?.canonicalState?.title ??
        manager.readThreadSummary(threadId)?.threadName ??
        null)
      : null,
  );
  const residentWorking = useSyncExternalStore(subscribe, () =>
    manager && threadId
      ? (manager.readConversation(threadId)?.statusType ??
          manager.readThreadSummary(threadId)?.statusType) === "active"
      : false,
  );
  const summaryOptions = childThreadSummaryQueryOptions(
    connected && hostId && threadId ? { hostId, threadId } : null,
  );
  const summaryQuery = useQuery(summaryOptions);
  useEffect(() => {
    if (!input || !resolutionQuery.isEnabled) return;
    const stopPending =
      "clientThreadId" in input
        ? pendingWorktreeRouteTransport.subscribe((entries) => {
            const pending = entries.find((entry) => entry.clientThreadId === input.clientThreadId);
            if (
              pending &&
              pending.launchMode === "start-conversation" &&
              input.expectedHostId !== undefined &&
              (pending.threadStartHostId ?? pending.hostId) !== input.expectedHostId
            )
              return;
            void client.invalidateQueries({ queryKey: resolutionOptions.queryKey });
          })
        : () => {};
    const stopChanges = subscribeCodexEvents((event) => {
      if (event.type !== "createdThreadTargetChanged") return;
      const matches =
        "threadId" in input
          ? event.threadId === input.threadId
          : event.clientThreadId === input.clientThreadId;
      if (!matches || (input.expectedHostId !== undefined && event.hostId !== input.expectedHostId))
        return;
      void client.invalidateQueries({ queryKey: resolutionOptions.queryKey });
    });
    return () => {
      stopPending();
      stopChanges();
    };
  }, [client, input, resolutionOptions.queryKey, resolutionQuery.isEnabled]);
  useEffect(() => {
    if (!hostId || !threadId || !connected) return;
    return subscribeCodexEvents((event) => {
      if (
        event.type !== "createdThreadTargetChanged" ||
        event.hostId !== hostId ||
        event.threadId !== threadId
      )
        return;
      void client.invalidateQueries({ queryKey: summaryOptions.queryKey });
    });
  }, [client, connected, hostId, summaryOptions.queryKey, threadId]);
  const title = residentTitle ?? summaryQuery.data?.title ?? null;
  const isWorking =
    residentWorking ||
    summaryQuery.data?.status.type === "active" ||
    (summaryQuery.isFetching && summaryQuery.data?.latestReply == null);
  const text = summaryQuery.data?.latestReply;
  return {
    title,
    isWorking,
    text: !isWorking && text ? truncateCreatedThreadReply(text) : null,
    resolution,
  };
}
