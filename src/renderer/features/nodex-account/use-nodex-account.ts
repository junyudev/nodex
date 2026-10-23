import { useEffect } from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodexAccountErrorCode, NodexAccountSnapshot } from "../../../shared/nodex-account";
import {
  nodexAccountActions,
  nodexAccountQueryKey,
  nodexAccountQueryOptions,
  selectNodexAccountSnapshot,
  subscribeNodexAccountChanges,
  type NodexAccountAction,
} from "@/lib/nodex-account-runtime";

const accountMutationKey = ["nodexAccount", "action"] as const;

interface AccountMutationInput {
  action: NodexAccountAction;
  observedRevision: number;
}

/** Projects Main's Profile account without owning credentials or login lifetime. */
export function useNodexAccount(open: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    return subscribeNodexAccountChanges((snapshot) => {
      const current = queryClient.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey);
      if (current && current.revision >= snapshot.revision) return;
      queryClient.setQueryData<NodexAccountSnapshot>(nodexAccountQueryKey, (current) =>
        selectNodexAccountSnapshot(current, snapshot),
      );
    });
  }, [open, queryClient]);

  const query = useQuery({ ...nodexAccountQueryOptions, enabled: open });
  const mutation = useMutation({
    mutationKey: accountMutationKey,
    networkMode: "always",
    mutationFn: ({ action }: AccountMutationInput) => nodexAccountActions[action](),
    retry: false,
    onSuccess: (snapshot) => {
      const current = queryClient.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey);
      if (current && current.revision > snapshot.revision) return;
      queryClient.setQueryData<NodexAccountSnapshot>(nodexAccountQueryKey, (current) =>
        selectNodexAccountSnapshot(current, snapshot),
      );
    },
  });

  const mutations = useMutationState({
    filters: { mutationKey: accountMutationKey, exact: true },
    select: (entry) => ({
      status: entry.state.status,
      input: entry.state.variables as AccountMutationInput | undefined,
    }),
  });
  const pending = mutations.find((entry) => entry.status === "pending")?.input?.action ?? null;
  const latest = mutations.at(-1);
  const transportFailed =
    latest?.status === "error" &&
    (query.data?.revision ?? -1) <= (latest.input?.observedRevision ?? -1);
  const failure: NodexAccountErrorCode | "transport" | null = pending
    ? null
    : transportFailed || (query.isError && query.data)
      ? "transport"
      : (query.data?.error ?? null);

  const act = (action: NodexAccountAction) => {
    if (queryClient.isMutating({ mutationKey: accountMutationKey, exact: true }) > 0) return;
    mutation.mutate({
      action,
      observedRevision:
        queryClient.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey)?.revision ?? -1,
    });
  };

  return {
    snapshot: query.data,
    loading: query.isPending && !query.isError,
    failed: query.isError && !query.data,
    failure,
    retrying: query.isFetching,
    pending,
    act,
    retry: () => {
      if (query.data) {
        act("refresh");
        return;
      }
      void query.refetch();
    },
  };
}
