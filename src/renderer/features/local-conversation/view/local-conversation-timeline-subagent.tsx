import { useContext, useMemo, useSyncExternalStore } from "react";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import { createSubagentActivityReadQuery } from "../projection/subagent-activity-read-query";
import { resolveSubagentActivityRows } from "../projection/build-renderer-item-stream";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadStageActions,
} from "../thread-stage-types";
import { SubagentActivityInlineRows } from "./blocks/local-conversation-block-leaves";

const emptyRows: readonly ThreadComposerShellBackgroundAgentRowModel[] = Object.freeze([]);
export function LocalConversationTimelineSubagent({
  entry,
  backgroundAgentRows = emptyRows,
  onOpenThread,
  onOpenSubagentsPanel,
}: {
  readonly entry: CodexTimelineTurnEntry;
  readonly backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
}) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const query = useMemo(
    () =>
      createSubagentActivityReadQuery(owner, entry.historyEntityKey, entry.timelineSlice.itemIds),
    [owner, entry.historyEntityKey, entry.timelineSlice.itemIds],
  );
  const activities = useSyncExternalStore(query.subscribe, query.read);
  const target =
    entry.timelineWholeItem?.type === "subagentActivity"
      ? entry.timelineWholeItem.agentThreadId
      : null;
  const rows = resolveSubagentActivityRows({
    activityItems: activities,
    backgroundAgents: backgroundAgentRows.filter((row) => row.conversationId === target),
    laterActivityItems: [],
    turnKey: entry.turnId ?? entry.historyEntityKey,
  });
  if (!owner) return null;
  return (
    <div
      data-native-subagent-item-id={entry.timelineWholeItem?.itemId}
      data-content-search-skip="true"
    >
      <SubagentActivityInlineRows
        rows={rows}
        onOpenThread={onOpenThread}
        onOpenSubagentsPanel={onOpenSubagentsPanel}
        sourceRoot={owner.key}
      />
    </div>
  );
}
