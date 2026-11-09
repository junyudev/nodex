import { sameExecutionHoldScope } from "../../shared/work-application";
import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import type { ExecutionHoldScope, ExecutionHoldTarget } from "../../shared/work-application";
import { createBoundedOperationId } from "../../shared/operation-identity";
import {
  defineLocalCommitRendererCommand,
  invokeLocalCommitCommand,
  invokeRendererQuery,
} from "./renderer-command";
export const executionHoldsQuery = () =>
  queryOptions({
    queryKey: ["executionHolds"],
    queryFn: () => invokeRendererQuery("work:holds"),
    staleTime: 1_000,
    refetchInterval: 2_000,
  });
export const effectiveHoldQuery = (target: ExecutionHoldTarget) =>
  queryOptions({
    queryKey: ["effectiveExecutionHold", target],
    queryFn: () => invokeRendererQuery("work:effective-hold", target),
    staleTime: 1_000,
    refetchInterval: 2_000,
  });
const command = defineLocalCommitRendererCommand({
  key: "work.setHold",
  channel: "work:set-hold",
  authority: "core",
  owner: "Work",
  protocol: { kind: "receipt_fenced_projection", presentation: "pending" },
});
export const setExecutionHold = (scope: ExecutionHoldScope, paused: boolean) =>
  invokeLocalCommitCommand(command, {
    scope,
    paused,
    operationId: createBoundedOperationId(paused ? "work.pause" : "work.resume"),
  });
export function useExecutionHold(scope: ExecutionHoldScope) {
  const query = useQuery(executionHoldsQuery());
  const client = useQueryClient();
  const paused = query.data?.some((h) => sameExecutionHoldScope(h.scope, scope)) ?? false;
  const setPaused = async (value: boolean) => {
    await client.cancelQueries({ queryKey: ["executionHolds"] });
    await setExecutionHold(scope, value);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["executionHolds"] }),
      client.invalidateQueries({ queryKey: ["effectiveExecutionHold"] }),
    ]);
  };
  return { paused, setPaused };
}
