import { z } from "zod";
import { AgentRuntimeModeSchema } from "./schemas/agent-runtime-api";
import {
  AgentInstructionsSettingsSchema,
  DEFAULT_AGENT_INSTRUCTIONS_SETTINGS,
} from "./agent-instructions-settings";

export const AgentRuntimeWritingModelSchema = z
  .object({ instanceId: z.string().min(1), model: z.string().min(1) })
  .strict();
export type AgentRuntimeWritingModel = z.infer<typeof AgentRuntimeWritingModelSchema>;

export const AgentRuntimeSettingsSchema = z
  .object({
    automaticWorkAtOnce: z.number().int().min(1).max(16).default(4),
    defaultRuntimeMode: AgentRuntimeModeSchema,
    /** Writes chat titles and Git drafts. Null uses automatic model selection. */
    writingModel: AgentRuntimeWritingModelSchema.nullable(),
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
  writingModel: null,
  instructions: DEFAULT_AGENT_INSTRUCTIONS_SETTINGS,
};
