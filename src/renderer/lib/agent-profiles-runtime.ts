import { agentProfilesFor, type AgentProfilesUpdate } from "../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../shared/agents/registry";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const updateProfilesCommand = defineRendererCommand({
  key: "workbench_settings.agent_profiles.update",
  channel: "settings:agent-profiles:update",
  authority: "main",
  owner: "AgentBackendSettings",
  protocol: { kind: "returned_value" },
});

export async function readAgentProfiles<Driver extends ProfileAgentDriver>(driver: Driver) {
  const result = await invokeRendererQuery("settings:agent-profiles:get", driver);
  return { instances: agentProfilesFor(result.instances, driver) };
}

export const updateAgentProfiles = (input: AgentProfilesUpdate) =>
  invokePlainCommand(updateProfilesCommand, input);
