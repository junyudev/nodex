import type { CodexConversationItem } from "../../../../shared/types";
import type { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";

type Activity = NonNullable<CodexConversationItem["subagentActivity"]>;
const emptyActivities: readonly Activity[] = Object.freeze([]);

/** A group observes only its native activity addresses, independently of directory updates. */
export function createSubagentActivityReadQuery(
  owner: CodexTranscriptReadOwner | null,
  entityKey: string,
  itemIds: readonly string[],
) {
  let previous: readonly (CodexConversationItem | null)[] = [];
  let value = emptyActivities;
  return {
    subscribe: (listener: () => void) => {
      const releases = itemIds.map((id) => owner?.subscribeItem(entityKey, id, listener));
      return () => releases.forEach((release) => release?.());
    },
    read: () => {
      const items = itemIds.map((id) => owner?.readProjectedItem(entityKey, id, id) ?? null);
      if (
        items.length === previous.length &&
        items.every((item, index) => item === previous[index])
      )
        return value;
      previous = items;
      value = Object.freeze(
        items.flatMap((item) => (item?.subagentActivity ? [item.subagentActivity] : [])),
      );
      return value;
    },
  };
}
