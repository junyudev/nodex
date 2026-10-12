import { useCallback, useContext, useSyncExternalStore } from "react";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import { resolveTimelineInlinePresentation } from "../projection/timeline-inline-presentation";
import { MarkdownRenderer } from "./shared/markdown/markdown-renderer";
import { projectAssistantText } from "../../../../shared/codex-canonical-item-projector";
import { inlineMarkdownSearchUnitKey } from "./local-conversation-search-source";
import {
  ConversationVisualizationContext,
  useConversationVisualizationContext,
} from "./inline-visualization-context";
import { LocalConversationInlineVisualization } from "./local-conversation-inline-visualization";

/** Native inline Markdown retains rich content; visualization descriptors retain their source identity. */
export function LocalConversationTimelinePromotion({
  entry,
  cwd,
}: {
  readonly entry: CodexTimelineTurnEntry;
  readonly cwd: string | null;
}) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const visualizationContext = useConversationVisualizationContext(
    owner?.key.threadId ?? "",
    entry.turnId,
    entry.turnStatus === "inProgress",
    entry.historyEntityKey,
  );
  const itemId = entry.timelineSlice.itemIds[0];
  const subscribe = useCallback(
    (listener: () => void) =>
      owner && itemId ? owner.subscribeItem(entry.historyEntityKey, itemId, listener) : () => {},
    [entry.historyEntityKey, itemId, owner],
  );
  const raw = useSyncExternalStore(subscribe, () =>
    owner && itemId ? owner.readItem(entry.historyEntityKey, itemId) : null,
  );
  if (!entry.timelinePresentation) return null;
  const presentation = resolveTimelineInlinePresentation(raw, entry.timelinePresentation);
  if (!presentation) return null;
  if (presentation.type === "visualization")
    return (
      <ConversationVisualizationContext.Provider value={visualizationContext}>
        <div
          data-native-promotion-item-id={itemId}
          data-source-thread-id={presentation.sourceThreadId ?? undefined}
        >
          <LocalConversationInlineVisualization
            file={presentation.file}
            sourceThreadId={presentation.sourceThreadId}
            cacheKey={entry.turnKey}
            mode="narrow"
          />
        </div>
      </ConversationVisualizationContext.Provider>
    );
  const content =
    projectAssistantText(presentation.content, entry.turnStatus === "inProgress") ?? "";
  return (
    <div
      data-content-search-turn-key={entry.turnKey}
      data-content-search-unit-key={inlineMarkdownSearchUnitKey(entry)}
      data-native-promotion-item-id={itemId}
    >
      <MarkdownRenderer
        content={content}
        cwd={cwd}
        parseIncompleteMarkdown={entry.turnStatus === "inProgress"}
        visualizationContext={visualizationContext}
      />
    </div>
  );
}
