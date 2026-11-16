import { getIntl } from "@/lib/i18n";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import type { ThreadPlanSidePanelTarget } from "../thread-stage-types";

export interface ThreadSummaryPanelPlanRow {
  label: string;
  title: string;
  target: ThreadPlanSidePanelTarget;
}

function resolvePlanTitle(markdownText: string): string | null {
  const match = markdownText.match(/^#\s+(.+)$/mu);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

function isSummaryPanelPlanItem(item: CodexConversationItem): boolean {
  return item.type === "plan" && item.semanticKind === "proposedPlan";
}

export function buildThreadSummaryPanelPlanRow({
  activeThreadId,
  cwd,
  turns,
}: {
  activeThreadId: string | null;
  cwd: string | null;
  turns: readonly CodexConversationTurn[];
}): ThreadSummaryPanelPlanRow | null {
  if (!activeThreadId) return null;

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn || turn.status === "inProgress") continue;

    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (!item || !isSummaryPanelPlanItem(item)) continue;

      const content = item.markdownText?.trim();
      if (!content || item.turnId === null) continue;

      const label =
        resolvePlanTitle(content) ??
        getIntl().formatMessage({
          id: "conversation.threadSummaryPanelPlanModel.plan",
          defaultMessage: "Plan",
        });
      return {
        label,
        title: label,
        target: {
          planKey: turn.turnId || item.itemId,
          threadId: item.threadId,
          turnId: item.turnId,
          itemId: item.itemId,
          content,
          cwd: item.cwd ?? cwd,
          hideCodeBlocks: false,
        },
      };
    }
  }

  return null;
}
