import { useEffect } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginAppBinding } from "../../shared/agent-plugins/app-entrypoints";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";
import { isRemoteSpace, spaceQueryKey } from "./renderer-space";
import { McpAppRpcError } from "./mcp-app/mcp-app-host-dispatcher";

const command = <const Name extends "open" | "close" | "request">(name: Name) =>
  defineRendererCommand({
    key: `agent-plugins.app-${name}`,
    channel: `agent-plugins:app-${name}`,
    authority: "main",
    owner: "PluginAppViews",
    protocol: { kind: "returned_value" },
  });

const open = command("open");
const close = command("close");
const request = command("request");
export const pluginAppCatalogKey = () => spaceQueryKey(["agent-plugins", "app-entries"]);
export const pluginAppCatalogOptions = (projectId: string | null) =>
  queryOptions({
    queryKey: [...pluginAppCatalogKey(), projectId],
    enabled: !isRemoteSpace(),
    staleTime: 30_000,
    queryFn: async () => {
      const result = await invokeRendererQuery("agent-plugins:app-entries", projectId);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  });

export const pluginAppAdapter = {
  open: (binding: PluginAppBinding) => invokePlainCommand(open, binding),
  close: (viewId: string) => invokePlainCommand(close, viewId),
  subscribe: (
    callback: Parameters<
      NonNullable<ReturnType<typeof resolveRendererTransport>["subscribePluginAppEvents"]>
    >[0],
  ) => resolveRendererTransport().subscribePluginAppEvents?.(callback) ?? (() => undefined),
  async request(viewId: string, method: string, params: unknown) {
    const result = await invokePlainCommand(request, { viewId, method, params });
    if (result.ok) return result.value;
    const code =
      result.error.code === "unsupported"
        ? -32601
        : result.error.code === "invalid_input"
          ? -32602
          : -32000;
    throw new McpAppRpcError(result.error.message, code);
  },
};

export function usePluginAppEntries(projectId: string | null) {
  return useQuery(pluginAppCatalogOptions(projectId)).data ?? [];
}

export function usePluginAppCatalogChanges() {
  const client = useQueryClient();
  useEffect(
    () =>
      pluginAppAdapter.subscribe((event) => {
        if (event.kind === "catalog-changed")
          void client.resetQueries({ queryKey: pluginAppCatalogKey() });
      }),
    [client],
  );
}
