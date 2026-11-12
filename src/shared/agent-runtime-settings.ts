import { z } from "zod";
import { AgentRuntimeModeSchema } from "./schemas/agent-runtime-api";
import {
  AgentInstructionsSettingsSchema,
  DEFAULT_AGENT_INSTRUCTIONS_SETTINGS,
} from "./agent-instructions-settings";

export const AgentRuntimeTitleModelSchema = z
  .object({ instanceId: z.string().min(1), model: z.string().min(1) })
  .strict();
export type AgentRuntimeTitleModel = z.infer<typeof AgentRuntimeTitleModelSchema>;

export const AgentRuntimeSettingsSchema = z
  .object({
    automaticWorkAtOnce: z.number().int().min(1).max(16).default(4),
    defaultRuntimeMode: AgentRuntimeModeSchema,
    /** Titles chats a person starts; null leaves it to each chat's own model. */
    titleModel: AgentRuntimeTitleModelSchema.nullable(),
    /** The person's own instructions, sent with every Agent turn. */
    instructions: AgentInstructionsSettingsSchema,
  })
  .strict();
export type AgentRuntimeSettings = z.infer<typeof AgentRuntimeSettingsSchema>;

export const UpdateAgentRuntimeSettingsInputSchema = AgentRuntimeSettingsSchema.partial();
export type UpdateAgentRuntimeSettingsInput = z.infer<typeof UpdateAgentRuntimeSettingsInputSchema>;

/** New chats run with full access unless the Profile chooses otherwise. */
export const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  defaultRuntimeMode: "full-access",
  automaticWorkAtOnce: 4,
  titleModel: null,
  instructions: DEFAULT_AGENT_INSTRUCTIONS_SETTINGS,
};
