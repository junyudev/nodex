import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { useRefetchOnFocus } from "./use-refetch-on-focus";

const queryKey = ["settings", "open-at-login"] as const;
const setCommand = defineRendererCommand({
  key: "open_at_login.set",
  channel: "settings:open-at-login:set",
  authority: "main",
  owner: "OpenAtLogin",
  protocol: { kind: "returned_value" },
});
const openSystemSettings = defineRendererCommand({
  key: "open_at_login.open_system_settings",
  channel: "settings:open-at-login:open-system-settings",
  authority: "external",
  owner: "OpenAtLogin",
  protocol: { kind: "pending_operation" },
});

export function useOpenAtLoginSettings(open: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => invokeRendererQuery("settings:open-at-login:get"),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  useRefetchOnFocus(open, query.refetch);
  const set = useMutation({
    mutationFn: (enabled: boolean) => invokePlainCommand(setCommand, enabled),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: ({ status }) => {
      client.setQueryData(queryKey, status);
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  const openSettings = useMutation({ mutationFn: () => invokePlainCommand(openSystemSettings) });
  return {
    status: query.data,
    readFailed: query.isError,
    changeFailed: set.isError || set.data?.error === "change-failed",
    openFailed: openSettings.isError,
    saving: set.isPending,
    openingSettings: openSettings.isPending,
    set: set.mutate,
    openSettings: openSettings.mutate,
  };
}
