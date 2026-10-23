import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodexAccountErrorCode, NodexAccountSnapshot } from "../../../shared/nodex-account";
import {
  nodexAccountActions,
  nodexAccountQueryKey,
  nodexAccountQueryOptions,
  selectNodexAccountSnapshot,
  subscribeNodexAccountChanges,
  type NodexAccountAction,
} from "@/lib/nodex-account-runtime";

/** Projects Main's Profile account without owning credentials or login lifetime. */
export function useNodexAccount(open: boolean) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<NodexAccountErrorCode | "transport" | null>(null);

  useEffect(() => {
    if (!open) return;
    return subscribeNodexAccountChanges((snapshot) => {
      const current = queryClient.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey);
      if (current && current.revision >= snapshot.revision) return;
      queryClient.setQueryData<NodexAccountSnapshot>(nodexAccountQueryKey, (current) =>
        selectNodexAccountSnapshot(current, snapshot),
      );
      setFailure(snapshot.error);
    });
  }, [open, queryClient]);

  const query = useQuery({ ...nodexAccountQueryOptions, enabled: open });
  const mutation = useMutation({
    mutationFn: (action: NodexAccountAction) => nodexAccountActions[action](),
    retry: false,
    onSuccess: (snapshot) => {
      const current = queryClient.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey);
      if (current && current.revision > snapshot.revision) return;
      queryClient.setQueryData<NodexAccountSnapshot>(nodexAccountQueryKey, (current) =>
        selectNodexAccountSnapshot(current, snapshot),
      );
      setFailure(snapshot.error);
    },
    onError: () => setFailure("transport"),
  });

  return {
    snapshot: query.data,
    loading: query.isPending && !query.isError,
    failed: query.isError && !query.data,
    failure,
    retrying: query.isFetching,
    pending: mutation.isPending ? mutation.variables : null,
    act: (action: NodexAccountAction) => {
      if (mutation.isPending) return;
      setFailure(null);
      mutation.mutate(action);
    },
    retry: () => {
      mutation.reset();
      setFailure(null);
      void query.refetch();
    },
  };
}
