import { createContext, useContext, type ReactNode } from "react";
import type { NfmMoveToDestination } from "./nfm-move-to-menu-model";
import type {
  NfmSendToThreadPreferredTarget,
  NfmSendToThreadRequest,
} from "./nfm-send-to-thread-menu-model";

export interface NfmTextActionMenuRuntimeValue {
  canSendBlocks: boolean;
  sourceProjectId?: string | null;
  sourcePageId?: string | null;
  sendToThreadProjectNameById?: Readonly<Record<string, string>>;
  sendToThreadPreferredTarget?: NfmSendToThreadPreferredTarget | null;
  onMoveBlocksToDestination?: (
    destination: NfmMoveToDestination,
    selectedBlockIds: readonly string[],
  ) => Promise<void> | void;
  onSendBlocksToThread?: (
    request: NfmSendToThreadRequest,
    selectedBlockIds: readonly string[],
  ) => Promise<void> | void;
}

const DEFAULT_TEXT_ACTION_MENU_RUNTIME: NfmTextActionMenuRuntimeValue = {
  canSendBlocks: false,
};

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
