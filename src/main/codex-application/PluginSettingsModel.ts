import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { PluginListResponse } from "@nodex/codex-app-server-protocol/v2/PluginListResponse";
import type { McpServerStatus } from "@nodex/codex-app-server-protocol/v2/McpServerStatus";
import type {
  MarketplacesView,
  PluginMcpServersView,
  PluginMcpDeclaration,
} from "../../shared/codex-plugin-settings";
import { isOfficialMarketplace } from "../../shared/codex-plugin-management-model";
import * as Predicate from "effect/Predicate";

export const writablePluginConfigLayer = (response: ConfigReadResponse) =>
  response.layers?.findLast(
    (layer) =>
      layer.name.type === "user" && layer.name.profile == null && layer.disabledReason == null,
  );
export function configuredTable(value: unknown): Record<string, unknown> {
  return Predicate.isObject(value) && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function projectMarketplaces(
  response: PluginListResponse,
  config: ConfigReadResponse,
  managedName: string,
): MarketplacesView {
  const declarations = configuredTable(config.config.marketplaces);
  const userDeclarations = configuredTable(
    configuredTable(writablePluginConfigLayer(config)?.config).marketplaces,
  );
  const names = new Set([
    ...response.marketplaces.map((m) => m.name),
    ...Object.keys(declarations),
  ]);
  return {
    marketplaces: [...names].flatMap((name) => {
      const catalogs = response.marketplaces.filter((m) => m.name === name);
      const declaration = configuredTable(declarations[name]);
      const identities = catalogs.length
        ? catalogs
        : [{ name, path: null, interface: null, plugins: [] }];
      return identities.map((m) => {
        const identity = { name, path: m.path, displayName: m.interface?.displayName ?? null };
        const builtIn = name === managedName || isOfficialMarketplace(identity);
        const configured = Object.hasOwn(declarations, name);
        const userConfigured = Object.hasOwn(userDeclarations, name);
        const sourceType =
          declaration.source_type === "git" || declaration.source_type === "local"
            ? declaration.source_type
            : null;
        const source = typeof declaration.source === "string" ? declaration.source : null;
        return {
          ...identity,
          configured,
          userConfigured,
          builtIn,
          sourceType,
          source,
          refName:
            typeof declaration.ref === "string"
              ? declaration.ref
              : typeof declaration.ref_name === "string"
                ? declaration.ref_name
                : null,
          canUpgrade: configured && !builtIn && sourceType === "git" && !!source?.trim(),
          canRemove: configured && userConfigured && !builtIn,
          pluginCount: new Set(m.plugins.map((plugin) => plugin.id)).size,
        };
      });
    }),
    loadErrors: response.marketplaceLoadErrors,
  };
}
export function projectMcpServers(
  config: ConfigReadResponse,
  statuses: readonly McpServerStatus[],
): PluginMcpServersView {
  const declarations = configuredTable(config.config.mcp_servers);
  const user = configuredTable(
    configuredTable(writablePluginConfigLayer(config)?.config).mcp_servers,
  );
  const names = new Set([...Object.keys(declarations), ...statuses.map((s) => s.name)]);
  return {
    servers: [...names].map((name) => {
      const declaration =
        Predicate.isObject(declarations[name]) && !Array.isArray(declarations[name])
          ? (declarations[name] as PluginMcpDeclaration)
          : null;
      const status = statuses.find((s) => s.name === name) ?? null;
      const pluginId = status?.pluginId ?? null;
      return {
        name,
        declaration,
        status,
        enabled: declaration?.enabled !== false,
        readOnly: pluginId !== null || (declaration !== null && !Object.hasOwn(user, name)),
        pluginId,
      };
    }),
  };
}
export const normalizeConnectorId = (id: string): string =>
  id.startsWith("asdk_app_") ? `connector_${id.slice(9)}` : id;
