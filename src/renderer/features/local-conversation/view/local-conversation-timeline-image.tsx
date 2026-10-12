import { useCallback, useContext, useSyncExternalStore } from "react";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import { isGeneratedImagePending } from "../projection/generated-image-output";
import { GeneratedImageGallery } from "./shared/generated-image-gallery";

/** A receipt measures one native image; its document and asset lifetimes remain with the gallery. */
export function LocalConversationTimelineImage({
  entry,
}: {
  readonly entry: CodexTimelineTurnEntry;
}) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const itemId = entry.timelineWholeItem?.itemId ?? "";
  const subscribe = useCallback(
    (listener: () => void) =>
      owner && itemId ? owner.subscribeItem(entry.historyEntityKey, itemId, listener) : () => {},
    [owner, itemId, entry.historyEntityKey],
  );
  const item = useSyncExternalStore(subscribe, () =>
    owner && itemId ? owner.readItem(entry.historyEntityKey, itemId) : null,
  );
  if (!owner || entry.timelineWholeItem?.type !== "generatedImage") return null;
  if (item && item.type !== "imageGeneration") return null;
  const pending = item != null && isGeneratedImagePending(item.src, item.status);
  const images = item?.src == null ? [] : [{ id: item.id, src: item.src }];
  const groupId = JSON.stringify([
    owner.key.hostId,
    owner.key.threadId,
    entry.historyEntityKey,
    itemId,
    entry.turnKey,
  ]);
  return (
    <div data-native-image-presentation-id={entry.turnKey} data-native-image-item-id={itemId}>
      {item ? (
        <GeneratedImageGallery
          groupId={groupId}
          images={images}
          pendingImageCount={pending ? 1 : 0}
          pendingImageIds={pending ? [itemId] : []}
          nativeItemIds={[itemId]}
        />
      ) : null}
    </div>
  );
}
