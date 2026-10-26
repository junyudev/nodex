import type {
  PluginQueries,
  PluginCommands,
  PluginManagementChanged,
} from "../../shared/codex-plugin-management";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
const definitions = {
  "plugin-hooks-trust": defineRendererCommand({
    key: "plugins.plugin-hooks-trust",
    channel: "codex:plugins:plugin-hooks-trust",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "plugin-mcp-enabled": defineRendererCommand({
    key: "plugins.plugin-mcp-enabled",
    channel: "codex:plugins:plugin-mcp-enabled",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "app-disconnect": defineRendererCommand({
    key: "plugins.app-disconnect",
    channel: "codex:plugins:app-disconnect",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "mcp-save": defineRendererCommand({
    key: "plugins.mcp-save",
    channel: "codex:plugins:mcp-save",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "mcp-remove": defineRendererCommand({
    key: "plugins.mcp-remove",
    channel: "codex:plugins:mcp-remove",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "mcp-enabled": defineRendererCommand({
    key: "plugins.mcp-enabled",
    channel: "codex:plugins:mcp-enabled",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "mcp-login": defineRendererCommand({
    key: "plugins.mcp-login",
    channel: "codex:plugins:mcp-login",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "skill-install": defineRendererCommand({
    key: "plugins.skill-install",
    channel: "codex:plugins:skill-install",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "skill-uninstall": defineRendererCommand({
    key: "plugins.skill-uninstall",
    channel: "codex:plugins:skill-uninstall",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "prepare-helper": defineRendererCommand({
    key: "plugins.prepare-helper",
    channel: "codex:plugins:prepare-helper",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  install: defineRendererCommand({
    key: "plugins.install",
    channel: "codex:plugins:install",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  uninstall: defineRendererCommand({
    key: "plugins.uninstall",
    channel: "codex:plugins:uninstall",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "set-enabled": defineRendererCommand({
    key: "plugins.set-enabled",
    channel: "codex:plugins:set-enabled",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "skill-enabled": defineRendererCommand({
    key: "plugins.skill-enabled",
    channel: "codex:plugins:skill-enabled",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "marketplace-add": defineRendererCommand({
    key: "plugins.marketplace-add",
    channel: "codex:plugins:marketplace-add",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "marketplace-remove": defineRendererCommand({
    key: "plugins.marketplace-remove",
    channel: "codex:plugins:marketplace-remove",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  "marketplace-upgrade": defineRendererCommand({
    key: "plugins.marketplace-upgrade",
    channel: "codex:plugins:marketplace-upgrade",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
  refresh: defineRendererCommand({
    key: "plugins.refresh",
    channel: "codex:plugins:refresh",
    authority: "main",
    owner: "PluginManager",
    protocol: { kind: "returned_value" },
  }),
} as const;
export const queryPluginManagement = <K extends keyof PluginQueries>(
  name: K,
  input: PluginQueries[K]["input"],
): Promise<PluginQueries[K]["output"]> => invokeRendererQuery(`codex:plugins:${name}`, input);
export function commandPluginManagement<K extends keyof PluginCommands>(
  name: K,
  input: PluginCommands[K]["input"],
): Promise<PluginCommands[K]["output"]> {
  // Each member is audited independently above; this is the correlation seam for the mapped contract.
  return invokePlainCommand(definitions[name], input as never) as Promise<
    PluginCommands[K]["output"]
  >;
}
export function subscribePluginManagement(
  listener: (event: PluginManagementChanged) => void,
): () => void {
  if (!window.api) throw new Error("Plugin management requires the Nodex preload bridge");
  return window.api.on("codex:plugins:changed", (...args: unknown[]) =>
    listener(args[0] as PluginManagementChanged),
  );
}

export function subscribePluginProjectChanges(
  listener: (event: import("../../shared/ipc-api").ProjectsChangeEvent) => void,
): () => void {
  if (!window.api) throw new Error("Plugin management requires the Nodex preload bridge");
  return window.api.on("projects-changed", (...args: unknown[]) =>
    listener(args[0] as import("../../shared/ipc-api").ProjectsChangeEvent),
  );
}
