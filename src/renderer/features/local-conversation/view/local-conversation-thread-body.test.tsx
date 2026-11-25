import { toast } from "@/components/ui/toast";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import {
  appScope,
  createMaitaiStore,
  MaitaiProvider,
  useScopeHandle,
  type ScopeHandle,
} from "../../../lib/maitai";
import {
  WorkbenchSessionScopePath,
  type ThreadScopeDescriptor,
} from "../../../lib/workbench-ui-scopes";
import {
  installAsyncRequestAnimationFrame,
  installMeasuredResizeObserver,
} from "../../../test/browser-globals";
import { render, settleAsyncRender } from "../../../test/dom";
import type {
  CodexCanonicalServerRequest,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexConversationTurn,
} from "../../../lib/types";
import type { ThreadBodySurfaceModel, ThreadStageActions } from "../thread-stage-types";
import { buildThreadBodyModel } from "../projection/build-thread-body-model";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { createCodexCanonicalHydratedConversationState } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import * as localConversationStore from "../local-conversation-store";
import * as conversationSearchSource from "./local-conversation-search-source";
import {
  ContentSearchProvider,
  useContentSearch,
} from "../../content-search/content-search-context";
import {
  EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
  localConversationThreadRestoreSnapshotFamily,
} from "./local-conversation-thread-view-state";
import { LocalConversationThreadBodyOwner } from "./local-conversation-thread-body-owner";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import * as threadViewState from "./local-conversation-thread-view-state";

let idleCallbacks: IdleRequestCallback[] = [];
const originalOffsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalRangeGetClientRects = Range.prototype.getClientRects;
const originalRangeGetBoundingClientRect = Range.prototype.getBoundingClientRect;

const TEST_THREAD_SCOPE: ThreadScopeDescriptor = {
  stableKey: "session:local-conversation-thread-body-test",
  phase: "attached",
  projectSessionId: "local-conversation-thread-body-test",
  clientThreadId: null,
  threadId: "thread_1",
};

function TooltipProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => createMaitaiStore());
  return (
    <MaitaiProvider store={store}>
      <WorkbenchSessionScopePath
        thread={TEST_THREAD_SCOPE}
        route={{ routeKey: "/thread-body", kind: "thread" }}
        selected={false}
      >
        <LocalConversationTestQueryProvider>
          <NodexTooltipProvider>{children}</NodexTooltipProvider>
        </LocalConversationTestQueryProvider>
      </WorkbenchSessionScopePath>
    </MaitaiProvider>
  );
}

function makeRect(input: Partial<DOMRectReadOnly>): DOMRect {
  const left = input.left ?? 0;
  const top = input.top ?? 0;
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  const rect = {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
  return rect as DOMRect;
}

function installThreadRailWideLayoutGeometry() {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches("[data-local-conversation-thread-body='true']")) return 1000;
      return originalOffsetWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.matches("[data-local-conversation-thread-body='true']")) {
        return makeRect({ left: 0, width: 1000, height: 700 });
      }
      if (this.matches("[data-mcp-app-portal-target='true']")) {
        return makeRect({ left: 80, width: 768, height: 2000 });
      }
      return originalGetBoundingClientRect.call(this);
    },
  });
}

function restoreThreadRailLayoutGeometry() {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: originalGetBoundingClientRect,
  });
  if (originalOffsetWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidthDescriptor);
  } else {
    Reflect.deleteProperty(
      HTMLElement.prototype as HTMLElement & { offsetWidth?: number },
      "offsetWidth",
    );
  }
}

function restoreSelectedTextRangeGeometry() {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value: originalRangeGetClientRects,
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: originalRangeGetBoundingClientRect,
  });
}

