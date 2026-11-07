import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { UpdateAgentRuntimeSettingsInput } from "../../shared/agent-runtime-settings";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

export const agentRuntimeSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "agent-runtime"],
    queryFn: () => invokeRendererQuery("settings:agent-runtime:get"),
  });
const updateCommand = defineRendererCommand({
  key: "agent_runtime_settings.update",
  channel: "settings:agent-runtime:update",
  authority: "main",
  owner: "AgentRuntimeSettings",
  protocol: { kind: "returned_value" },
});
export async function updateAgentRuntimeSettings(
  client: QueryClient,
  input: UpdateAgentRuntimeSettingsInput,
) {
  const settings = await invokePlainCommand(updateCommand, input);
  client.setQueryData(agentRuntimeSettingsQueryOptions().queryKey, settings);
  return settings;
}
