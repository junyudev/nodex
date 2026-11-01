import { z } from "zod";
import { AgentRuntimeModeSchema } from "./schemas/agent-runtime-api";

export const AgentRuntimeSettingsSchema = z
  .object({
    defaultRuntimeMode: AgentRuntimeModeSchema,
  })
  .strict();
export type AgentRuntimeSettings = z.infer<typeof AgentRuntimeSettingsSchema>;

/** New chats run with full access unless the Profile chooses otherwise. */
export const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  defaultRuntimeMode: "full-access",
};