function buildAssistantEntry(overrides?: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "assistant_1",
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    markdownText: "Assistant message",
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function buildUserEntry(overrides?: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "user_1",
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: "run `bun test`",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildTurn(overrides?: Partial<CodexConversationTurn>): CodexConversationTurn {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "completed",
    itemIds: ["user_1", "assistant_1"],
    items: [buildUserEntry(), buildAssistantEntry()],
    ...overrides,
  };
}

function buildIndexedTurn(index: number): CodexConversationTurn {
  const turnId = `turn_${index}`;
  const userId = `user_${index}`;
  const assistantId = `assistant_${index}`;
  return buildTurn({
    turnId,
    itemIds: [userId, assistantId],
    items: [
      buildUserEntry({
        turnId,
        itemId: userId,
        entryId: userId,
        markdownText: `Message ${index}`,
      }),
      buildAssistantEntry({
        turnId,
        itemId: assistantId,
        entryId: assistantId,
        markdownText: `Answer ${index}`,
      }),
    ],
  });
}

function buildConversation(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return {
    threadId: "thread_1",
    projectId: "project_1",
    source: overrides?.source ?? null,
    threadName: "Thread",
    threadPreview: "Preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-03-21T00:00:00.000Z",
    resumeState: "resumed",
    turns: [buildTurn()],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
  };
}

function buildModel(overrides?: {
  conversation?: CodexConversationSnapshot | null;
  body?: ThreadBodySurfaceModel["body"];
  searchOpenTick?: number;
  projectWorkspacePath?: string | null;
  threadStartProgress?: ThreadBodySurfaceModel["threadStartProgress"];
}): ThreadBodySurfaceModel {
  const conversation = overrides?.conversation ?? buildConversation();
  const body =
    overrides?.body ??
    buildThreadBodyModel({
      activeThreadId: conversation?.threadId ?? null,
      conversation,
      activeThreadArchived: conversation?.archived ?? false,
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      threadStartProgress: overrides?.threadStartProgress ?? null,
    });

  return {
    projectId: conversation?.projectId ?? "project_1",
    hostId: "local",
    threadId: conversation?.threadId ?? null,
    isSideChat: false,
    cwd: conversation?.cwd ?? null,
    turns: conversation?.turns ?? [],
    requests: conversation?.requests ?? [],
    canonicalRequests: conversation?.canonicalRequests ?? [],
    resumeState: conversation?.resumeState ?? null,
    statusType: conversation?.statusType ?? null,
    capabilityFlags: conversation?.capabilityFlags ?? {
      canEditUserTurns: false,
      canForkFromTurn: false,
      canSearch: false,
      canCollapseTurns: false,
    },
    body,
    parentTurns: [],
    childMemberships: [],
    projectWorkspacePath: overrides?.projectWorkspacePath ?? "/tmp/project",
    searchOpenTick: overrides?.searchOpenTick ?? 0,
    threadStartProgress: overrides?.threadStartProgress ?? null,
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},

    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onSendCapturedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onOpenThread: () => {},
    onStopBackgroundTerminals: async () => {},
    ...overrides,
  };
}

function FindControls({ query = "needle" }: { query?: string } = {}) {
  const controller = useContentSearch();
  return (
    <>
      <button
        onClick={() => {
          controller.requestOpen({ preferredDomain: "conversation" });
          controller.setQuery(query);
        }}
      >
        Find thread text
      </button>
      <button onClick={controller.goNext}>Next match</button>
      <output aria-label="Find result">{controller.resultLabel}</output>
    </>
  );
}

