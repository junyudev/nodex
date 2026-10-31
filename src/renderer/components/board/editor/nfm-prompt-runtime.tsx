import { createContext, useContext, type ReactNode } from "react";
import type { NfmPromptDestination } from "./nfm-prompt-block-model";

export interface NfmPromptRuntimeValue {
  /** Where a Prompt sends; null when this Page cannot send to a chat. */
  readonly destination: NfmPromptDestination | null;
  readonly send: (promptBlockId: string) => Promise<void>;
}

const DEFAULT_PROMPT_RUNTIME: NfmPromptRuntimeValue = {
  destination: null,
  send: async () => undefined,
};

const NfmPromptRuntimeContext = createContext<NfmPromptRuntimeValue>(DEFAULT_PROMPT_RUNTIME);

export function NfmPromptRuntimeProvider({
  value,
  children,
}: {
  value: NfmPromptRuntimeValue;
  children: ReactNode;
}) {
  return (
    <NfmPromptRuntimeContext.Provider value={value}>{children}</NfmPromptRuntimeContext.Provider>
  );
}

export function useNfmPromptRuntime(): NfmPromptRuntimeValue {
  return useContext(NfmPromptRuntimeContext);
}
