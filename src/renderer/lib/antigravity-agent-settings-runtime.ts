import type {
  AntigravityAgentSettings,
  UpdateAntigravityAgentSettingsInput,
} from "../../shared/antigravity-agent-settings";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const updateAntigravityAgentSettingsCommand = defineRendererCommand({
  key: "workbench_settings.antigravity_agents.update",
  channel: "settings:antigravity-agents:update",
  authority: "main",
  owner: "AgentBackendSettings",
  protocol: { kind: "returned_value" },
});

export const readAntigravityAgentSettings = (): Promise<AntigravityAgentSettings> =>
  invokeRendererQuery("settings:antigravity-agents:get");

export const updateAntigravityAgentSettings = (
  input: UpdateAntigravityAgentSettingsInput,
): Promise<AntigravityAgentSettings> =>
  invokePlainCommand(updateAntigravityAgentSettingsCommand, input);
