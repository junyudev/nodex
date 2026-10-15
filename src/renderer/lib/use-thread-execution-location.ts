import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  CodexAppHandoffOperation,
  ThreadExecutionHandoffInput,
} from "../../shared/codex-thread-handoff";
import { queryKeys } from "./query-keys";
import { moveThreadExecution, useThreadExecutionHandoff } from "./thread-handoff-runtime";

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
    // Every location surface rereads the canonical classification after a move settles.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.threadExecution.location(threadId),
      exact: true,
    });
  }, [queryClient, settledOperationId, threadId]);
  const move = async (destination: ThreadExecutionHandoffInput["destination"]) => {
    if (launching || operation?.status === "running" || operation?.recoveryRequired) return;
    setLaunching(true);
    try {
      const result = await moveThreadExecution({
        threadId,
        operationId: `thread-execution:${crypto.randomUUID()}`,
        destination,
      });
      setAdmitted(result);
    } finally {
      setLaunching(false);
    }
  };
  return {
    operation,
    busy: launching || operation?.status === "running",
    blocked: operation?.recoveryRequired ?? false,
    move,
  };
}
