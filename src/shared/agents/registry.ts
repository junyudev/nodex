import { acpRegistryAgent } from "./acp-registry.ts";
import { antigravityAgent } from "./antigravity.ts";
import { claudeAgent } from "./claude.ts";
import { codexAgent } from "./codex.ts";
import type { AgentDefinition } from "./definition.ts";
import { openCodeAgent } from "./opencode.ts";

const fallback: AgentDefinition = {
  driver: "",
  label: "Agent",
  profileBased: false,
  capabilities: {},
};

export const agentSettingsSections = [
  codexAgent,
  claudeAgent,
  antigravityAgent,
  { settingsAnchor: "keys" },
  openCodeAgent,
  acpRegistryAgent,
] as const;

export type AgentSettingsAnchor = (typeof agentSettingsSections)[number]["settingsAnchor"];
const definitions = agentSettingsSections.filter((section) => "driver" in section);
export const agentDefinitions: readonly AgentDefinition[] = definitions;
export const profileAgentDefinitions = definitions.filter((definition) => "profile" in definition);
export type ProfileAgentDefinition = (typeof profileAgentDefinitions)[number];
export type ProfileAgentDriver = ProfileAgentDefinition["driver"];

export const profileAgentDefinition = (driver: unknown) =>
  profileAgentDefinitions.find((definition) => definition.driver === driver);

const byDriver = new Map<string, AgentDefinition>();
for (const definition of agentDefinitions) {
  for (const driver of [definition.driver, ...(definition.aliases ?? [])]) {
    if (byDriver.has(driver)) throw new Error(`Duplicate Agent driver: ${driver}`);
    byDriver.set(driver, definition);
  }
}

export const agentDefinition = (driver: string | null | undefined): AgentDefinition =>
  (driver && byDriver.get(driver)) || fallback;

/**
 * The built-in Agent an ACP Registry identity belongs to. A built-in Agent has one identity in
 * Nodex, so ACP connects only Agents Nodex does not build in.
 */
export const builtInAgentForRegistryId = (
  agentId: string | null | undefined,
): AgentDefinition | undefined =>
  agentId
    ? agentDefinitions.find(({ registryAgentIds }) => registryAgentIds?.includes(agentId))
    : undefined;

/** Driver aliases share a definition while exact instance routing keeps its original driver. */
export function sameAgentDriver(left: string, right: string): boolean {
  if (left === right) return true;
  const definition = agentDefinition(left);
  return definition !== fallback && definition === agentDefinition(right);
}

export const agentAttributionLabel = (driver: string): string => {
  const definition = agentDefinition(driver);
  return definition.attributionLabel ?? definition.label;
};
