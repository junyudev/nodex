import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import { createMaitaiStore, MaitaiProvider } from "../../../lib/maitai";
import {
  WorkbenchSessionScopePath,
  type ThreadScopeDescriptor,
} from "../../../lib/workbench-ui-scopes";
import { installAsyncRequestAnimationFrame } from "../../../test/browser-globals";
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
import { EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT } from "./local-conversation-thread-view-state";
import { LocalConversationThreadBodyOwner } from "./local-conversation-thread-body-owner";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "./local-conversation-thread-scroll-controller";

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

async function flushIdleCallbacks() {
  const callbacks = idleCallbacks;
  idleCallbacks = [];
  await act(async () => {
    for (const callback of callbacks) {
      callback({
        didTimeout: false,
        timeRemaining: () => 1,
      });
    }
    await Promise.resolve();
  });
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

function installSelectedTextRangeGeometry(readRect?: () => DOMRect) {
  const resolveRect = readRect ?? (() => makeRect({ left: 240, top: 200, width: 120, height: 20 }));
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [resolveRect()];
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return resolveRect();
    },
  });
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

function buildDynamicCreateThreadEntry(
  overrides?: Partial<CodexConversationItem>,
): CodexConversationItem {
  const dynamicToolCall: NonNullable<CodexConversationItem["dynamicToolCall"]> = {
    callId: "dynamic_create_thread",
    namespace: "codex_app",
    tool: "create_thread",
    arguments: {
      prompt: "Continue in a background chat",
      target: { type: "projectless" },
    },
    status: "completed",
    contentItems: [{ type: "inputText", text: '{"threadId":"thread-created"}' }],
    success: true,
    durationMs: 8,
    completed: true,
  };

  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "dynamic_create_thread",
    entryId: "dynamic_create_thread",
    type: "dynamicToolCall",
    kind: "toolCall",
    semanticKind: "dynamicToolCall",
    status: "completed",
    toolCall: {
      subtype: "dynamic",
      toolName: dynamicToolCall.tool,
      server: dynamicToolCall.namespace ?? undefined,
      args: dynamicToolCall.arguments,
      result: dynamicToolCall.contentItems ?? undefined,
    },
    dynamicToolCall,
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
      isCloudNewThreadTarget: false,
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
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
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
                    onErrorMessage={() => {}}
                    initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
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

  test("finds a collapsed commentary and reveals its own native assistant unit", async () => {
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
    const commentary = buildAssistantEntry({
      itemId: "commentary",
      entryId: "commentary",
      markdownText: "Hidden needle commentary",
      assistantPhase: "commentary",
    });
    const final = buildAssistantEntry({
      markdownText: "Final answer",
      assistantPhase: "final_answer",
    });
    const exec = buildAssistantEntry({
      itemId: "exec",
      type: "command_execution",
      kind: "commandExecution",
      semanticKind: "exec",
      markdownText: undefined,
      status: "completed",
      toolCall: { subtype: "command", toolName: "exec_command", args: { cmd: "true" } },
      exitCode: 0,
    });
    const turn = buildTurn({
      itemIds: ["user_1", "commentary", "exec", "assistant_1"],
      items: [buildUserEntry(), commentary, exec, final],
    });
    const search = vi
      .spyOn(localConversationStore, "searchLocalPersistedHistory")
      .mockResolvedValue({
        status: "completed",
        page: {
          threadId: "thread_1",
          hostId: "local",
          hostGeneration: 1,
          topologyGeneration: 1,
          query: "needle",
          occurrences: [],
          capped: false,
        },
      });
    const model = buildModel({ conversation: buildConversation({ turns: [turn] }) });
    const view = render(
      <TooltipProvider>
        <ContentSearchProvider>
          <FindControls />
          <EnsureLocalConversationThreadScrollController>
            <LocalConversationThreadScrollLayout>
              <LocalConversationThreadBodyOwner
                {...model}
                turnPagination={null}
                canonicalRequests={[]}
                backgroundAgentRows={[]}
                actions={buildActions()}
                onErrorMessage={() => {}}
                initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
                onRestoreSnapshotChange={() => {}}
              />
            </LocalConversationThreadScrollLayout>
          </EnsureLocalConversationThreadScrollController>
        </ContentSearchProvider>
      </TooltipProvider>,
    );
    try {
      await settleAsyncRender();
      expect(view.queryByText("Hidden needle commentary")).toBeNull();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Find thread text" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByLabelText("Find result").textContent).toBe("1 / 1 results"),
      );
      await waitFor(() =>
        expect(
          view.container.querySelector(
            '[data-content-search-unit-key="turn_1:assistant:commentary"] mark.codex-thread-find-active',
          )?.textContent,
        ).toBe("needle"),
      );
      expect(
        view.container.querySelector(
          '[data-content-search-unit-key="turn_1:assistant:assistant_1"] mark',
        ),
      ).toBeNull();
      expect(rowPlacements).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      search.mockRestore();
      createSource.mockRestore();
    }
  });
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
            text: "User voice row\n".repeat(5_001) + "\n[needle](https://example.com/result)",
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
                  onErrorMessage={() => {}}
                  initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
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
        isCloudNewThreadTarget: false,
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
                onErrorMessage={() => {}}
                initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
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

  test("opens a side chat draft from selected transcript text", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const sideChatInputs: unknown[] = [];
    installSelectedTextRangeGeometry();

    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel()}
          actions={buildActions({
            onOpenSideChat: async (input) => {
              sideChatInputs.push(input);
            },
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    const selectedTextTarget = view.container.querySelector(
      "[data-thread-selected-text-target='true']",
    );
    if (selectedTextTarget === null) {
      throw new Error("expected selected text target");
    }
    const range = document.createRange();
    range.selectNodeContents(selectedTextTarget);

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(
        Boolean(view.container.querySelector("[data-selected-text-side-chat-overlay='true']")),
      ).toBe(true);
    });

    fireEvent.mouseDown(view.getByLabelText("Ask in side chat"));
    fireEvent.click(view.getByLabelText("Ask in side chat"));

    expect(JSON.stringify(sideChatInputs)).toBe(
      JSON.stringify([
        {
          kind: "draft",
          draftPrompt: "run bun test",
        },
      ]),
    );
  });

  test("does not render the selected text side chat overlay inside side chats", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    installSelectedTextRangeGeometry();

    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={{
            ...buildModel(),
            isSideChat: true,
          }}
          actions={buildActions({
            onOpenSideChat: async () => {},
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    const selectedTextTarget = view.container.querySelector(
      "[data-thread-selected-text-target='true']",
    );
    if (selectedTextTarget === null) {
      throw new Error("expected selected text target");
    }
    const range = document.createRange();
    range.selectNodeContents(selectedTextTarget);

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      Boolean(view.container.querySelector("[data-selected-text-side-chat-overlay='true']")),
    ).toBe(false);
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
    [
      "setup step",
      {
        id: "setup-request",
        method: "item/tool/call",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          callId: "setup-call",
          namespace: "codex_app",
          tool: "setup_codex_step",
          arguments: { step: "task" },
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
            onErrorMessage={() => {}}
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

  test("repositions the selected text side chat overlay after scroll remeasurement", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    let selectedRangeRect = makeRect({ left: 240, top: 200, width: 120, height: 20 });
    installSelectedTextRangeGeometry(() => selectedRangeRect);

    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel()}
          actions={buildActions({
            onOpenSideChat: async () => {},
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    const selectedTextTarget = view.container.querySelector(
      "[data-thread-selected-text-target='true']",
    );
    if (selectedTextTarget === null) {
      throw new Error("expected selected text target");
    }
    const range = document.createRange();
    range.selectNodeContents(selectedTextTarget);

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const overlay = await waitFor(() => {
      const currentOverlay = view.container.querySelector<HTMLElement>(
        "[data-selected-text-side-chat-overlay='true']",
      );
      expect(Boolean(currentOverlay)).toBe(true);
      return currentOverlay;
    });
    expect(overlay?.style.left).toBe("220px");
    expect(overlay?.style.top).toBe("160px");

    selectedRangeRect = makeRect({ left: 300, top: 260, width: 120, height: 20 });
    const scrollElement = view.container.querySelector(
      "[data-local-conversation-thread-body='true']",
    );
    if (scrollElement === null) {
      throw new Error("expected thread scroll element");
    }

    await act(async () => {
      fireEvent.scroll(scrollElement);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(overlay?.style.left).toBe("280px");
      expect(overlay?.style.top).toBe("220px");
    });
  });

  test("opens a created chat from its activity row through typed stage navigation", async () => {
    const openedThreads: Array<Parameters<ThreadStageActions["onOpenThread"]>> = [];
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const dynamicEntry = buildDynamicCreateThreadEntry();
    const conversation = buildConversation({
      turns: [
        buildTurn({
          itemIds: ["user_1", dynamicEntry.itemId, "assistant_1"],
          items: [buildUserEntry(), dynamicEntry, buildAssistantEntry()],
        }),
      ],
    });

    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({ conversation })}
          actions={buildActions({
            onOpenThread: (threadId, context) => {
              openedThreads.push([threadId, context]);
            },
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Created chat" }));
      await Promise.resolve();
    });

    expect(openedThreads).toEqual([
      ["thread-created", { createdTarget: { threadId: "thread-created" } }],
    ]);
  });

  test("lets the shared scroll layout own viewport and content wrappers", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { container } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel()}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    const viewport = container.querySelector(
      "[data-local-conversation-thread-body='true']",
    ) as HTMLDivElement | null;
    const navigationPortalTarget = container.querySelector(
      "[data-thread-user-message-navigation-portal-target='true']",
    ) as HTMLDivElement | null;
    const contentRoot = container.querySelector(
      "[data-thread-find-target='conversation']",
    ) as HTMLDivElement | null;
    const motionWrapper = viewport?.firstElementChild as HTMLDivElement | null;
    const widthWrapper = motionWrapper?.firstElementChild as HTMLDivElement | null;

    expect(Boolean(viewport)).toBe(true);
    expect(navigationPortalTarget?.contains(viewport)).toBe(true);

    expect(Boolean(motionWrapper)).toBe(true);
    expect(Boolean(widthWrapper)).toBe(true);
    expect(widthWrapper?.contains(contentRoot)).toBe(true);

    expect(Boolean(contentRoot)).toBe(true);
  });

  test("lazy-renders the user message navigation rail after idle for long threads", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const conversation = buildConversation({
      turns: [1, 2, 3, 4].map((index) => buildIndexedTurn(index)),
    });
    const { container } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({ conversation })}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    expect(Boolean(container.querySelector('nav[aria-label="User messages"]'))).toBe(false);
    await flushIdleCallbacks();
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      expect(Boolean(container.querySelector('nav[aria-label="User messages"]'))).toBe(true);
    });
  });

  test("does not render the user message navigation rail below the Codex threshold", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const conversation = buildConversation({
      turns: [1, 2, 3].map((index) => buildIndexedTurn(index)),
    });
    const { container } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({ conversation })}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );
    await flushIdleCallbacks();
    await settleAsyncRender();

    expect(Boolean(container.querySelector('nav[aria-label="User messages"]'))).toBe(false);
  });

  test("shows a restoring placeholder instead of rendering turn content while the active thread is resuming", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const model = buildModel({
      conversation: null,
      body: {
        threadId: "thread_1",
        turnCount: 0,
        isThreadRunning: false,
        activeTurnId: null,
        latestTurnId: null,
        emptyState: {
          type: "resumingThread",
          title: "Restoring thread",
          description: "Loading the latest conversation state before rendering the thread.",
          status: "resuming",
        },
        showThreadStartProgressPanel: false,
      },
    });
    const resumingModel: ThreadBodySurfaceModel = {
      ...model,
      threadId: "thread_1",
      resumeState: "resuming",
    };

    const { getByRole, queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={resumingModel}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    expect(Boolean(getByRole("status", { name: /Restoring thread/i }))).toBe(true);
    expect(Boolean(queryByText("Assistant message"))).toBe(false);
  });

  test("keeps local-project thread start progress silent in the body", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({ turns: [] }),
            threadStartProgress: {
              runInTarget: "localProject",
              threadId: "thread_1",
              phase: "startingThread",
              message: "Sending message…",
              outputText: "",
              outputTruncated: false,
              updatedAt: 10,
            },
          })}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    expect(Boolean(queryByText("Sending message…"))).toBe(false);
    expect(Boolean(queryByText("Message sent."))).toBe(false);
    expect(Boolean(queryByText("Worktree"))).toBe(false);
    expect(Boolean(queryByText("Setup"))).toBe(false);
    expect(Boolean(queryByText("No messages yet"))).toBe(false);
  });

  test("renders local-project thread start failures without worktree steps", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { getByText, queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({ turns: [] }),
            threadStartProgress: {
              runInTarget: "localProject",
              threadId: "thread_1",
              phase: "failed",
              message: "Message could not be sent.",
              outputText: "network failed",
              outputTruncated: false,
              updatedAt: 10,
            },
          })}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    expect(Boolean(getByText("Message could not be sent."))).toBe(true);
    expect(Boolean(getByText("network failed"))).toBe(true);
    expect(Boolean(queryByText("Worktree"))).toBe(false);
    expect(Boolean(queryByText("Setup"))).toBe(false);
  });

  test("keeps the new-worktree start progress steps and marks a truncated log tail", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { container, getByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({ turns: [] }),
            threadStartProgress: {
              runInTarget: "newWorktree",
              threadId: "thread_1",
              phase: "runningSetup",
              message: "Preparing worktree…",
              outputText: "setup log\n",
              outputTruncated: true,
              updatedAt: 10,
            },
          })}
          actions={buildActions()}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    expect(Boolean(getByText("Worktree"))).toBe(true);
    expect(Boolean(getByText("Setup"))).toBe(true);
    expect(Boolean(getByText("Thread"))).toBe(true);
    expect(container.textContent).toContain("[earlier output truncated]\nsetup log\n");
  });

  test("shows archived thread restore action without rendering transcript content", async () => {
    const restoreCalls: Array<{ threadId: string; projectId: string | null }> = [];
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { getByRole, queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({
              archived: true,
              resumeState: "needs_resume",
            }),
          })}
          actions={buildActions({
            onUnarchiveThread: async (threadId, projectId) => {
              restoreCalls.push({ threadId, projectId });
            },
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    expect(Boolean(queryByText("Assistant message"))).toBe(false);
    expect(Boolean(queryByText("Archived thread"))).toBe(true);

    fireEvent.click(getByRole("button", { name: "Restore" }));
    await settleAsyncRender();

    expect(restoreCalls.length).toBe(1);
    expect(restoreCalls[0]?.threadId).toBe("thread_1");
    expect(restoreCalls[0]?.projectId).toBe("project_1");
  });

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
    const reportError = vi.fn();
    const view = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({ archived: true, resumeState: "needs_resume" }),
          })}
          actions={buildActions({ onUnarchiveThread: restore })}
          onErrorMessage={reportError}
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
    expect(reportError).toHaveBeenLastCalledWith("Restore unavailable");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Restore" }));
    });
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(reportError).toHaveBeenLastCalledWith(null);
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
    const reportError = vi.fn();
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
          onErrorMessage={reportError}
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
    expect(reportError).toHaveBeenLastCalledWith("Fork unavailable");
    await act(async () => {
      fireEvent.click(view.getByLabelText("Fork chat from here"));
    });
    await waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    expect(reportError).toHaveBeenLastCalledWith(null);
    view.unmount();
  });

  test("keeps an older-turn fork confirmation disabled until submission finishes", async () => {
    const onForkFromTurnCalls: Array<{
      threadId: string;
      turnId: string;
      message: string;
    }> = [];
    let resolveFork: () => void = () => undefined;
    const pendingFork = new Promise<void>((resolve) => {
      resolveFork = resolve;
    });
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { getAllByLabelText, getByRole, queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({
              turns: [
                buildTurn({
                  turnId: "turn_older",
                  status: "completed",
                  items: [
                    buildUserEntry({
                      turnId: "turn_older",
                      itemId: "user_older",
                      markdownText: "Fork me",
                    }),
                    buildAssistantEntry({
                      turnId: "turn_older",
                      itemId: "assistant_older",
                    }),
                  ],
                }),
                buildTurn({
                  turnId: "turn_latest",
                  status: "completed",
                  items: [
                    buildUserEntry({
                      turnId: "turn_latest",
                      itemId: "user_latest",
                      markdownText: "Latest turn",
                    }),
                    buildAssistantEntry({
                      turnId: "turn_latest",
                      itemId: "assistant_latest",
                    }),
                  ],
                }),
              ],
            }),
          })}
          actions={buildActions({
            onForkFromTurn: async (input) => {
              onForkFromTurnCalls.push(input);
              await pendingFork;
            },
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(getAllByLabelText("Fork chat from here")[0]!);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(Boolean(queryByText("Continue in a new chat"))).toBe(true);
    expect(Boolean(queryByText("Use this workspace"))).toBe(true);
    expect(Boolean(queryByText("Don't ask again when forking from an older turn"))).toBe(false);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /Use this workspace/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(onForkFromTurnCalls.length).toBe(1);
    expect(onForkFromTurnCalls[0]?.turnId).toBe("turn_older");
    expect(Boolean(queryByText("Continue in a new chat"))).toBe(true);
    expect(getByRole("button", { name: /Use this workspace/ }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveFork();
      await pendingFork;
    });
    await settleAsyncRender();
    expect(Boolean(queryByText("Continue in a new chat"))).toBe(false);
  });

  test("routes the older-turn worktree choice through the injected target-turn handler", async () => {
    const localForkCalls: string[] = [];
    const worktreeForkCalls: Array<{
      threadId: string;
      targetTurnId: string;
    }> = [];
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { getAllByLabelText, getByRole, queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({
            conversation: buildConversation({
              turns: [
                buildTurn({
                  turnId: "turn_older",
                  status: "completed",
                  items: [
                    buildUserEntry({
                      turnId: "turn_older",
                      itemId: "user_older",
                      markdownText: "Fork me",
                    }),
                    buildAssistantEntry({
                      turnId: "turn_older",
                      itemId: "assistant_older",
                    }),
                  ],
                }),
                buildTurn({
                  turnId: "turn_latest",
                  status: "completed",
                  items: [
                    buildUserEntry({
                      turnId: "turn_latest",
                      itemId: "user_latest",
                      markdownText: "Latest turn",
                    }),
                    buildAssistantEntry({
                      turnId: "turn_latest",
                      itemId: "assistant_latest",
                    }),
                  ],
                }),
              ],
            }),
          })}
          actions={buildActions({
            onForkFromTurn: async ({ turnId }) => {
              localForkCalls.push(turnId);
            },
          })}
          onForkFromTurnIntoWorktree={async (input) => {
            worktreeForkCalls.push(input);
          }}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(getAllByLabelText("Fork chat from here")[0]!);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(Boolean(queryByText("Use a new worktree"))).toBe(true);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /Use a new worktree/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(localForkCalls.length).toBe(0);
    expect(worktreeForkCalls.length).toBe(1);
    expect(worktreeForkCalls[0]?.threadId).toBe("thread_1");
    expect(worktreeForkCalls[0]?.targetTurnId).toBe("turn_older");
  });

  test("opens an inline edit prompt in place and only edits on send", async () => {
    const onEditUserTurnCalls: Array<{
      threadId: string;
      turnId: string;
      message: string;
    }> = [];
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const { getByDisplayValue, getByLabelText, getByRole, queryByDisplayValue } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel()}
          actions={buildActions({
            onEditUserTurn: async (input) => {
              onEditUserTurnCalls.push(input);
            },
          })}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>,
    );

    fireEvent.click(getByLabelText("Edit message"));

    expect(onEditUserTurnCalls.length).toBe(0);
    const textarea = getByDisplayValue("run `bun test`") as HTMLTextAreaElement;
    textarea.value = "run `bun test --bail`";
    fireEvent.input(textarea);
    await settleAsyncRender();
    fireEvent.click(getByRole("button", { name: "Send" }));
    await settleAsyncRender();

    expect(Boolean(queryByDisplayValue("run `bun test --bail`"))).toBe(false);
    expect(onEditUserTurnCalls.length).toBe(1);
    expect(onEditUserTurnCalls[0]?.message).toBe("run `bun test --bail`");
  });

  test("offers Edit on every settled user message and hides it while a Turn runs", async () => {
    const onEditUserTurnCalls: Array<{ threadId: string; turnId: string; message: string }> = [];
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const turns = [buildIndexedTurn(1), buildIndexedTurn(2), buildIndexedTurn(3)];
    const actions = buildActions({
      onEditUserTurn: async (input) => {
        onEditUserTurnCalls.push(input);
      },
    });
    const view = (conversation: CodexConversationSnapshot) => (
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({ conversation })}
          actions={actions}
          onErrorMessage={() => {}}
        />
      </TooltipProvider>
    );
    const { getAllByRole, queryAllByRole, getByDisplayValue, getByRole, rerender } = render(
      view(buildConversation({ turns })),
    );
    await settleAsyncRender();
    expect(getAllByRole("button", { name: "Edit message" })).toHaveLength(3);

    await act(async () => {
      fireEvent.click(getAllByRole("button", { name: "Edit message" })[0]!);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(getByDisplayValue("Message 1"), {
        target: { value: "Message 1, rewritten" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(onEditUserTurnCalls).toEqual([
      { threadId: "thread_1", turnId: "turn_1", message: "Message 1, rewritten" },
    ]);

    rerender(
      view(
        buildConversation({
          turns: [turns[0]!, turns[1]!, { ...turns[2]!, status: "inProgress" }],
        }),
      ),
    );
    await settleAsyncRender();
    expect(queryAllByRole("button", { name: "Edit message" })).toHaveLength(0);
  });

  test("renders a worked-for toggle for the latest completed turn when a persisted collapse state exists", async () => {
    const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
    const conversation = buildConversation({
      statusType: "idle",
      turns: [
        buildTurn({
          status: "completed",
          durationMs: 125_000,
          itemIds: ["user_1", "exec_1", "commentary_1", "assistant_1"],
          items: [
            buildUserEntry(),
            buildAssistantEntry({
              itemId: "exec_1",
              type: "command_execution",
              kind: "commandExecution",
              semanticKind: "exec",
              markdownText: "",
              toolCall: { subtype: "command", toolName: "exec_command" },
            }),
            buildAssistantEntry({
              itemId: "commentary_1",
              assistantPhase: "commentary",
              markdownText: "Working",
              createdAt: 2,
              updatedAt: 2,
            }),
            buildAssistantEntry({
              itemId: "assistant_1",
              assistantPhase: "final_answer",
              markdownText: "Done",
              createdAt: 3,
              updatedAt: 3,
            }),
          ],
        }),
      ],
    });

    const { getByRole, queryByText } = render(
      <TooltipProvider>
        <LocalConversationThreadBody
          model={buildModel({ conversation })}
          actions={buildActions()}
          onErrorMessage={() => {}}
          initialUiState={{ collapsedAgentBodyByTurnId: { turn_1: true } }}
        />
      </TooltipProvider>,
    );

    expect(Boolean(getByRole("button", { name: /Worked for 2m 5s/i }))).toBe(true);
    expect(Boolean(queryByText("Working"))).toBe(false);
  });

  test.each([40, 200])(
    "immediately mounts a virtualized transcript with %i turns",
    async (turnCount) => {
      const { LocalConversationThreadBody } = await import("./local-conversation-thread-body");
      const longTurns = Array.from({ length: turnCount }, (_, index) =>
        buildTurn({
          turnId: `turn_${index + 1}`,
          items: [
            buildUserEntry({
              turnId: `turn_${index + 1}`,
              itemId: `user_${index + 1}`,
              markdownText: `Request ${index + 1}`,
              createdAt: index * 10 + 1,
              updatedAt: index * 10 + 1,
            }),
            buildAssistantEntry({
              turnId: `turn_${index + 1}`,
              itemId: `assistant_${index + 1}`,
              markdownText: `Assistant turn ${index + 1}`,
              createdAt: index * 10 + 2,
              updatedAt: index * 10 + 2,
            }),
          ],
        }),
      );

      const { queryByText } = render(
        <TooltipProvider>
          <LocalConversationThreadBody
            model={buildModel({
              conversation: buildConversation({
                turns: longTurns,
              }),
            })}
            actions={buildActions()}
            onErrorMessage={() => {}}
          />
        </TooltipProvider>,
      );

      expect(Boolean(queryByText(`Assistant turn ${turnCount}`))).toBe(true);
    },
  );
});