describe("LocalConversationThreadBody", () => {
  test.each(
    (["ordinary", "inlineMarkdown", "voiceAssistant"] as const).flatMap((family) => [
      {
        family,
        name: "literal markup",
        literal: true,
        occurrences: 1,
        content: 'before <kbd>needle</kbd> after\n\n::unknown{file="raw &amp; declaration"}',
      },
      {
        family,
        name: "adjacent phrasing",
        literal: false,
        occurrences: 2,
        content: "**nee**dle\n\n[nee](https://example.com)dle",
      },
    ]),
  )(
    "finds displayed $name in the actual $family assistant unit",
    async ({ family, content, occurrences, literal }) => {
      const item = {
        type: "agentMessage",
        moderation: null,
        id: "answer",
        text: family === "inlineMarkdown" ? `::codex-realtime-inline{}\n${content}` : content,
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      } as const;
      const { owner, state } = timelineOwnerFixture(
        {
          data:
            family === "ordinary"
              ? []
              : [
                  {
                    type: "realtime",
                    position: 1,
                    item:
                      family === "inlineMarkdown"
                        ? {
                            type: "bemItemPromoted",
                            id: "promotion",
                            realtimeSessionId: "session",
                            turnId: "one",
                            itemId: "answer",
                            presentation: { type: "inlineMarkdown" },
                          }
                        : {
                            type: "transcriptSegment",
                            id: "voice",
                            realtimeSessionId: "session",
                            role: "assistant",
                            text: content,
                          },
                  },
                ],
          nextCursor: null,
          activeRealtimeSessionAtPageStart: null,
        },
        family === "voiceAssistant" ? [] : [item],
      );
      const retain = owner.subscribeStructure(() => {});
      const search = vi
        .spyOn(localConversationStore, "searchLocalPersistedHistory")
        .mockResolvedValue({
          status: "completed",
          page: {
            threadId: "thread",
            hostId: "local",
            hostGeneration: 1,
            topologyGeneration: 1,
            query: "needle",
            occurrences: [],
            capped: false,
          },
        });
      const model = buildModel({
        conversation: buildConversation({ threadId: "thread", turns: [], canonicalState: state }),
      });
      const view = render(
        <TooltipProvider>
          <ContentSearchProvider>
            <FindControls query={family === "voiceAssistant" && !literal ? "nee" : "needle"} />
            <CodexTranscriptReadOwnerContext.Provider value={owner}>
              <EnsureLocalConversationThreadScrollController>
                <LocalConversationThreadScrollLayout>
                  <LocalConversationThreadBodyOwner
                    {...model}
                    turnPagination={null}
                    canonicalRequests={[]}
                    backgroundAgentRows={[]}
                    actions={buildActions()}
                    readRestoreSnapshot={() => EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
                    onRestoreSnapshotChange={() => {}}
                  />
                </LocalConversationThreadScrollLayout>
              </EnsureLocalConversationThreadScrollController>
            </CodexTranscriptReadOwnerContext.Provider>
          </ContentSearchProvider>
        </TooltipProvider>,
      );
      try {
        await settleAsyncRender();
        if (literal) {
          await view.findByText(
            (_, element) =>
              element?.tagName === "P" && element.textContent === "before <kbd>needle</kbd> after",
          );
          await view.findByText('::unknown{file="raw &amp; declaration"}');
        } else await view.findByRole("link", { name: "nee" });
        expect(view.container.querySelector("kbd")).toBeNull();
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: "Find thread text" }));
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(view.getByLabelText("Find result").textContent).toBe(`1 / ${occurrences} results`),
        );
        const active = await waitFor(() => {
          const mark = view.container.querySelector("mark.codex-thread-find-active");
          const fragments = view.container.querySelectorAll("mark.codex-thread-find-active");
          expect(Array.from(fragments, (fragment) => fragment.textContent).join("")).toBe(
            family === "voiceAssistant" && !literal ? "nee" : "needle",
          );
          return mark!;
        });
        const unit = active?.closest("[data-content-search-unit-key]");
        expect(unit).not.toBeNull();
        expect(unit?.querySelector("kbd")).toBeNull();
        expect(
          new Set(
            Array.from(unit!.querySelectorAll("mark"), (mark) =>
              mark.getAttribute("data-content-search-match-id"),
            ),
          ).size,
        ).toBe(occurrences);
        expect(view.container.querySelector("button mark")).toBeNull();
        if (family === "voiceAssistant")
          expect(unit?.getAttribute("data-native-realtime-item-id")).toBe("voice");
        else expect(owner.readItem("turn:one", "answer")?.type).toBe("agentMessage");
      } finally {
        view.unmount();
        retain();
        search.mockRestore();
      }
    },
  );
  test("finds and reveals a folded native voice tail when persisted search succeeds with an empty page", async () => {
    const originalCreateSource = conversationSearchSource.createLocalConversationSearchSource;
    const rowPlacements = vi.fn();
    const createSource = vi
      .spyOn(conversationSearchSource, "createLocalConversationSearchSource")
      .mockImplementation((input) =>
        originalCreateSource({
          ...input,
          scrollAdapter: {
            ...input.scrollAdapter,
            scrollToTurn: async (...args) => {
              rowPlacements(...args);
              await input.scrollAdapter.scrollToTurn(...args);
            },
          },
        }),
      );
    const overflow = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1_000);
    const { owner, state } = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "transcriptSegment",
            id: "voice",
            realtimeSessionId: "session",
            role: "assistant",
            text: "spoken needle and needle",
          },
        },
        {
          type: "realtime",
          position: 2,
          item: {
            type: "transcriptSegment",
            id: "user",
            realtimeSessionId: "session",
            role: "user",
            // Large Markdown budgets have dedicated coverage; Find needs only a folded tail.
            text: "User voice row\n".repeat(40) + "\n[needle](https://example.com/result)",
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const search = vi
      .spyOn(localConversationStore, "searchLocalPersistedHistory")
      .mockResolvedValue({
        status: "completed",
        page: {
          threadId: "thread",
          hostId: "local",
          hostGeneration: 1,
          topologyGeneration: 1,
          query: "needle",
          occurrences: [],
          capped: false,
        },
      });
    const hydrate = vi.spyOn(localConversationStore, "hydrateLocalPersistedHistoryOccurrence");
    const model = buildModel({
      conversation: buildConversation({ threadId: "thread", turns: [], canonicalState: state }),
    });
    const view = render(
      <TooltipProvider>
        <ContentSearchProvider>
          <FindControls />
          <CodexTranscriptReadOwnerContext.Provider value={owner}>
            <EnsureLocalConversationThreadScrollController>
              <LocalConversationThreadScrollLayout>
                <LocalConversationThreadBodyOwner
                  {...model}
                  turnPagination={null}
                  canonicalRequests={[]}
                  backgroundAgentRows={[]}
                  actions={buildActions()}
                  readRestoreSnapshot={() => EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
                  onRestoreSnapshotChange={() => {}}
                />
              </LocalConversationThreadScrollLayout>
            </EnsureLocalConversationThreadScrollController>
          </CodexTranscriptReadOwnerContext.Provider>
        </ContentSearchProvider>
      </TooltipProvider>,
    );
    try {
      await settleAsyncRender();
      await view.findByRole("button", { name: "Show more" });
      const fullTail = (await view.findByText("needle")).closest("a");
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Find thread text" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByLabelText("Find result").textContent).toBe("1 / 3 results"),
      );
      const unit = view.container.querySelector('[data-native-realtime-item-id="voice"]');
      await waitFor(() => expect(unit?.querySelectorAll("mark")).toHaveLength(2));
      expect(unit?.querySelector("mark.codex-thread-find-active")).toBe(
        unit?.querySelectorAll("mark").item(0),
      );
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Next match" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(unit?.querySelector("mark.codex-thread-find-active")).toBe(
          unit?.querySelectorAll("mark").item(1),
        ),
      );
      expect(rowPlacements).not.toHaveBeenCalled();
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [{ type: "realtime-text", itemId: "voice", delta: " new ending" }],
        });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(unit?.textContent).toBe("spoken needle and needle new ending");
        expect(unit?.querySelectorAll("mark")).toHaveLength(2);
        expect(unit?.querySelector("mark.codex-thread-find-active")).toBe(
          unit?.querySelectorAll("mark").item(1),
        );
      });
      const user = view.container.querySelector('[data-native-realtime-item-id="user"]');
      expect(user?.closest("[data-thread-turn-id]")).toBe(unit?.closest("[data-thread-turn-id]"));
      expect(unit?.closest("[data-thread-turn-id]")?.getAttribute("data-thread-turn-id")).toBe(
        "realtime-voice:transcript:voice",
      );
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Next match" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(user?.querySelector("mark.codex-thread-find-active")?.textContent).toBe("needle"),
      );
      await view.findByRole("button", { name: "Show less" });
      expect(view.getByRole("link", { name: "needle" })).toBe(fullTail);
      expect(search).toHaveBeenCalledWith("thread", "needle");
      expect(search).toHaveBeenCalledOnce();
      expect(rowPlacements).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
      expect(owner.readStructure()?.turns).toHaveLength(0);
    } finally {
      view.unmount();
      search.mockRestore();
      hydrate.mockRestore();
      overflow.mockRestore();
      createSource.mockRestore();
    }
  });
  beforeEach(() => {
    vi.mocked(toast.danger).mockClear();
    installAsyncRequestAnimationFrame();
    installThreadRailWideLayoutGeometry();
    idleCallbacks = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: ((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }) as typeof window.requestIdleCallback,
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: ((handle: number) => {
        idleCallbacks.splice(handle - 1, 1);
      }) as typeof window.cancelIdleCallback,
    });
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    restoreSelectedTextRangeGeometry();
    restoreThreadRailLayoutGeometry();
  });

  test("keeps first-submission presentation visible through normalized initial and multipart reset", async () => {
    const clientId = "first-submission-client";
    const prompt = "Keep the submitted message visible.";
    const owner = new CodexTranscriptReadOwner({ hostId: "local", threadId: "thread_1" });
    const overlay = buildTurn({
      entityKey: `turn-local:${clientId}`,
      turnId: null,
      status: "inProgress",
      items: [
        buildUserEntry({
          turnId: null,
          markdownText: prompt,
          rawItem: { type: "userMessage", id: "overlay", clientId, content: [] },
        }),
      ],
      itemIds: ["overlay"],
    });
    const model = buildModel({
      conversation: buildConversation({ turns: [] }),
      body: buildThreadBodyModel({
        activeThreadId: "thread_1",
        conversation: buildConversation({ turns: [], resumeState: "needs_resume" }),
        firstSubmissionActive: true,
        activeThreadArchived: false,
        parentTurns: [],
        isNewThreadTab: false,
        newThreadTarget: null,
        threadStartProgress: null,
      }),
    });
    const renderOwner = (presentationTurn: CodexConversationTurn | null) => (
      <TooltipProvider>
        <CodexTranscriptReadOwnerContext.Provider value={owner}>
          <EnsureLocalConversationThreadScrollController>
            <LocalConversationThreadScrollLayout>
              <LocalConversationThreadBodyOwner
                {...model}
                firstSubmissionTurn={presentationTurn}
                turnPagination={null}
                canonicalRequests={[]}
                backgroundAgentRows={[]}
                actions={buildActions()}
                readRestoreSnapshot={() => EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
                onRestoreSnapshotChange={() => {}}
              />
            </LocalConversationThreadScrollLayout>
          </EnsureLocalConversationThreadScrollController>
        </CodexTranscriptReadOwnerContext.Provider>
      </TooltipProvider>
    );
    const view = render(renderOwner(overlay));
    await waitFor(() => expect(view.getAllByText(prompt)).toHaveLength(1));
    const hydration: Parameters<typeof createCodexCanonicalHydratedConversationState>[1] = {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    };
    const state = createCodexCanonicalHydratedConversationState(
      { ...buildAgentActivityV2CorpusThread([]), id: "thread_1", turns: [] },
      hydration,
    );
    await act(async () => {
      owner.applyEvent({ type: "reset", value: projectCodexTranscript(state) });
      await Promise.resolve();
    });
    expect(view.getAllByText(prompt)).toHaveLength(1);
    const populated = createCodexCanonicalHydratedConversationState(
      {
        ...buildAgentActivityV2CorpusThread([]),
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            rootTurnId: null,
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
            items: [
              {
                type: "userMessage",
                id: "canonical-user",
                clientId,
                content: [{ type: "text", text: prompt, text_elements: [] }],
              },
            ],
          },
        ],
      },
      hydration,
    );
    populated.turns[0]!.params.clientUserMessageId = clientId;
    const snapshot = projectCodexTranscript(populated);
    await act(async () => {
      owner.applyEvent({ type: "reset-start", value: snapshot });
      owner.applyEvent({
        type: "reset-part",
        turnsByKey: snapshot.turnsByKey,
        itemsByKey: snapshot.itemsByKey,
        realtimeItems: snapshot.realtimeItems,
      });
      await Promise.resolve();
    });
    expect(view.getAllByText(prompt)).toHaveLength(1);
    // The launch owner can already acknowledge its canonical write while the
    // independent read subscription still owns an uncommitted multipart reset.
    view.rerender(renderOwner(null));
    await waitFor(() => expect(view.getAllByText(prompt)).toHaveLength(1));
    await act(async () => {
      owner.applyEvent({ type: "reset-commit" });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getAllByText(prompt)).toHaveLength(1));
    expect(view.container.querySelectorAll('[data-user-message-bubble="true"]')).toHaveLength(1);
    view.unmount();
  });

  test.each<[string, CodexCanonicalServerRequest]>([
    [
      "option picker",
      {
        id: "option-request",
        method: "item/tool/requestOptionPicker",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          question: "Which slice should we ship?",
          options: [{ label: "UI" }, { label: "Backend" }],
        },
      },
    ],
  ])(
    "blocks Thinking when a canonical %s reaches the reconstructed body",
    async (_label, request) => {
      const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
      const activeConversation = buildConversation({
        turns: [
          buildTurn({
            status: "inProgress",
            itemIds: ["user_1"],
            items: [buildUserEntry()],
          }),
        ],
      });
      const renderBody = (conversation: CodexConversationSnapshot) => (
        <TooltipProvider>
          <LocalConversationThreadBody
            model={buildModel({ conversation })}
            actions={buildActions()}
          />
        </TooltipProvider>
      );
      const view = render(renderBody(activeConversation));
      await settleAsyncRender();
      expect(view.queryAllByText("Thinking").length > 0).toBe(true);

      view.rerender(
        renderBody({
          ...activeConversation,
          canonicalRequests: [request],
        }),
      );
      await settleAsyncRender();

      expect(view.queryAllByText("Thinking").length).toBe(0);
    },
  );

  test.each(["hidden transcript", "resuming history"] as const)(
    "restores the latest reading position after %s remounts the turn list",
    async (reason) => {
      const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
      installThreadRailWideLayoutGeometry();
      installMeasuredResizeObserver({ blockSize: 500, inlineSize: 1_000 });
      let appHandle: ScopeHandle | null = null;
      function RestoreProbe() {
        const handle = useScopeHandle(appScope);
        useLayoutEffect(() => {
          appHandle = handle;
        }, [handle]);
        return null;
      }
      const model = buildModel();
      const actions = buildActions();
      const waiting: ThreadBodySurfaceModel = {
        ...model,
        turns: [],
        body: {
          ...model.body,
          turnCount: 0,
          emptyState: {
            type: "resumingThread",
            title: "Restoring thread",
            description: "Loading history",
            status: "resuming",
          },
        },
      };
      const content = (unmounted: boolean) => (
        <TooltipProvider>
          <RestoreProbe />
          <LocalConversationThreadBody
            model={unmounted && reason === "resuming history" ? waiting : model}
            actions={actions}
            transcriptVisible={!(unmounted && reason === "hidden transcript")}
          />
        </TooltipProvider>
      );
      const view = render(content(false));
      const viewport = view.container.querySelector<HTMLDivElement>(
        "[data-local-conversation-thread-body='true']",
      )!;
      const handle = appHandle as ScopeHandle | null;
      if (!handle) throw new Error("Expected the Chat's view-state owner");
      const snapshot = () => handle.get(localConversationThreadRestoreSnapshotFamily("thread_1"));
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 500 },
        scrollHeight: { configurable: true, value: 2_000 },
      });
      await settleAsyncRender();
      await act(async () => {
        viewport.scrollTop = 1_500;
        viewport.dispatchEvent(new Event("scroll"));
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
        viewport.scrollTop = 1_200;
        viewport.dispatchEvent(new Event("scroll"));
        await Promise.resolve();
      });
      expect(snapshot().distanceFromBottomPx).toBe(300);

      view.rerender(content(true));
      expect(view.queryByText("Assistant message")).toBeNull();
      await act(async () => {
        // Removing the transcript can clamp its retained native viewport to its end.
        viewport.scrollTop = 1_500;
        viewport.dispatchEvent(new Event("scroll"));
        await Promise.resolve();
      });
      expect(snapshot().distanceFromBottomPx).toBe(300);

      view.rerender(content(false));
      await waitFor(() => expect(viewport.scrollTop).toBe(1_200));
      expect(view.getByText("Assistant message")).toBeTruthy();
      expect(view.container.querySelector("[data-local-conversation-thread-body='true']")).toBe(
        viewport,
      );
      expect(snapshot().distanceFromBottomPx).toBe(300);
    },
  );

  test("registers Find again after a floating transcript collapses and reopens", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const model = buildModel({
      conversation: buildConversation({
        turns: [
          buildTurn({
            items: [buildUserEntry(), buildAssistantEntry({ markdownText: "Floating needle" })],
          }),
        ],
      }),
    });
    const actions = buildActions();
    const content = (expanded: boolean) => (
      <TooltipProvider>
        <ContentSearchProvider>
          <FindControls />
          {expanded ? (
            <LocalConversationThreadBody presentation="floating" model={model} actions={actions} />
          ) : null}
        </ContentSearchProvider>
      </TooltipProvider>
    );
    const view = render(content(true));
    try {
      for (let mount = 0; mount < 2; mount += 1) {
        await view.findByText("Floating needle");
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: "Find thread text" }));
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(view.getByLabelText("Find result").textContent).toBe("1 / 1 results"),
        );
        await waitFor(() =>
          expect(view.container.querySelector("mark.codex-thread-find-active")?.textContent).toBe(
            "needle",
          ),
        );
        view.rerender(content(false));
        await settleAsyncRender();
        expect(view.container.querySelector("mark")).toBeNull();
        view.rerender(content(true));
      }
    } finally {
      view.unmount();
    }
  });

  test.each(["main", "floating"] as const)(
    "%s restores only its own viewport lifecycle when a saved conversation position exists",
    async (presentation) => {
      const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
      const clientHeight = vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockReturnValue(500);
      const scrollHeight = vi
        .spyOn(HTMLElement.prototype, "scrollHeight", "get")
        .mockReturnValue(2_000);
      let appHandle: ScopeHandle | null = null;
      let controller: LocalConversationThreadScrollControllerValue | null = null;
      function StoreProbe() {
        const handle = useScopeHandle(appScope);
        useLayoutEffect(() => {
          appHandle = handle;
        }, [handle]);
        return null;
      }
      function ScrollProbe() {
        const scroll = useLocalConversationThreadScrollController();
        useLayoutEffect(() => {
          controller = scroll;
        });
        return null;
      }
      const model = buildModel({
        conversation: buildConversation({
          statusType: "active",
          turns: [buildTurn({ status: "inProgress", firstTurnWorkItemStartedAtMs: 10 })],
        }),
      });
      const actions = buildActions();
      const content = (mounted: boolean) => (
        <TooltipProvider>
          <StoreProbe />
          {mounted ? (
            <LocalConversationThreadBody
              presentation={presentation}
              model={model}
              actions={actions}
              footer={<ScrollProbe />}
            />
          ) : null}
        </TooltipProvider>
      );
      const view = render(content(false));
      const handle = appHandle as ScopeHandle | null;
      if (!handle) throw new Error("Missing restore owner");
      const atom = localConversationThreadRestoreSnapshotFamily("thread_1");
      const saved = {
        ...EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
        distanceFromBottomPx: 300,
      };
      await act(async () => {
        handle.set(atom, saved);
        await Promise.resolve();
      });
      const write = vi.spyOn(threadViewState, "updateLocalConversationThreadRestoreSnapshot");
      const family = vi.spyOn(threadViewState, "localConversationThreadRestoreSnapshotFamily");
      try {
        for (let mount = 0; mount < 2; mount += 1) {
          view.rerender(content(true));
          await settleAsyncRender();
          const scroll = controller as LocalConversationThreadScrollControllerValue | null;
          if (!scroll) throw new Error("Missing viewport owner");
          const viewport = view.getByRole("region", { name: "Conversation" });
          await waitFor(() =>
            expect(viewport.scrollTop).toBe(presentation === "floating" ? 1_500 : 1_200),
          );
          expect(scroll.getScrollMode()).toBe(
            presentation === "floating" ? "stickToBottom" : "user",
          );
          expect(scroll.responseSpacerState === null).toBe(presentation === "floating");
          await act(async () => {
            viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
            viewport.scrollTop = 1_100;
            viewport.dispatchEvent(new Event("scroll"));
            await Promise.resolve();
          });
          expect(scroll.getScrollMode()).toBe("user");
          view.rerender(content(false));
          await settleAsyncRender();
          if (presentation === "floating") {
            expect(family).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
            expect(handle.get(atom)).toBe(saved);
          } else {
            expect(write).toHaveBeenCalled();
            expect(handle.get(atom).distanceFromBottomPx).toBe(400);
            // Each main mount starts from its most recent saved position.
            await act(async () => {
              handle.set(atom, saved);
              await Promise.resolve();
            });
          }
        }
      } finally {
        view.unmount();
        family.mockRestore();
        write.mockRestore();
        clientHeight.mockRestore();
        scrollHeight.mockRestore();
      }
    },
  );

  test("releases archived restore pending state after rejection so the action can retry", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    let rejectRestore: (error: Error) => void = () => {};
    const pending = new Promise<void>((_, reject) => {
      rejectRestore = reject;
    });
    const restore = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce(undefined);
    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({ archived: true, resumeState: "needs_resume" }),
          })}
          actions={buildActions({ onUnarchiveThread: restore })}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore" }));
    });
    expect(view.getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      rejectRestore(new Error("Restore unavailable"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(false),
    );
    expect(toast.danger).toHaveBeenLastCalledWith("Couldn’t restore the chat", {
      description: "Restore unavailable",
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore" }));
    });
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(toast.danger).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("releases a rejected latest-turn fork lock and accepts a second submission", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    let rejectFork: (error: Error) => void = () => {};
    const pending = new Promise<void>((_, reject) => {
      rejectFork = reject;
    });
    const fork = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce(undefined);
    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({
              turns: [
                buildTurn({
                  turnId: "turn_latest",
                  status: "completed",
                  items: [
                    buildUserEntry({
                      turnId: "turn_latest",
                      itemId: "user_latest",
                      markdownText: "Fork me",
                    }),
                    buildAssistantEntry({ turnId: "turn_latest", itemId: "assistant_latest" }),
                  ],
                }),
              ],
            }),
          })}
          actions={buildActions({ onForkFromTurn: fork })}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByLabelText("Fork chat from here"));
    });
    expect(fork).toHaveBeenCalledOnce();
    await act(async () => {
      rejectFork(new Error("Fork unavailable"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByLabelText("Fork chat from here").hasAttribute("disabled")).toBe(false),
    );
    expect(toast.danger).toHaveBeenLastCalledWith("Couldn’t fork the conversation", {
      description: "Fork unavailable",
    });
    await act(async () => {
      fireEvent.click(view.getByLabelText("Fork chat from here"));
    });
    await waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    expect(toast.danger).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("offers Edit only on Runtime messages with an exact recorded predecessor", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const conversation = buildConversation({
      turns: [buildIndexedTurn(1), buildIndexedTurn(2), buildIndexedTurn(3)],
    });
    conversation.capabilityFlags.editableUserTurnIds = ["turn_1", "turn_2"];
    const edited: string[] = [];
    const screen = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({ conversation })}
          actions={buildActions({
            onEditUserTurn: async (input) => {
              edited.push(input.turnId);
            },
          })}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();
    expect(screen.getAllByRole("button", { name: "Edit message" })).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Edit message" })[1]!);
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Message 2")).toBeTruthy();
    expect(screen.queryByDisplayValue("Message 3")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(edited).toEqual(["turn_2"]));
  });
});

vi.mock("@/components/ui/toast", () => ({
  toast: { danger: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
