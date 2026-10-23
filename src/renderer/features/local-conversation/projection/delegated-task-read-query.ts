import type { CodexConversationItem } from "../../../../shared/types";
import type {
  CodexTranscriptReadOwner,
  CodexTranscriptTurnSlice,
} from "../normalized-transcript-read-owner";

/** A contiguous task group reads only its own raw slots; unrelated task bodies stay cold. */
export function createDelegatedTaskReadQuery(
  owner: CodexTranscriptReadOwner | null,
  entityKey: string | null,
  entries: readonly CodexConversationItem[],
  presentationStatus?: CodexTranscriptTurnSlice["presentationStatus"],
) {
  let previous = entries;
  return {
    subscribe: (listener: () => void) => {
      if (!owner || !entityKey) return () => {};
      const releases = entries.map((entry) =>
        owner.subscribeItem(entityKey, entry.rawItemId ?? entry.itemId, listener),
      );
      return () => releases.forEach((release) => release());
    },
    read: (): readonly CodexConversationItem[] => {
      if (!owner || !entityKey) return entries;
      const current = entries.map(
        (entry) =>
          owner.readProjectedItem(
            entityKey,
            entry.rawItemId ?? entry.itemId,
            entry.itemId,
            presentationStatus,
          ) ?? entry,
      );
      if (current.every((entry, index) => entry === previous[index])) return previous;
      previous = Object.freeze(current);
      return previous;
    },
  };
}
