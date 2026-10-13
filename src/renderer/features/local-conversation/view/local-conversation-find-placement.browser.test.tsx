import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { enablePatches, produceWithPatches, type Draft } from "immer";
import { useLayoutEffect } from "react";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import {
  projectCodexTranscript,
  projectCodexTranscriptUpdate,
} from "../../../../shared/codex-transcript-projection";
import { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import {
  ContentSearchProvider,
  useContentSearch,
} from "../../content-search/content-search-context";
import { LocalConversationThreadBodyOwner } from "./local-conversation-thread-body-owner";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import { EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT } from "./local-conversation-thread-view-state";
import type { ThreadStageActions } from "../thread-stage-types";
import "../../../globals.css";

const persistedSearchCalls = vi.hoisted(() => vi.fn());

vi.mock("../local-conversation-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-conversation-store")>()),
  searchLocalPersistedHistory: async (threadId: string, query: string) => {
    persistedSearchCalls(threadId, query);
    return {
      status: "completed",
      page: {
        threadId,
        hostId: "local",
        hostGeneration: 1,
        topologyGeneration: 1,
        query,
        occurrences: [
          {
            turnId: "history-turn-0005",
            itemId: "history-user-5",
            turnCursor: "history-turn-0005",
            snippet: query,
            snippetMatchRange: { start: 0, end: query.length },
          },
        ],
        capped: false,
      },
    };
  },
}));

