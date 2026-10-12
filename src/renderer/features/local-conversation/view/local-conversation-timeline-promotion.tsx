import { useCallback, useContext, useSyncExternalStore } from "react";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import { resolveTimelineInlinePresentation } from "../projection/timeline-inline-presentation";
import { BudgetedMarkdownRenderer } from "./shared/markdown/budgeted-markdown-renderer";
import { projectAssistantText } from "../../../../shared/codex-canonical-item-projector";

/** Native inline Markdown shares the bounded renderer; visualization descriptors retain their source identity. */
export function LocalConversationTimelinePromotion({
  entry,
  cwd,
}: {
  readonly entry: CodexTimelineTurnEntry;
  readonly cwd: string | null;
}) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
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
      <div
        data-native-promotion-item-id={itemId}
        data-source-thread-id={presentation.sourceThreadId ?? undefined}
        className="text-sm text-token-text-secondary"
      >
        {presentation.file}
      </div>
    );
  const content =
    projectAssistantText(presentation.content, entry.turnStatus === "inProgress") ?? "";
  return (
    <div data-content-search-turn-key={entry.turnSearchKey} data-native-promotion-item-id={itemId}>
      <BudgetedMarkdownRenderer
        content={content}
        cwd={cwd}
        sourceAriaLabel="Assistant message source"
        sourceIdentity={JSON.stringify([owner?.key.threadId, entry.turnId, itemId])}
        parseIncompleteMarkdown={entry.turnStatus === "inProgress"}
      />
    </div>
  );
}
