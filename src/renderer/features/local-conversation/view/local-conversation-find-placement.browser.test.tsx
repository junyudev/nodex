import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { castDraft, enablePatches, produceWithPatches, type Draft } from "immer";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
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
            itemId: query === disclosureTerm ? "history-answer-5" : "history-user-5",
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
const disclosureTerm = "A hidden disclosure target";
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
function hydrateHistory(turns: Turn[]): CodexCanonicalConversationState {
  return createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: key.threadId,
      historyMode: "paginated",
      turns,
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
}
const actions: ThreadStageActions = {
  onCollaborationModeChange: () => {},
  onModelChange: () => {},
  onReasoningEffortChange: () => {},
  onPermissionModeChange: () => {},
  onQueueingEnabledChange: () => {},
  onSendPrompt: async () => {},
  onSendCapturedFollowUp: async () => {},
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
function FindControls({ query = term }: { readonly query?: string }) {
  const find = useContentSearch();
  return (
    <>
      <button
        onClick={() => {
          find.requestOpen({ preferredDomain: "conversation" });
          find.setQuery(query);
        }}
      >
        Find history five
      </button>
      <output aria-label="Find result">{find.resultLabel}</output>
    </>
  );
}

describe("actual transcript Find placement", () => {
  test("opens the same collapsed directive through actual transcript Find before marking and centering", async () => {
    const turn = history(5);
    const answer = turn.items.find((item) => item.type === "agentMessage")!;
    if (answer.type !== "agentMessage") throw new Error("Missing authored answer");
    answer.text = [
      ':::github-details{summary="More" open="false"}',
      "Hidden introduction.\n\n".repeat(14),
      disclosureTerm,
      "\n\nHidden ending.\n\n".repeat(14),
      ":::",
    ].join("\n");
    const state = hydrateHistory([turn]);
    const owner = new CodexTranscriptReadOwner(key);
    const release = owner.subscribeStructure(() => {});
    owner.applyEvent({ type: "reset", value: projectCodexTranscript(state) });
    function CloseFind() {
      const find = useContentSearch();
      return <button onClick={find.close}>Close Find</button>;
    }
    const view = render(
      <LocalConversationTestQueryProvider>
        <NodexTooltipProvider>
          <ContentSearchProvider>
            <FindControls query={disclosureTerm} />
            <CloseFind />
            <CodexTranscriptReadOwnerContext.Provider value={owner}>
              <EnsureLocalConversationThreadScrollController>
                <div style={{ width: 900, height: 500 }}>
                  <LocalConversationThreadScrollLayout footer={<div style={{ height: 100 }} />}>
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
                        turnCount: 1,
                        isThreadRunning: false,
                        activeTurnId: null,
                        latestTurnId: turn.id,
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
                      initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
                      onRestoreSnapshotChange={() => {}}
                    />
                  </LocalConversationThreadScrollLayout>
                </div>
              </EnsureLocalConversationThreadScrollController>
            </CodexTranscriptReadOwnerContext.Provider>
          </ContentSearchProvider>
        </NodexTooltipProvider>
      </LocalConversationTestQueryProvider>,
    );
    try {
      const summary = await view.findByText("More", { selector: "summary" });
      const details = summary.closest("details")!;
      expect(details.open).toBe(false);
      const unit = details.closest("[data-content-search-unit-key]");
      await act(async () => {
        summary.click();
        await Promise.resolve();
      });
      await waitFor(() => expect(details.open).toBe(true));
      await act(async () => {
        summary.click();
        await Promise.resolve();
      });
      await waitFor(() => expect(details.open).toBe(false));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Find history five" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByLabelText("Find result").textContent).toBe("1 / 1 results"),
      );
      await waitFor(() => expect(details.open).toBe(true));
      await waitFor(() => {
        const mark = details.querySelector<HTMLElement>("mark.codex-thread-find-active");
        expect(mark?.textContent).toBe(disclosureTerm);
        const viewport = view.container.querySelector<HTMLElement>(
          "[data-local-conversation-thread-body=true]",
        )!;
        const bounds = mark!.getBoundingClientRect();
        const clip = viewport.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(clip.top);
        expect(bounds.bottom).toBeLessThanOrEqual(clip.bottom);
      });
      expect(summary.closest("details")).toBe(details);
      expect(details.closest("[data-content-search-unit-key]")).toBe(unit);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Close Find" }));
        await Promise.resolve();
      });
      await waitFor(() => expect(details.querySelector("mark")).toBeNull());
      expect(details.open).toBe(true);
    } finally {
      view.unmount();
      release();
    }
  });
  test.for([
    {
      name: "centers an already mounted native history match after streaming completion and user wheel",
      latePage: false,
      nearTarget: false,
      alreadyCentered: false,
    },
    {
      name: "keeps native smooth Find centered when a newer history page arrives during the scroll",
      latePage: true,
      nearTarget: false,
      alreadyCentered: false,
    },
    {
      name: "centers a match just below the viewport when a newer history page arrives during native smooth Find",
      latePage: true,
      nearTarget: true,
      alreadyCentered: false,
    },
    {
      name: "finishes native Find for an already centered match without waiting for scrollend",
      latePage: false,
      nearTarget: false,
      alreadyCentered: true,
    },
  ])("$name", async ({ latePage, nearTarget, alreadyCentered }, context) => {
    let state = hydrateHistory(
      Array.from({ length: 10 }, (_, index) =>
        index === 9
          ? { ...history(index + 1), status: "inProgress", completedAt: null }
          : history(index + 1),
      ),
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
        renderedWindow: { anchorKey: targetEntry.turnKey, count: latePage ? 10 : 6 },
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
          turnCount: state.turns.length,
          isThreadRunning: running,
          activeTurnId: running ? "history-turn-0010" : null,
          latestTurnId: state.turns.at(-1)?.turnId ?? null,
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
    let scrollEndCount = 0;
    const recordScrollEnd = () => {
      scrollEndCount++;
    };
    let pageTimer: ReturnType<typeof setTimeout> | null = null;
    let acceptPage: () => void = () => {};
    let rejectPage: (error: unknown) => void = () => {};
    const pageDelivery = new Promise<void>((resolve, reject) => {
      acceptPage = resolve;
      rejectPage = reject;
    });
    const latePageEvidence: Array<{
      phase: string;
      atMs: number;
      height: number;
      top: number;
      mode: string;
      targetTop?: number;
      markTop?: number;
    }> = [];
    const scrollWrites: Array<{
      atMs: number;
      top: number;
      behavior: string | undefined;
      targetTop?: number;
      markTop?: number;
    }> = [];
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
      if (alreadyCentered) {
        await act(async () => {
          view.getByText(term, { exact: true }).scrollIntoView({
            behavior: "instant",
            block: "center",
            inline: "nearest",
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        // The later inline mark uses the text glyph box, not its surrounding block's line box.
        await act(async () => {
          const range = document.createRange();
          range.selectNodeContents(view.getByText(term, { exact: true }));
          const text = range.getBoundingClientRect();
          const clip = viewport.getBoundingClientRect();
          const style = getComputedStyle(viewport);
          const center =
            (clip.top +
              (parseFloat(style.scrollPaddingTop) || 0) +
              clip.bottom -
              (parseFloat(style.scrollPaddingBottom) || 0)) /
            2;
          viewport.scrollTo({
            behavior: "instant",
            top: viewport.scrollTop + (text.top + text.bottom) / 2 - center,
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
      }
      if (nearTarget) {
        // The first physical move admits rows whose actual heights replace estimates.
        for (let attempt = 0; attempt < 2; attempt++) {
          await act(async () => {
            const target = view.getByText(term, { exact: true });
            const desiredTop = viewport.getBoundingClientRect().bottom + 26;
            const nextScrollTop =
              viewport.scrollTop + target.getBoundingClientRect().top - desiredTop;
            fireEvent.wheel(viewport, { deltaY: nextScrollTop - viewport.scrollTop });
            viewport.scrollTop = nextScrollTop;
            fireEvent.scroll(viewport);
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          });
        }
        const targetTop = view.getByText(term, { exact: true }).getBoundingClientRect().top;
        expect(targetTop - viewport.getBoundingClientRect().bottom).toBeGreaterThan(20);
        expect(targetTop - viewport.getBoundingClientRect().bottom).toBeLessThan(32);
      }
      const initialFindScrollTop = viewport.scrollTop;
      if (alreadyCentered) viewport.addEventListener("scrollend", recordScrollEnd);
      const originalScroll = HTMLElement.prototype.scrollIntoView;
      const originalScrollTo = viewport.scrollTo;
      vi.spyOn(viewport, "scrollTo").mockImplementation((...args: unknown[]) => {
        const request = args[0];
        const options = typeof request === "object" && request !== null ? request : null;
        scrollWrites.push({
          atMs: performance.now(),
          top:
            options && "top" in options && typeof options.top === "number"
              ? options.top
              : typeof request === "number"
                ? request
                : viewport.scrollTop,
          behavior:
            options && "behavior" in options && typeof options.behavior === "string"
              ? options.behavior
              : undefined,
          targetTop: view.queryByText(term, { exact: true })?.getBoundingClientRect().top,
          markTop: view.container
            .querySelector("mark.codex-thread-find-active")
            ?.getBoundingClientRect().top,
        });
        Reflect.apply(originalScrollTo, viewport, args);
      });
      const nativeScroll = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(function (this: HTMLElement, options) {
          scrollCalls++;
          modes.push(readController().getScrollMode());
          originalScroll.call(this, options);
          if (latePage && pageTimer === null) {
            latePageEvidence.push({
              phase: "native-smooth-started",
              atMs: performance.now(),
              height: viewport.scrollHeight,
              top: viewport.scrollTop,
              mode: readController().getScrollMode(),
              targetTop: view.queryByText(term, { exact: true })?.getBoundingClientRect().top,
              markTop: view.container
                .querySelector("mark.codex-thread-find-active")
                ?.getBoundingClientRect().top,
            });
            pageTimer = setTimeout(() => {
              try {
                latePageEvidence.push({
                  phase: "before-newer-page",
                  atMs: performance.now(),
                  height: viewport.scrollHeight,
                  top: viewport.scrollTop,
                  mode: readController().getScrollMode(),
                  targetTop: view.queryByText(term, { exact: true })?.getBoundingClientRect().top,
                  markTop: view.container
                    .querySelector("mark.codex-thread-find-active")
                    ?.getBoundingClientRect().top,
                });
                const newer = history(11);
                const answer = newer.items.find((item) => item.type === "agentMessage");
                if (answer?.type === "agentMessage") answer.text = answer.text.repeat(6);
                const admitted = hydrateHistory([newer]).turns;
                flushSync(() => {
                  update((draft) => {
                    draft.turns.push(...castDraft(admitted));
                  });
                  view.rerender(rows(false));
                });
                acceptPage();
              } catch (error) {
                rejectPage(error);
              }
            }, 75);
          }
        });
      const targetRow = view.getByText(term, { exact: true }).closest("[data-turn-key]");
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Find history five" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByLabelText("Find result").textContent).toBe("1 / 1 results"),
      );
      await waitFor(() => expect(scrollCalls).toBeGreaterThan(0), { interval: 1 });
      await act(async () => {
        if (latePage) await pageDelivery;
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      });
      if (latePage) {
        await act(async () => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        latePageEvidence.push({
          phase: "newer-page-measured",
          atMs: performance.now(),
          height: viewport.scrollHeight,
          top: viewport.scrollTop,
          mode: readController().getScrollMode(),
        });
        expect(owner.readStructure()!.turns).toHaveLength(11);
        expect(latePageEvidence.at(-1)!.height).toBeGreaterThan(latePageEvidence[0]!.height);
        expect(latePageEvidence[1]!.atMs).toBeGreaterThan(latePageEvidence[0]!.atMs);
      }
      await waitFor(
        () => {
          const mark = view.container.querySelector<HTMLElement>("mark.codex-thread-find-active");
          expect(mark?.textContent).toBe(term);
          const rect = mark!.getBoundingClientRect();
          const clip = viewport.getBoundingClientRect();
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.bottom).toBeGreaterThan(clip.top);
          expect(rect.top).toBeLessThan(clip.bottom);
          if (latePage || alreadyCentered) {
            const style = getComputedStyle(viewport);
            const visibleTop = clip.top + (parseFloat(style.scrollPaddingTop) || 0);
            const visibleBottom = clip.bottom - (parseFloat(style.scrollPaddingBottom) || 0);
            expect(
              Math.abs((rect.top + rect.bottom) / 2 - (visibleTop + visibleBottom) / 2),
            ).toBeLessThanOrEqual(2);
          }
        },
        { timeout: 3_000 },
      );
      if (alreadyCentered) {
        expect(readController().nativeFindTurnKey).toBeNull();
        expect(readController().getScrollMode()).not.toBe("programmaticFind");
        expect(scrollEndCount).toBe(0);
        expect(Math.abs(viewport.scrollTop - initialFindScrollTop)).toBeLessThanOrEqual(1);
      }
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
      if (pageTimer !== null) clearTimeout(pageTimer);
      const active = view.container.querySelector<HTMLElement>("mark.codex-thread-find-active");
      const viewport = scrollState.current?.getScrollElement();
      const evidence = {
        modes,
        scrollCalls,
        scrollEndCount,
        mode: scrollState.current?.getScrollMode(),
        top: viewport?.scrollTop,
        markTop: active?.getBoundingClientRect().top,
        markBottom: active?.getBoundingClientRect().bottom,
        markHeight: active?.getBoundingClientRect().height,
        clip: viewport?.getBoundingClientRect().toJSON(),
        latePageEvidence,
        scrollWrites,
        targetPresent: view.queryByText(term, { exact: true }) !== null,
      };
      viewport?.removeEventListener("scrollend", recordScrollEnd);
      if (latePage || alreadyCentered)
        console.info("native Find geometry", JSON.stringify(evidence));
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
