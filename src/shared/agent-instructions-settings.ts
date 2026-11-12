import { z } from "zod";

/** Whether an Agent opens its artifacts beside the chat with `open_in_nodex`. */
export const ARTIFACT_OPENING_POLICIES = ["when-helpful", "ask-first", "never"] as const;
export const ArtifactOpeningPolicySchema = z.enum(ARTIFACT_OPENING_POLICIES);
export type ArtifactOpeningPolicy = z.infer<typeof ArtifactOpeningPolicySchema>;

/** Standing instructions join every turn's prompt, so their size is bounded. */
export const AGENT_STANDING_INSTRUCTIONS_MAX_LENGTH = 8000;

/** The person's own instructions for every Agent in this Profile. */
export const AgentInstructionsSettingsSchema = z
  .object({
    artifactOpening: ArtifactOpeningPolicySchema,
    standingInstructions: z.string().max(AGENT_STANDING_INSTRUCTIONS_MAX_LENGTH),
  })
  .strict();
export type AgentInstructionsSettings = z.infer<typeof AgentInstructionsSettingsSchema>;

/** Matches the guidance Nodex shipped before these settings existed. */
export const DEFAULT_AGENT_INSTRUCTIONS_SETTINGS: AgentInstructionsSettings = {
  artifactOpening: "when-helpful",
  standingInstructions: "",
};
