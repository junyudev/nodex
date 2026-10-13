import { enablePatches, produce, produceWithPatches, type Draft } from "immer";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalHydratedConversationState,
  hydrateCodexCanonicalTurns,
  type CodexCanonicalConversationState,
} from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import {
  loadCanonicalHistoryBoundaryPage,
  replaceCanonicalHistoryDraft,
  type CanonicalHistoryClient,
} from "../../../../shared/codex-conversation-state/codex-canonical-history-loader";
import { insertCanonicalHistorySearchDraft } from "../../../../shared/codex-conversation-state/codex-canonical-history-search";
import {
  projectCodexTranscript,
  projectCodexTranscriptUpdate,
} from "../../../../shared/codex-transcript-projection";
import { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { projectNormalizedTimelineEntries } from "./normalized-timeline-entries";

enablePatches();
const key = { hostId: "local", threadId: "ordinary-history" };
const context = {
  hostId: "local",
  model: "model",
  reasoningEffort: null,
  cwd: "/workspace",
  approvalPolicy: "on-request" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: ["/workspace"],
};

function nativeTurn(index: number) {
  return {
    id: String(index),
    rootTurnId: null,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: index,
    completedAt: index + 1,
    durationMs: 1000,
    items: [
      {
        type: "userMessage",
        id: `user-${index}`,
        clientId: `client-${index}`,
        content: [{ type: "text", text: `History target ${index}`, text_elements: [] }],
      },
      {
        type: "agentMessage",
        id: `assistant-${index}`,
        text:
          `Answer ${index}.\n\n` + "Resident paragraph with actual Markdown layout.\n\n".repeat(4),
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    ],
  } satisfies Turn;
}
const nativeRange = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => nativeTurn(first + index));

/** Real canonical replacement/search insertion and normalized receipts, without a native process. */
export function ordinarySparseHistoryFixture() {
  const initial = createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: key.threadId,
      historyMode: "paginated",
      turns: nativeRange(90, 94),
    },
    context,
  );
  let state = produce(initial, (draft) => {
    draft.paginatedHistory = { turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    replaceCanonicalHistoryDraft(draft, initial.turns, false, {
      source: "ordinary",
      cursor: "before:90",
      oldestLoadedTurnId: "90",
    });
    insertCanonicalHistorySearchDraft(draft, () => "window", {
      turns: hydrateCodexCanonicalTurns(key.threadId, nativeRange(36, 44), context),
      olderCursor: "before:36",
      newerCursor: "after:44",
    });
  });
  const owner = new CodexTranscriptReadOwner(key);
  const release = owner.subscribeStructure(() => {});
  owner.applyEvent({ type: "reset", value: projectCodexTranscript(state) });
  const update = (recipe: (draft: Draft<CodexCanonicalConversationState>) => void) => {
    const previous = state;
    const [next, patches] = produceWithPatches(state, recipe);
    state = next;
    const event = projectCodexTranscriptUpdate(key, previous, state, { patches });
    if (event) owner.applyEvent(event);
  };
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: CanonicalHistoryClient = {
    hostId: key.hostId,
    supportsPaginatedHistory: () => true,
    getConversation: () => state,
    sendRequest: async (method, params) => {
      calls.push({ method, params });
      const cursor =
        typeof params.cursor === "string" ? /^(before|after):(\d+)$/.exec(params.cursor) : null;
      if (method === "thread/turns/list" && !cursor) throw new Error("Unexpected boundary cursor");
      const turnId = "turnId" in params && typeof params.turnId === "string" ? params.turnId : "0";
      const items = nativeTurn(Number(turnId)).items;
      const ordered = params.sortDirection === "asc" ? items : items.slice().reverse();
      const anchor = Number(cursor?.[2] ?? 0);
      const older = cursor?.[1] === "before";
      const first = older ? Math.max(1, anchor - 5) : anchor + 1;
      const last = older ? anchor - 1 : Math.min(94, anchor + 5);
      const turns = nativeRange(first, last);
      const nextCursor = older
        ? first === 1
          ? null
          : `before:${first}`
        : last === 94
          ? null
          : `after:${last}`;
      const responses: Pick<
        ClientRequestResponsesByMethod,
        "thread/turns/list" | "thread/items/list"
      > = {
        "thread/items/list": {
          data: ordered.map((item) => ({
            turnId,
            item,
            startedAtMs: Number(turnId) * 1000,
            completedAtMs: (Number(turnId) + 1) * 1000,
          })),
          nextCursor: null,
          backwardsCursor: null,
        },
        "thread/turns/list": {
          data: (older ? turns.reverse() : turns).map((turn) => ({
            ...turn,
            items: [],
            itemsView: "notLoaded" as const,
          })),
          nextCursor,
          backwardsCursor: `before:${first}`,
        },
      };
      return responses[method] as ClientRequestResponsesByMethod[typeof method];
    },
    updateConversation: (_id, recipe) => update(recipe),
    broadcastSnapshot: () => {},
    mapTurns: (_id, turns, pagination) =>
      hydrateCodexCanonicalTurns(key.threadId, turns, {
        ...context,
        turnItemsPaginationById: pagination,
      }),
  };
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
  return {
    owner,
    project,
    update,
    calls,
    read: () => state,
    loadBoundary: (boundary: Parameters<typeof loadCanonicalHistoryBoundaryPage>[2]) =>
      loadCanonicalHistoryBoundaryPage(client, key.threadId, boundary),
    dispose: release,
  };
}
