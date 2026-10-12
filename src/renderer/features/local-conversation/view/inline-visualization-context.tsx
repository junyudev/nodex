import { createContext, useContext } from "react";
import { DEFAULT_CODEX_HOST_ID } from "../../../../shared/codex-host";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
} from "../normalized-transcript-hooks";

export interface ConversationVisualizationContext {
  readonly hostId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly live: boolean;
  readonly readChangedFilePaths: () => readonly string[];
}

export const ConversationVisualizationContext =
  createContext<ConversationVisualizationContext | null>(null);

export function useConversationVisualizationContext(
  threadId: string,
  turnId: string | null,
  live: boolean,
  suppliedEntityKey?: string,
): ConversationVisualizationContext {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const contextualEntityKey = useContext(CodexTranscriptTurnEntityContext);
  const entityKey = suppliedEntityKey ?? contextualEntityKey;
  const readChangedFilePaths = () =>
    owner && entityKey
      ? (owner.readItemSlots(entityKey)?.entries ?? []).flatMap(({ itemId }) => {
          const item = owner.readItem(entityKey, itemId);
          return item?.type === "fileChange"
            ? item.changes.map((change) =>
                change.kind.type === "update"
                  ? (change.kind.move_path ?? change.path)
                  : change.path,
              )
            : [];
        })
      : [];
  return {
    hostId: owner?.key.hostId ?? DEFAULT_CODEX_HOST_ID,
    threadId,
    turnId,
    live,
    readChangedFilePaths,
  };
}
