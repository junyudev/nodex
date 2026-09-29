import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_CODEX_HOST_ID } from "../../../../shared/codex-host";
import type { ImageEditComposerTarget } from "@/features/user-attachment-image-editor";

interface ConversationImageAssetContextValue {
  conversationId: string | null;
  hostId: string;
  composerTarget: ImageEditComposerTarget | null;
  resolveHistoryImage?: (
    reference: import("../../../../shared/agent-history-images").AgentHistoryImageReference,
  ) => Promise<string>;
}

const ConversationImageAssetContext = createContext<ConversationImageAssetContextValue>({
  conversationId: null,
  hostId: DEFAULT_CODEX_HOST_ID,
  composerTarget: null,
});

export function ConversationImageAssetProvider({
  children,
  composerTarget = null,
  conversationId,
  hostId,
  resolveHistoryImage,
}: Omit<ConversationImageAssetContextValue, "composerTarget"> & {
  children: ReactNode;
  composerTarget?: ImageEditComposerTarget | null;
}) {
  const value = useMemo(
    () => ({ composerTarget, conversationId, hostId, resolveHistoryImage }),
    [composerTarget, conversationId, hostId, resolveHistoryImage],
  );
  return (
    <ConversationImageAssetContext.Provider value={value}>
      {children}
    </ConversationImageAssetContext.Provider>
  );
}

export function useConversationImageAssetContext(): ConversationImageAssetContextValue {
  return useContext(ConversationImageAssetContext);
}
