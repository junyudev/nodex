import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { SkillSummary } from "@nodex/codex-app-server-protocol/v2/SkillSummary";
import type { PluginDetailMcpServer } from "../../shared/codex-plugin-settings";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { McpServerStatus } from "@nodex/codex-app-server-protocol/v2/McpServerStatus";
import { configuredTable } from "./PluginSettingsModel";

const comparableSkillKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .split(":")
    .map((segment) => segment.replace(/[\s_-]+/gu, ""))
    .join(":");

/** Ambiguous normalized names never enable a switch for an unrelated local skill. */
export function matchPluginDetailSkill(
  pluginName: string,
  skill: SkillSummary,
  installed: readonly SkillMetadata[],
): SkillMetadata | null {
  const unique = [...new Map(installed.map((entry) => [entry.path, entry])).values()];
  const byPath = skill.path ? unique.find((entry) => entry.path === skill.path) : null;
  if (byPath) return byPath;
  if (!skill.path && !skill.name.includes(":") && !pluginName.trim()) return null;
  const name =
    !skill.path && !skill.name.includes(":") ? `${pluginName.trim()}:${skill.name}` : skill.name;
  const exact = unique.find((entry) => entry.name === name);
  if (exact) return exact;
  const matches = unique.filter(
    (entry) => comparableSkillKey(entry.name) === comparableSkillKey(name),
  );
  return matches.length === 1 ? matches[0]! : null;
}

const comparableServerKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/^connector[_-]/u, "")
    .replace(/^mcp[_-]/u, "")
    .replace(/[\s_-]+/gu, "");

export function projectPluginMcpServers(
  names: readonly string[],
  pluginId: string,
  installed: boolean,
  canSetEnabled: boolean,
  config: ConfigReadResponse | null,
  statuses: readonly McpServerStatus[],
): PluginDetailMcpServer[] {
  const declarations = configuredTable(config?.config.mcp_servers);
  return names.map((name) => {
    const matches = Object.entries(declarations).filter(([key, value]) =>
      [key, configuredTable(value).name].some(
        (candidate) =>
          typeof candidate === "string" &&
          comparableServerKey(candidate) === comparableServerKey(name),
      ),
    );
    const key = Object.hasOwn(declarations, name)
      ? name
      : matches.length === 1
        ? matches[0]![0]
        : null;
    const runtime = statuses.find((status) => status.name === (key ?? name));
    const belongsToAnotherPlugin = runtime?.pluginId != null && runtime.pluginId !== pluginId;
    const configKey = installed && !belongsToAnotherPlugin ? key : null;
    return {
      name,
      configKey,
      enabled:
        configKey !== null ? configuredTable(declarations[configKey]).enabled !== false : true,
      installed,
      canSetEnabled: canSetEnabled && installed && configKey !== null,
    };
  });
}
