import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_MINI_VISIBILITY, type MiniVisibility } from "../../shared/mini";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const MINI_VISIBILITY_KEY = ["settings", "mini-visibility"] as const;

const updateCommand = defineRendererCommand({
  authority: "main",
  channel: "settings:mini-visibility:update",
  key: "settings.mini-visibility.update",
  owner: "Settings",
  protocol: { kind: "returned_value" },
});

/** When Mini rests over other apps, as the Profile chooses it. */
export function useMiniVisibility() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: MINI_VISIBILITY_KEY,
    queryFn: () => invokeRendererQuery("settings:mini-visibility:get"),
  });
  const update = useMutation({
    mutationFn: (visibility: MiniVisibility) => invokePlainCommand(updateCommand, visibility),
    onSuccess: (visibility) => queryClient.setQueryData(MINI_VISIBILITY_KEY, visibility),
  });
  return {
    visibility: query.data ?? DEFAULT_MINI_VISIBILITY,
    loading: query.isPending,
    setVisibility: (visibility: MiniVisibility) => update.mutate(visibility),
  };
}
