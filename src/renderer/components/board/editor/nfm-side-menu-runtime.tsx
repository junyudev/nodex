import { createContext, useContext, type ReactNode } from "react";
import type { NfmTurnBlocksIntoInput } from "../../../lib/nfm-turn-into-targets";
import type { NfmMoveToDestination } from "./nfm-move-to-menu-model";

import type {
  NfmSendToThreadPreferredTarget,
  NfmSendToThreadRequest,
} from "./nfm-send-to-thread-menu-model";

export interface NfmSideMenuRuntimeSnapshot {
  canSendToThread?: boolean;
  sendToThreadProjectNameById?: Record<string, string>;
  sendToThreadPreferredTarget?: NfmSendToThreadPreferredTarget | null;
  onSendBlocksToThread?: (
    request: NfmSendToThreadRequest,
    blockIds: readonly string[],
  ) => Promise<void> | void;
  canSendBlocks: boolean;
  hasConvertDividerToThreadSection: boolean;
  sourceProjectId: string | null;
  sourcePageId: string | null;
  onMoveBlocksToDestination: (
    destination: NfmMoveToDestination,
    fallbackBlockId: string,
  ) => Promise<void> | void;
  onConvertDividerToThreadSection: (blockId: string) => void;
  onBlockDragStart: (input: {
    readonly dataTransfer: DataTransfer;
    readonly blockIds: readonly string[];
  }) => void;
  onBlockDragEnd: () => void;
  onDuplicateBlocks: (blockIds: readonly string[]) => boolean;
  onDeleteBlocks: (blockIds: readonly string[]) => boolean;
  onTurnBlocksInto: (input: NfmTurnBlocksIntoInput) => boolean;
}

export interface NfmSideMenuRuntimeValue {
  getSnapshot: () => NfmSideMenuRuntimeSnapshot;
}

const DEFAULT_SIDE_MENU_RUNTIME: NfmSideMenuRuntimeValue = {
  getSnapshot: () => ({
    canSendBlocks: false,
    hasConvertDividerToThreadSection: false,
    sourceProjectId: null,
    sourcePageId: null,
    onMoveBlocksToDestination: () => undefined,
    onConvertDividerToThreadSection: () => undefined,
    onBlockDragStart: () => undefined,
    onBlockDragEnd: () => undefined,
    onDuplicateBlocks: () => false,
    onDeleteBlocks: () => false,
    onTurnBlocksInto: () => false,
  }),
};

const NfmSideMenuRuntimeContext = createContext<NfmSideMenuRuntimeValue>(DEFAULT_SIDE_MENU_RUNTIME);

export function NfmSideMenuRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: NfmSideMenuRuntimeValue;
}) {
  return (
    <NfmSideMenuRuntimeContext.Provider value={value}>
      {children}
    </NfmSideMenuRuntimeContext.Provider>
  );
}

export function useNfmSideMenuRuntime() {
  return useContext(NfmSideMenuRuntimeContext);
}
