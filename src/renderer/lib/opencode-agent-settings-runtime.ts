import type { UpdateOpenCodeAgentSettingsInput } from "../../shared/opencode-agent-settings";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const updateOpenCodeAgentSettingsCommand = defineRendererCommand({
  key: "workbench_settings.opencode_agents.update",
  channel: "settings:opencode-agents:update",
  authority: "main",
  owner: "AgentBackendSettings",
  protocol: { kind: "returned_value" },
});

export const readOpenCodeAgentSettings = () => invokeRendererQuery("settings:opencode-agents:get");

export const updateOpenCodeAgentSettings = (input: UpdateOpenCodeAgentSettingsInput) =>
  invokePlainCommand(updateOpenCodeAgentSettingsCommand, input);
