import type { ProviderInteractionMode } from "@t3tools/contracts";

/**
 * The host owns the application tool guidance and supplies it as
 * `hostOrchestrationInstructions`; providers without a system prompt receive
 * it inside the first user prompt instead.
 */
const ACP_DEFAULT_MODE_INSTRUCTIONS = `## Nodex interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Nodex supplies a different interaction-mode instruction.`;

const ACP_PLAN_MODE_INSTRUCTIONS = `## Nodex interaction mode: Plan

Investigate the requested work and resolve discoverable facts before asking questions. Use application tools as needed to gather context and maintain planning content. When the requirements are clear, return a concrete implementation plan. Keep implementation work for an implementation request. Treat this mode as active until Nodex supplies a different interaction-mode instruction.`;

/** Planning intent changes the prompt without narrowing native execution access. */
export function providerPromptForInteraction(prompt: string, mode: ProviderInteractionMode): string {
  if (mode !== "plan" || prompt.trimStart().startsWith("/")) return prompt;
  return `<interaction_mode>\n${ACP_PLAN_MODE_INSTRUCTIONS}\n</interaction_mode>\n\n${prompt}`;
}

export interface AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasAppTools: boolean;
}

/**
 * ACP has no system/developer prompt field, so send Nodex context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function acpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: AcpInstructionState;
  readonly previousState?: AcpInstructionState;
  readonly hostInstructions?: string;
  readonly hostOrchestrationInstructions?: string;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.hostInstructions === undefined &&
    input.hostOrchestrationInstructions === undefined &&
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasAppTools === input.state.hasAppTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? ACP_PLAN_MODE_INSTRUCTIONS
      : ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasAppTools && input.hostOrchestrationInstructions !== undefined
      ? [input.hostOrchestrationInstructions]
      : []),
    ...(input.hostInstructions === undefined ? [] : [input.hostInstructions]),
  ];
  return `<nodex_instructions>\n${instructions.join("\n\n")}\n</nodex_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}
