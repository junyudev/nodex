import { useCallback, useContext, useSyncExternalStore } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexRealtimeTimelineEntry } from "../projection/normalized-timeline-entries";
import { BudgetedMarkdownRenderer } from "./shared/markdown/budgeted-markdown-renderer";

/** This leaf reads retained native history; it neither opens a microphone nor starts a call. */
export function LocalConversationRealtimeItem({
  entry,
  conversationId,
  cwd,
}: {
  readonly entry: CodexRealtimeTimelineEntry;
  readonly conversationId: string;
  readonly cwd: string | null;
}) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const subscribe = useCallback(
    (listener: () => void) => owner?.subscribeRealtimeItem(entry.itemId, listener) ?? (() => {}),
    [entry.itemId, owner],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => owner?.readRealtimeItem(entry.itemId) ?? null,
  );
  if (!value) return null;
  const item = value.item;
  if (item.type === "realtimeSessionClosed")
    return <div className="py-2 text-center text-xs text-token-text-tertiary">Voice ended</div>;
  if (item.type === "bemItemPromoted")
    return (
      <ActivitySpinnerIcon
        className="icon-xs text-token-text-tertiary"
        aria-label="Loading conversation item"
      />
    );
  if (item.type !== "transcriptSegment") return null;
  return (
    <div
      data-content-search-turn-key={entry.turnSearchKey}
      data-native-realtime-item-id={item.id}
      className={
        item.role === "user"
          ? "ml-auto w-fit max-w-full rounded-xl bg-token-foreground/5 px-3 py-2"
          : "min-w-0"
      }
    >
      <BudgetedMarkdownRenderer
        content={item.text}
        sourceIdentity={JSON.stringify([conversationId, item.id])}
        sourceAriaLabel={item.role === "user" ? "User message source" : "Assistant message source"}
        cwd={cwd}
        parseIncompleteMarkdown={!value.completed}
        animateStreamingText={!value.completed}
      />
    </div>
  );
}
