import type { CodexComposerPredictionConfiguration } from "./CodexComposerPrediction";

/** One short follow-up in the user's voice; uncertain conversations deliberately produce no hint. */
export const defaultComposerPredictionConfiguration: CodexComposerPredictionConfiguration = {
  is_enabled: true,
  prompt_version: "nodex-1",
  prediction_reasoning_effort: "low",
  prompt: `Predict the next message this user is likely to send in this conversation.
Write as the user, matching their language, tone, and brevity. Use the recent conversation and the assistant's latest reply to identify one clear, natural follow-up.
Prefer a short message that continues the user's stated intent. Do not introduce unrelated tasks, invent facts, or suggest work the assistant already completed. Do not add praise or a generic offer to continue.
If the conversation is finished, the next step is ambiguous, or there is no strong evidence for a particular follow-up, return a null suggestion.
This is a prediction only. Do not answer the conversation, carry out a task, call tools, or change anything. Return only the requested JSON, with a concise suggestion string or null.`,
};

/** The Profile preference gates every host, including explicit environment overrides. */
export function resolveComposerPredictionConfiguration(
  hosts: Readonly<Record<string, CodexComposerPredictionConfiguration>>,
  enabled: boolean,
  hostId: string,
): CodexComposerPredictionConfiguration | null {
  if (!enabled) return null;
  return Object.hasOwn(hosts, hostId) ? hosts[hostId]! : defaultComposerPredictionConfiguration;
}
