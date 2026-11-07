import { createContext } from "react";
import { resolveImageInputSupport } from "@/lib/content-image";
import type { AgentModelOption } from "../../../shared/types";
import { supportsConversationProviderControl } from "./conversation-provider-controls";
import type { ConversationProviderPresentation } from "./thread-stage-types";

export interface ConversationImageInput {
  readonly supported: boolean;
  readonly unavailableReason: string | null;
}

/** Whether what a conversation sends next can carry images: its Agent's controls and its model's. */
export function resolveConversationImageInput(input: {
  readonly provider: ConversationProviderPresentation | undefined;
  readonly availableModels: readonly AgentModelOption[];
  readonly selectedModel: string | null;
}): ConversationImageInput {
  return {
    supported:
      supportsConversationProviderControl(input.provider, "images") &&
      resolveImageInputSupport({
        models: input.availableModels,
        selectedModel: input.selectedModel,
      }),
    unavailableReason: input.provider?.imageInputUnavailableReason ?? null,
  };
}

/**
 * The transcript's view of that answer. A message rewritten there is sent as the conversation's
 * next message, and the rows between it and the stage are memoized on their own props.
 */
export const ConversationImageInputContext = createContext<ConversationImageInput>({
  supported: true,
  unavailableReason: null,
});
