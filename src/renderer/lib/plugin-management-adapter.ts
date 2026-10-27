import type {
  PluginQueries,
  PluginCommands,
  PluginManagementChanged,
} from "../../shared/codex-plugin-management";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
const appToolEnabledCommand = defineRendererCommand({
  key: "plugins.app-tool-enabled",
  channel: "codex:plugins:app-tool-enabled",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const appEnabledCommand = defineRendererCommand({
  key: "plugins.app-enabled",
  channel: "codex:plugins:app-enabled",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const pluginHooksTrustCommand = defineRendererCommand({
  key: "plugins.plugin-hooks-trust",
  channel: "codex:plugins:plugin-hooks-trust",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const pluginMcpEnabledCommand = defineRendererCommand({
  key: "plugins.plugin-mcp-enabled",
  channel: "codex:plugins:plugin-mcp-enabled",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const appDisconnectCommand = defineRendererCommand({
  key: "plugins.app-disconnect",
  channel: "codex:plugins:app-disconnect",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const mcpSaveCommand = defineRendererCommand({
  key: "plugins.mcp-save",
  channel: "codex:plugins:mcp-save",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const mcpRemoveCommand = defineRendererCommand({
  key: "plugins.mcp-remove",
  channel: "codex:plugins:mcp-remove",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const mcpEnabledCommand = defineRendererCommand({
  key: "plugins.mcp-enabled",
  channel: "codex:plugins:mcp-enabled",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const mcpLoginCommand = defineRendererCommand({
  key: "plugins.mcp-login",
  channel: "codex:plugins:mcp-login",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const skillInstallCommand = defineRendererCommand({
  key: "plugins.skill-install",
  channel: "codex:plugins:skill-install",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const skillUninstallCommand = defineRendererCommand({
  key: "plugins.skill-uninstall",
  channel: "codex:plugins:skill-uninstall",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const prepareHelperCommand = defineRendererCommand({
  key: "plugins.prepare-helper",
  channel: "codex:plugins:prepare-helper",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const installCommand = defineRendererCommand({
  key: "plugins.install",
  channel: "codex:plugins:install",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const uninstallCommand = defineRendererCommand({
  key: "plugins.uninstall",
  channel: "codex:plugins:uninstall",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const setEnabledCommand = defineRendererCommand({
  key: "plugins.set-enabled",
  channel: "codex:plugins:set-enabled",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const skillEnabledCommand = defineRendererCommand({
  key: "plugins.skill-enabled",
  channel: "codex:plugins:skill-enabled",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const marketplaceAddCommand = defineRendererCommand({
  key: "plugins.marketplace-add",
  channel: "codex:plugins:marketplace-add",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const marketplaceRemoveCommand = defineRendererCommand({
  key: "plugins.marketplace-remove",
  channel: "codex:plugins:marketplace-remove",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const marketplaceUpgradeCommand = defineRendererCommand({
  key: "plugins.marketplace-upgrade",
  channel: "codex:plugins:marketplace-upgrade",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

const refreshCommand = defineRendererCommand({
  key: "plugins.refresh",
  channel: "codex:plugins:refresh",
  authority: "main",
  owner: "PluginManager",
  protocol: { kind: "returned_value" },
});

type PluginCommandHandlers = {
  readonly [K in keyof PluginCommands]: (
    input: PluginCommands[K]["input"],
  ) => Promise<PluginCommands[K]["output"]>;
};

const commands: PluginCommandHandlers = {
  "app-tool-enabled": (input) => invokePlainCommand(appToolEnabledCommand, input),
  "app-enabled": (input) => invokePlainCommand(appEnabledCommand, input),
  "plugin-hooks-trust": (input) => invokePlainCommand(pluginHooksTrustCommand, input),
  "plugin-mcp-enabled": (input) => invokePlainCommand(pluginMcpEnabledCommand, input),
  "app-disconnect": (input) => invokePlainCommand(appDisconnectCommand, input),
  "mcp-save": (input) => invokePlainCommand(mcpSaveCommand, input),
  "mcp-remove": (input) => invokePlainCommand(mcpRemoveCommand, input),
  "mcp-enabled": (input) => invokePlainCommand(mcpEnabledCommand, input),
  "mcp-login": (input) => invokePlainCommand(mcpLoginCommand, input),
  "skill-install": (input) => invokePlainCommand(skillInstallCommand, input),
  "skill-uninstall": (input) => invokePlainCommand(skillUninstallCommand, input),
  "prepare-helper": (input) => invokePlainCommand(prepareHelperCommand, input),
  install: (input) => invokePlainCommand(installCommand, input),
  uninstall: (input) => invokePlainCommand(uninstallCommand, input),
  "set-enabled": (input) => invokePlainCommand(setEnabledCommand, input),
  "skill-enabled": (input) => invokePlainCommand(skillEnabledCommand, input),
  "marketplace-add": (input) => invokePlainCommand(marketplaceAddCommand, input),
  "marketplace-remove": (input) => invokePlainCommand(marketplaceRemoveCommand, input),
  "marketplace-upgrade": (input) => invokePlainCommand(marketplaceUpgradeCommand, input),
  refresh: (input) => invokePlainCommand(refreshCommand, input),
};
export const queryPluginManagement = <K extends keyof PluginQueries>(
  name: K,
  input: PluginQueries[K]["input"],
): Promise<PluginQueries[K]["output"]> => invokeRendererQuery(`codex:plugins:${name}`, input);
export function commandPluginManagement<K extends keyof PluginCommands>(
  name: K,
  input: PluginCommands[K]["input"],
): Promise<PluginCommands[K]["output"]> {
  return commands[name](input);
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
