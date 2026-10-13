import { useCallback, useContext, useSyncExternalStore } from "react";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexRealtimeTimelineEntry } from "../projection/normalized-timeline-entries";
import { useConversationVisualizationContext } from "./inline-visualization-context";
import { MarkdownRenderer } from "./shared/markdown/markdown-renderer";
import { UserMessageText } from "./shared/user-message-collapse";
import { realtimeSearchUnitKey } from "./local-conversation-search-source";
import { LocalConversationPendingArtifact } from "./local-conversation-pending-artifact";

/** This leaf reads retained native history; it neither opens a microphone nor starts a call. */
export function LocalConversationRealtimeItem({
  entry,
  itemId: explicitItemId,
  cwd,
  conversationId,
}: {
  readonly entry: CodexRealtimeTimelineEntry;
  readonly itemId?: string;
  readonly conversationId: string;
  readonly cwd: string | null;
}) {
  const itemId = explicitItemId ?? entry.itemId;
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const subscribe = useCallback(
    (listener: () => void) => owner?.subscribeRealtimeItem(itemId, listener) ?? (() => {}),
    [itemId, owner],
  );
  const value = useSyncExternalStore(subscribe, () => owner?.readRealtimeItem(itemId) ?? null);
  const visualizationContext = useConversationVisualizationContext(
    conversationId,
    null,
    value?.completed === false,
    undefined,
    realtimeSearchUnitKey(entry, itemId),
  );
  if (!value || !owner) return null;
  const item = value.item;
  if (item.type === "realtimeSessionClosed")
    return <div className="py-2 text-center text-xs text-token-text-tertiary">Voice ended</div>;
  if (item.type === "bemItemPromoted")
    return <LocalConversationPendingArtifact ownerKey={owner.key} />;
  if (item.type !== "transcriptSegment") return null;
  return (
    <div
      data-content-search-turn-key={entry.turnKey}
      data-content-search-unit-key={realtimeSearchUnitKey(entry, itemId)}
      data-conversation-role={item.role}
      data-native-realtime-item-id={item.id}
      className={
        item.role === "user"
          ? "ml-auto w-fit max-w-full rounded-xl bg-token-foreground/5 px-3 py-2"
          : "min-w-0"
      }
    >
      {item.role === "user" ? (
        <UserMessageText text={item.text} cwd={cwd} />
      ) : (
        <MarkdownRenderer
          content={item.text}
          dialect="conversation"
          visualizationContext={visualizationContext}
          preserveLineBreaks
          cwd={cwd}
          parseIncompleteMarkdown={!value.completed}
          animateStreamingText={!value.completed}
          adaptiveBuffering={{
            streamId: `${conversationId}:${realtimeSearchUnitKey(entry, itemId)}`,
          }}
        />
      )}
    </div>
  );
}
