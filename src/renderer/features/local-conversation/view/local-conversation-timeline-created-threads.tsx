import { useCallback, useContext, useSyncExternalStore } from "react";
import { readNativeCreatedThreadResult } from "../../../../shared/codex-created-thread-result";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import type { ThreadStageActions } from "../thread-stage-types";
import { LocalConversationCreatedThreadCards } from "./local-conversation-created-thread-cards";

export function LocalConversationTimelineCreatedThreads({
  entry,
  onOpenThread,
}: {
  readonly entry: CodexTimelineTurnEntry;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
}) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const itemId = entry.timelineWholeItem?.itemId ?? "";
  const subscribe = useCallback(
    (listener: () => void) =>
      owner && itemId ? owner.subscribeItem(entry.historyEntityKey, itemId, listener) : () => {},
    [entry.historyEntityKey, itemId, owner],
  );
  const item = useSyncExternalStore(
    subscribe,
    () => owner?.readItem(entry.historyEntityKey, itemId) ?? null,
  );
  const result = item ? readNativeCreatedThreadResult(item) : null;
  if (!owner || !result) return null;
  return (
    <div data-native-created-thread-item-id={itemId} data-content-search-skip="true">
      <LocalConversationCreatedThreadCards
        results={Array.from(
          {
            length:
              entry.timelineWholeItem?.type === "createdThreads"
                ? (entry.timelineWholeItem.resultCount ?? 1)
                : 1,
          },
          () => result,
        )}
        onOpenThread={onOpenThread}
        sourceRoot={owner.key}
      />
    </div>
  );
}
