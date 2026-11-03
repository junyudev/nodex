import { useMutation, useQuery } from "@tanstack/react-query";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { useRefetchOnFocus } from "./use-refetch-on-focus";

const openStartupSettings = defineRendererCommand({
  key: "windows_startup.open_settings",
  channel: "windows-startup:open-settings",
  authority: "external",
  owner: "WindowsTrayRuntime",
  protocol: { kind: "pending_operation" },
});

export function useWindowsStartupSettings(enabled: boolean) {
  const query = useQuery({
    queryKey: ["windows-startup"],
    queryFn: () => invokeRendererQuery("windows-startup:status"),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  useRefetchOnFocus(enabled, query.refetch);
  const open = useMutation({ mutationFn: () => invokePlainCommand(openStartupSettings) });
  return {
    status: query.data,
    loading: query.isPending,
    error: query.error ?? open.error,
    open: () => open.mutate(),
    busy: open.isPending,
  };
}
