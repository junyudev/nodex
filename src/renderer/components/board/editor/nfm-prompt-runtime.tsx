import { createContext, useContext, type ReactNode } from "react";
import type { NfmPromptDestination } from "./nfm-prompt-block-model";

export interface NfmPromptRuntimeValue {
  /** Where a Prompt sends; null when this Page cannot send to a chat. */
  readonly destination: NfmPromptDestination | null;
  readonly send: (promptBlockId: string) => Promise<void>;
  /** Puts a reply into the Page under its Prompt; offered only while the Page is editable. */
  readonly insertReply: ((promptBlockId: string, reply: string) => void) | null;
  /**
   * Renders a reply as Page content. The editor supplies it, so the Prompt view never depends on
   * the read-only renderer that itself displays Prompts.
   */
  readonly renderReply: ((reply: string) => ReactNode) | null;
  /** The Page whose Linked chats name the chats its Prompts went to. */
  readonly pageId: string | null;
}

/** A Page that cannot send: Prompts show their record, with no send or reply actions. */
export const NFM_INERT_PROMPT_RUNTIME: NfmPromptRuntimeValue = {
  destination: null,
  send: async () => undefined,
  insertReply: null,
  renderReply: null,
  pageId: null,
};

const NfmPromptRuntimeContext = createContext<NfmPromptRuntimeValue>(NFM_INERT_PROMPT_RUNTIME);

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
