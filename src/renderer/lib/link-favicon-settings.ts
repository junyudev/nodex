import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const queryKey = ["settings", "link-favicons"] as const;

const updateCommand = defineRendererCommand({
  key: "link_favicon_settings.update",
  channel: "settings:link-favicons:update",
  authority: "main",
  owner: "link-favicon-settings",
  protocol: { kind: "returned_value" },
});

export function subscribeLinkFaviconSettings(client: QueryClient): () => void {
  return (
    resolveRendererTransport().subscribeLinkFaviconSettingsChanges?.((enabled) => {
      client.setQueryData(queryKey, enabled);
      // Icons shown follow the setting both ways: turned off, Main answers every host with none;
      // turned on, a lookup started while it was off may still be in flight with that answer.
      const filters = { queryKey: queryKeys.linkFavicons.all() };
      void client.cancelQueries(filters).then(() => client.invalidateQueries(filters));
    }) ?? (() => {})
  );
}

export function useLinkFaviconSettings(open: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => invokeRendererQuery("settings:link-favicons:get"),
    enabled: open,
    retry: false,
  });
  const set = useMutation({
    mutationFn: (enabled: boolean) => invokePlainCommand(updateCommand, enabled),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: (enabled) => {
      client.setQueryData(queryKey, enabled);
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  return { enabled: query.data, saving: set.isPending, set: set.mutate };
}
