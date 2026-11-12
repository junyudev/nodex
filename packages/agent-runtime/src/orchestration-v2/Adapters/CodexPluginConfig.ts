import type { PluginSummary } from "@nodex/codex-app-server-protocol/v2/PluginSummary";
import type { CodexPluginDelivery } from "@nodex/provider-core/server/ExecutionHost";

export function decideCodexNativePluginOverrides(
  identities: readonly string[],
  nativePlugins: readonly Pick<PluginSummary, "id" | "name" | "enabled" | "installed">[],
) {
  const duplicates = nativePlugins.filter(
    (plugin) => plugin.installed && plugin.enabled && identities.includes(plugin.name),
  );
  const conflict = duplicates.find(
    ({ id, name }) => !id.startsWith(name + "@") || !/^[a-z0-9_-]+@[a-z0-9_-]+$/iu.test(id),
  );
  if (conflict) return { status: "conflict", identity: conflict.name } as const;
  return {
    status: "ready",
    overrides: Object.fromEntries(duplicates.map(({ id }) => [`plugins.${id}.enabled`, false])),
  } as const;
}

export const codexPluginServerConfig = (servers: CodexPluginDelivery["servers"]) =>
  Object.fromEntries(
    servers.map(({ key, url, authorization }) => [
      `mcp_servers.${key}`,
      { url, http_headers: { Authorization: authorization } },
    ]),
  );
