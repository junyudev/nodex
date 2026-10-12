import type { ThreadItem, ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";
import { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { projectNormalizedTimelineEntries } from "./normalized-timeline-entries";

const key = { hostId: "local", threadId: "thread" };
export function timelineOwnerFixture(page: ThreadTimelineListResponse, items: ThreadItem[] = []) {
  const state = createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: key.threadId,
      historyMode: "paginated",
      cliVersion: "0.162.0-alpha.17.2",
      turns: items.length
        ? [
            {
              id: "one",
              items,
              itemsView: "full",
              rootTurnId: null,
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1000,
            },
          ]
        : [],
    },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
  const owner = new CodexTranscriptReadOwner(key);
  const canonicalState = {
    ...state,
    itemTimeline: {
      entries: page.data.map((entry) =>
        entry.type === "item"
          ? { ...entry, item: { id: entry.item.id, type: entry.item.type, completed: true } }
          : entry,
      ),
      activeRealtimeSessionAtPageStart: page.activeRealtimeSessionAtPageStart,
    },
    realtimeItems: Object.fromEntries(
      page.data.flatMap((entry) =>
        entry.type === "realtime" ? [[entry.item.id, { item: entry.item, completed: true }]] : [],
      ),
    ),
  };
  owner.applyEvent({ type: "reset", value: projectCodexTranscript(canonicalState) });
  const project = () =>
    projectNormalizedTimelineEntries({
      owner,
      structure: owner.readStructure(),
      entries: selectNormalizedConversationTurnEntries({
        owner,
        structure: owner.readStructure()!,
        conversation: null,
      }),
    });
  return { owner, state: canonicalState, project };
}
