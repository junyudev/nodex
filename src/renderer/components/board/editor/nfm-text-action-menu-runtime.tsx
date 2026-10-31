import { createContext, useContext, type ReactNode } from "react";
import type {
  NfmSendToThreadPreferredTarget,
  NfmSendToThreadRequest,
} from "./nfm-send-to-thread-menu-model";

/** Chat actions the editor offers for a text selection's Blocks. */
export interface NfmTextActionMenuChatRuntime {
  readonly projectId: string | null;
  /** The Page the selection belongs to, whose Linked chats lead the picker. */
  readonly sourcePageId?: string | null;
  readonly projectNameById?: Readonly<Record<string, string>>;
  /** The chat this Page is shown beside; sends go there without a picker. */
  readonly contextualTarget: NfmSendToThreadPreferredTarget | null;
  readonly send: (
    request: NfmSendToThreadRequest,
    selectedBlockIds: readonly string[],
  ) => Promise<void> | void;
  readonly addToComposer?: (selectedBlockIds: readonly string[]) => Promise<void> | void;
}

export interface NfmTextActionMenuRuntimeValue {
  readonly chat?: NfmTextActionMenuChatRuntime | null;
}

const DEFAULT_TEXT_ACTION_MENU_RUNTIME: NfmTextActionMenuRuntimeValue = {};

const NfmTextActionMenuRuntimeContext = createContext<NfmTextActionMenuRuntimeValue>(
  DEFAULT_TEXT_ACTION_MENU_RUNTIME,
);

export function NfmTextActionMenuRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: NfmTextActionMenuRuntimeValue;
}) {
  return (
    <NfmTextActionMenuRuntimeContext.Provider value={value}>
      {children}
    </NfmTextActionMenuRuntimeContext.Provider>
  );
}

export function useNfmTextActionMenuRuntime() {
  return useContext(NfmTextActionMenuRuntimeContext);
}