const originalApi = window.api;
beforeEach(() => {
  persistedSearchCalls.mockClear();
  window.api = {
    on: () => () => {},
    invoke: async (channel) =>
      channel === "persisted-atom:sync-request"
        ? { revision: 0, values: {} }
        : channel === "codex:app-server:request"
          ? { type: "result", result: { data: [], nextCursor: null } }
          : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
  vi.restoreAllMocks();
});
enablePatches();
const key = { hostId: "local", threadId: "find-placement" };
const term = "Synthetic history 0005";
function history(index: number): Turn {
  return {
    id: `history-turn-${String(index).padStart(4, "0")}`,
    rootTurnId: null,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: index,
    completedAt: index + 1,
    durationMs: 1_000,
    items: [
      {
        type: "userMessage",
        id: `history-user-${index}`,
        clientId: null,
        content: [
          {
            type: "text",
            text: `Synthetic history ${String(index).padStart(4, "0")}`,
            text_elements: [],
          },
        ],
      },
      {
        type: "agentMessage",
        id: `history-answer-${index}`,
        text:
          `Synthetic answer ${index}. ` +
          "The reproducible transcript contains plain text for bounded history measurement. ".repeat(
            8,
          ),
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    ],
  };
}
const actions: ThreadStageActions = {
  onCollaborationModeChange: () => {},
  onModelChange: () => {},
  onReasoningEffortChange: () => {},
  onPermissionModeChange: () => {},
  onQueueingEnabledChange: () => {},
  onSendPrompt: async () => {},
  onSteerPrompt: async () => {},
  onInterruptTurn: async () => {},
  onRespondApproval: async () => {},
  onRespondUserInput: async () => {},
  onRespondMcpElicitation: async () => {},
  onResolvePlanImplementationRequest: async () => {},
  onEnqueueQueuedFollowUp: async () => {},
  onRemoveQueuedFollowUp: async () => {},
  onReorderQueuedFollowUps: async () => {},
  onSendQueuedFollowUpNow: async () => {},
  onEditQueuedFollowUp: async () => {},
  onEditLastUserTurn: async () => {},
  onForkFromTurn: async () => {},
  onUnarchiveThread: async () => {},
  onOpenTurnDiffReview: () => {},
  onConsumeComposerIntent: () => {},
  onOpenThread: () => {},
  onCleanBackgroundTerminals: async () => {},
};
function FindControls() {
  const find = useContentSearch();
  return (
    <>
      <button
        onClick={() => {
          find.requestOpen({ preferredDomain: "conversation" });
          find.setQuery(term);
        }}
      >
        Find history five
      </button>
      <output aria-label="Find result">{find.resultLabel}</output>
    </>
  );
}

describe("actual transcript Find placement", () => {
  test("centers an already mounted native history match after streaming completion and user wheel", async (context) => {
    let state = createCodexCanonicalHydratedConversationState(
      {
        ...buildAgentActivityV2CorpusThread([]),
        id: key.threadId,
        historyMode: "paginated",
        turns: Array.from({ length: 10 }, (_, index) =>
          index === 9
            ? { ...history(index + 1), status: "inProgress", completedAt: null }
            : history(index + 1),
        ),
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
    const scrollState: { current: LocalConversationThreadScrollControllerValue | null } = {
      current: null,
    };
    const readController = () => {
      if (!scrollState.current) throw new Error("Missing scroll owner");
      return scrollState.current;
    };
    function ObserveScroll() {
      const scroll = useLocalConversationThreadScrollController();
      useLayoutEffect(() => {
        scrollState.current = scroll;
      });
      return null;
    }
    const owner = new CodexTranscriptReadOwner(key);
    const retain = owner.subscribeStructure(() => {});
    owner.applyEvent({ type: "reset", value: projectCodexTranscript(state) });
    const update = (recipe: (draft: Draft<CodexCanonicalConversationState>) => void) => {
      const previous = state;
      const [next, patches] = produceWithPatches(state, recipe);
      state = next;
      const event = projectCodexTranscriptUpdate(key, previous, state, { patches });
      if (event) owner.applyEvent(event);
    };
    const structure = owner.readStructure()!;
    const targetEntry = selectNormalizedConversationTurnEntries({
      owner,
      structure,
      conversation: null,
    }).find((entry) => entry.turnId === "history-turn-0005")!;
    const restore = {
      ...EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
      virtualizedTurnList: {
        renderedWindow: { anchorKey: targetEntry.turnKey, count: 6 },
        turnHeightsByKey: {},
      },
    };
    const body = (running: boolean) => (
      <LocalConversationThreadBodyOwner
        projectId={null}
        hostId="local"
        threadId={key.threadId}
        isSideChat={false}
        cwd="/workspace"
        turns={[]}
        requests={[]}
        canonicalRequests={[]}
        resumeState="resumed"
        turnPagination={null}
        capabilityFlags={{
          canEditLastUserTurn: false,
          canForkFromTurn: false,
          canSearch: true,
          canCollapseTurns: true,
        }}
        body={{
          threadId: key.threadId,
          turnCount: 10,
          isThreadRunning: running,
          activeTurnId: running ? "history-turn-0010" : null,
          latestTurnId: "history-turn-0010",
          emptyState: { type: "none" },
          showThreadStartProgressPanel: false,
        }}
        parentTurns={[]}
        childMemberships={[]}
        backgroundAgentRows={[]}
        searchOpenTick={0}
        threadStartProgress={null}
        actions={actions}
        onErrorMessage={() => {}}
        initialRestoreSnapshot={restore}
        onRestoreSnapshotChange={() => {}}
      />
    );
    const rows = (running: boolean) => (
      <LocalConversationTestQueryProvider>
        <NodexTooltipProvider>
          <ContentSearchProvider>
            <FindControls />
            <CodexTranscriptReadOwnerContext.Provider value={owner}>
              <EnsureLocalConversationThreadScrollController>
                <ObserveScroll />
                <div style={{ width: 900, height: 700 }}>
                  <LocalConversationThreadScrollLayout footer={<div style={{ height: 100 }} />}>
                    {body(running)}
                  </LocalConversationThreadScrollLayout>
                </div>
              </EnsureLocalConversationThreadScrollController>
            </CodexTranscriptReadOwnerContext.Provider>
          </ContentSearchProvider>
        </NodexTooltipProvider>
      </LocalConversationTestQueryProvider>
    );
    const view = render(rows(true));
    const modes: string[] = [];
    let scrollCalls = 0;
    try {
      const viewport = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          "[data-local-conversation-thread-body=true]",
        );
        expect(element?.clientHeight).toBe(700);
        return element!;
      });
      await waitFor(() => expect(view.getByText(term, { exact: true })).toBeTruthy());
      await act(async () => {
        for (let index = 0; index < 30; index++)
          update((draft) => {
            const item = draft.turns.at(-1)?.items.find((item) => item.type === "agentMessage");
            if (item?.type === "agentMessage") item.text += ` sample-${index}`;
          });
        update((draft) => {
          const last = draft.turns.at(-1);
          if (last) last.status = "completed";
        });
        view.rerender(rows(false));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await act(async () => {
        fireEvent.wheel(viewport, { deltaY: -220 });
        viewport.scrollTop = -220;
        fireEvent.scroll(viewport);
        await Promise.resolve();
        fireEvent.wheel(viewport, { deltaY: 220 });
        viewport.scrollTop = 0;
        fireEvent.scroll(viewport);
        await Promise.resolve();
      });
      expect(readController().getScrollMode()).toBe("stickToBottom");
      const originalScroll = HTMLElement.prototype.scrollIntoView;
      const nativeScroll = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(function (this: HTMLElement, options) {
          scrollCalls++;
          modes.push(readController().getScrollMode());
          originalScroll.call(this, options);
        });
      const targetRow = view.getByText(term, { exact: true }).closest("[data-turn-key]");
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Find history five" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByLabelText("Find result").textContent).toBe("1 / 1 results"),
      );
      await waitFor(
        () => {
          const mark = view.container.querySelector<HTMLElement>("mark.codex-thread-find-active");
          expect(mark?.textContent).toBe(term);
          const rect = mark!.getBoundingClientRect();
          const clip = viewport.getBoundingClientRect();
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.bottom).toBeGreaterThan(clip.top);
          expect(rect.top).toBeLessThan(clip.bottom);
        },
        { timeout: 3_000 },
      );
      expect(modes).toEqual(["programmaticFind"]);
      expect(
        view.container.querySelector("mark.codex-thread-find-active")?.closest("[data-turn-key]"),
      ).toBe(targetRow);
      expect(persistedSearchCalls).toHaveBeenCalledExactlyOnceWith(key.threadId, term);
      expect(nativeScroll).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    } finally {
      const active = view.container.querySelector<HTMLElement>("mark.codex-thread-find-active");
      const viewport = scrollState.current?.getScrollElement();
      const evidence = {
        modes,
        scrollCalls,
        mode: scrollState.current?.getScrollMode(),
        top: viewport?.scrollTop,
        markTop: active?.getBoundingClientRect().top,
        markBottom: active?.getBoundingClientRect().bottom,
        markHeight: active?.getBoundingClientRect().height,
        clip: viewport?.getBoundingClientRect().toJSON(),
      };
      view.unmount();
      retain();
      await context.annotate("resident native Find placement", "viewport geometry", {
        body: JSON.stringify(evidence),
        bodyEncoding: "utf-8",
        contentType: "application/json",
      });
    }
  });
});
