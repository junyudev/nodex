import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_MINI_SETTINGS, type MiniSettings } from "../../shared/mini";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const MINI_SETTINGS_KEY = ["settings", "mini"] as const;

const updateCommand = defineRendererCommand({
  authority: "main",
  channel: "settings:mini:update",
  key: "settings.mini.update",
  owner: "Settings",
  protocol: { kind: "returned_value" },
});

/** Whether Mini is shown over other apps and how it rests, as the Profile keeps it. */
export function useMiniSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: MINI_SETTINGS_KEY,
    queryFn: () => invokeRendererQuery("settings:mini:get"),
  });
  const update = useMutation({
    mutationFn: async (change: Partial<MiniSettings> | "toggle") => {
      if (change !== "toggle") return invokePlainCommand(updateCommand, change);
      const current = await invokeRendererQuery("settings:mini:get");
      return invokePlainCommand(updateCommand, { shown: !current.shown });
    },
    onSuccess: (settings) => queryClient.setQueryData(MINI_SETTINGS_KEY, settings),
  });
  return {
    settings: query.data ?? DEFAULT_MINI_SETTINGS,
    loading: query.isPending,
    change: (change: Partial<MiniSettings>) => update.mutate(change),
    toggle: async () => {
      await update.mutateAsync("toggle");
    },
  };
}
