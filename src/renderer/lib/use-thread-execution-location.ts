import { runWithCleanup } from "./run-with-cleanup";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  CodexAppHandoffOperation,
  ThreadExecutionHandoffInput,
} from "../../shared/codex-thread-handoff";
import { getIntl } from "./i18n";
import { toastFailure } from "./failure-toast";
import { queryKeys } from "./query-keys";
import { moveThreadExecution, useThreadExecutionHandoff } from "./thread-handoff-runtime";

/** One surface's view of moving a chat: what it observes, and the move it started. */
export type ThreadExecutionLocationOwner = ReturnType<typeof useThreadExecutionLocation>;

/** Main owns the move and its recovery; this owner exposes observed progress only. */
export function useThreadExecutionLocation(threadId: string) {
  const queryClient = useQueryClient();
  const observed = useThreadExecutionHandoff(threadId);
  const [admitted, setAdmitted] = useState<CodexAppHandoffOperation | null>(null);
  const [launching, setLaunching] = useState(false);
  const operation =
    admitted?.sourceThreadId === threadId &&
    (!observed ||
      admitted.createdAt > observed.createdAt ||
      (admitted.operationId === observed.operationId && admitted.revision > observed.revision))
      ? admitted
      : observed;
  const settledOperationId =
    operation && operation.status !== "running" ? operation.operationId : null;
  useEffect(() => {
    if (!settledOperationId) return;
    // Every location surface rereads the canonical classification after a move settles, and
    // the composer rechecks the working directory the chat now runs in.
    for (const queryKey of [
      queryKeys.threadExecution.location(threadId),
      queryKeys.threadExecution.workspace(threadId),
    ])
      void queryClient.invalidateQueries({ queryKey, exact: true });
  }, [queryClient, settledOperationId, threadId]);
  // Only the surface that started a move reports its failure, so two open surfaces never both do.
  const failedOperationId =
    operation?.status === "error" && operation.operationId === admitted?.operationId
      ? operation.operationId
      : null;
  const failureMessage = failedOperationId ? (operation?.message ?? undefined) : undefined;
  useEffect(() => {
    if (!failedOperationId) return;
    toastFailure(
      getIntl().formatMessage({
        id: "conversation.threadExecutionLocation.moveError",
        defaultMessage: "Couldn’t move the chat",
      }),
      failureMessage,
    );
  }, [failedOperationId, failureMessage]);
  // A move this surface started and saw through, so it can put away what asked for it.
  const completedOperationId =
    (operation?.status === "success" || operation?.status === "warning") &&
    operation.operationId === admitted?.operationId
      ? operation.operationId
      : null;
  const move = async (
    destination: ThreadExecutionHandoffInput["destination"],
    expectedSource: ThreadExecutionHandoffInput["expectedSource"],
  ) => {
    if (launching || operation?.status === "running" || operation?.recoveryRequired) return;
    setLaunching(true);
    await runWithCleanup(
      async () => {
        const result = await moveThreadExecution({
          threadId,
          operationId: `thread-execution:${crypto.randomUUID()}`,
          destination,
          expectedSource,
        });
        setAdmitted(result);
      },
      { cleanup: () => setLaunching(false) },
    );
  };
  return {
    operation,
    busy: launching || operation?.status === "running",
    blocked: operation?.recoveryRequired ?? false,
    completedOperationId,
    move,
  };
}
