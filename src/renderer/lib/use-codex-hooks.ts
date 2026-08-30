import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  CodexHookStatePatch,
  CodexHooksListInput,
  CodexHooksListResponse,
} from "../../shared/codex-hooks";
import { subscribeCodexHooksChanged } from "./api";
import { queryKeys } from "./query-keys";
import { codexHooksListQueryOptions } from "./query-options";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const updateCodexHookStateCommand = defineRendererCommand({
  key: "codex_hooks.update_state",
  channel: "codex:hooks:state:update",
  authority: "main",
  owner: "CodexHooks",
  protocol: { kind: "returned_value" },
});

interface HooksQuerySnapshot {
  queryKey: QueryKey;
  value: CodexHooksListResponse | undefined;
}

export function applyCodexHookStatePatch(
  response: CodexHooksListResponse | undefined,
  patch: CodexHookStatePatch,
): CodexHooksListResponse | undefined {
  if (!response) return response;

  return {
    data: response.data.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((hook) => {
        if (hook.key !== patch.key) return hook;
        return {
          ...hook,
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.trustedHash === hook.currentHash ? { trustStatus: "trusted" as const } : {}),
        };
      }),
    })),
  };
}

export function normalizeCodexHooksCwds(cwds: readonly string[]): string[] {
  return Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)));
}

export function useCodexHooksList(input: CodexHooksListInput) {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeCodexHooksChanged(({ hostId }) => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.codexHooks.host(hostId),
        });
      }),
    [queryClient],
  );

  return useQuery(
    codexHooksListQueryOptions({
      hostId: input.hostId,
      cwds: normalizeCodexHooksCwds(input.cwds),
    }),
  );
}

export function useCodexHookStateMutation(hostId: string) {
  const queryClient = useQueryClient();
  const hostQueryKey = queryKeys.codexHooks.host(hostId);

  return useMutation({
    mutationFn: (patch: CodexHookStatePatch) =>
      invokePlainCommand(updateCodexHookStateCommand, {
        hostId,
        patches: [patch],
      }),
    onMutate: async (patch): Promise<HooksQuerySnapshot[]> => {
      await queryClient.cancelQueries({ queryKey: hostQueryKey });
      const snapshots = queryClient
        .getQueriesData<CodexHooksListResponse>({ queryKey: hostQueryKey })
        .map(([queryKey, value]) => ({ queryKey, value }));

      queryClient.setQueriesData<CodexHooksListResponse>({ queryKey: hostQueryKey }, (current) =>
        applyCodexHookStatePatch(current, patch),
      );
      return snapshots;
    },
    onError: (_error, _patch, snapshots) => {
      for (const snapshot of snapshots ?? []) {
        queryClient.setQueryData(snapshot.queryKey, snapshot.value);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: hostQueryKey });
    },
  });
}
