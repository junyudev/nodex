import { z } from "zod";
import { AgentBackendBindingSchema } from "./schemas/agent-backend";
import {
  AgentRuntimeInteractionModeSchema,
  AgentRuntimeModeSchema,
} from "./schemas/agent-runtime-api";

export const AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY = "agent-runtime-composer-choices-v1";

/** Keys for the choices a Composer can hold before execution applies them. */
export const agentRuntimeChoiceKey = {
  draft: (sessionId: string, modelProjectId: string | null) =>
    JSON.stringify([sessionId, modelProjectId]),
  chat: (threadId: string) => JSON.stringify(["thread", threadId]),
};

export const AgentRuntimeComposerOptionsSchema = z
  .array(
    z.strictObject({ id: z.string().min(1).max(128), value: z.union([z.string(), z.boolean()]) }),
  )
  .max(32);

export const AgentRuntimeComposerSelectionSchema = z.strictObject({
  binding: AgentBackendBindingSchema,
  model: z.string().trim().min(1).max(256),
  options: AgentRuntimeComposerOptionsSchema.optional(),
  modeId: z.string().min(1).max(256).optional(),
});

export const AgentRuntimeComposerChoiceSchema = z.strictObject({
  selection: AgentRuntimeComposerSelectionSchema.optional(),
  interactionMode: AgentRuntimeInteractionModeSchema.optional(),
  runtimeMode: AgentRuntimeModeSchema.optional(),
});
