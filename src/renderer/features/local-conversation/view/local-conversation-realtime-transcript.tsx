import type { CodexRealtimeTimelineEntry } from "../projection/normalized-timeline-entries";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";

/** The row owns measurement; each native segment independently subscribes to its text. */
export function LocalConversationRealtimeTranscript({
  entry,
  conversationId,
  cwd,
}: {
  readonly entry: CodexRealtimeTimelineEntry;
  readonly conversationId: string;
  readonly cwd: string | null;
}) {
  if (entry.itemType !== "transcriptSegment")
    return (
      <LocalConversationRealtimeItem entry={entry} conversationId={conversationId} cwd={cwd} />
    );
  return (
    <section data-content-search-turn-key={entry.turnSearchKey}>
      <div className="flex flex-col gap-6">
        {entry.segmentIds.map((itemId) => (
          <LocalConversationRealtimeItem
            key={itemId}
            entry={entry}
            itemId={itemId}
            conversationId={conversationId}
            cwd={cwd}
          />
        ))}
      </div>
    </section>
  );
}
