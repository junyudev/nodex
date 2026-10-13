import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { NodexTooltipProvider } from "../../components/ui/tooltip";
import { renderWithMaitai } from "../../test/thread-maitai";
import { installAsyncRequestAnimationFrame } from "../../test/browser-globals";
import { settleAsyncRender } from "../../test/dom";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptStructure,
} from "./normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "./normalized-transcript-selectors";
import { projectNormalizedTimelineEntries } from "./projection/normalized-timeline-entries";
import { timelineOwnerFixture } from "./projection/normalized-timeline.test-fixtures";
import { LocalConversationTestQueryProvider } from "./view/local-conversation-test-query.test-fixtures";
import { EnsureLocalConversationThreadScrollController } from "./view/local-conversation-thread-scroll-controller";
import { LocalConversationVirtualizedTurnList } from "./view/local-conversation-virtualized-turn-list";
import type { CodexConversationHistoryTurnItemsRef } from "../../../shared/codex-conversation-history-page";
import {
  InlineVisualizationSurfaceProvider,
  InlineVisualizationWindowProvider,
} from "./view/inline-visualization-window";
import type { ThreadTimelineEntry } from "@nodex/codex-app-server-protocol/v2";
import type {
  createInlineVisualizationRuntime,
  InlineVisualizationRuntime,
} from "../../lib/inline-visualization/inline-visualization-runtime";
import { createInlineVisualizationAnnotations } from "../../lib/inline-visualization/inline-visualization-annotations";

const guest = vi.hoisted(() => ({
  create:
    vi.fn<
      (input: Parameters<typeof createInlineVisualizationRuntime>[0]) => InlineVisualizationRuntime
    >(),
}));
vi.mock("../../lib/inline-visualization/inline-visualization-runtime", () => ({
  createInlineVisualizationRuntime: guest.create,
}));

function completedTurn(position: number): ThreadTimelineEntry {
  return {
    type: "turnCompleted",
    position,
    turnId: "one",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
  };
}

function TimelineHarness({
  itemRef,
  loadItems,
}: {
  itemRef?: CodexConversationHistoryTurnItemsRef;
  loadItems?: (ref: CodexConversationHistoryTurnItemsRef) => Promise<unknown>;
}) {
  const { owner, structure } = useCodexTranscriptStructure();
  const projection = useMemo(
    () =>
      owner && structure
        ? projectNormalizedTimelineEntries({
            owner,
            structure,
            entries: selectNormalizedConversationTurnEntries({
              owner,
              structure,
              conversation: null,
            }),
          })
        : null,
    [owner, structure],
  );
  if (!projection) return null;
  return (
    <EnsureLocalConversationThreadScrollController>
      <LocalConversationVirtualizedTurnList
        conversationId="thread"
        entries={[...projection.entries]}
        historyRows={projection.historyRows ?? undefined}
        threadCwd="/workspace"
        editableTurnId={null}
        canForkFromTurn={false}
        scrollElement={null}
        historyTurnItemsRefs={
          itemRef ? { [itemRef.turnId]: { older: itemRef, newer: null } } : undefined
        }
        onLoadHistoryTurnItems={loadItems}
      />
    </EnsureLocalConversationThreadScrollController>
  );
}

function renderTimeline(
  owner: ReturnType<typeof timelineOwnerFixture>["owner"],
  props: Parameters<typeof TimelineHarness>[0] = {},
) {
  return renderWithMaitai(
    <CodexTranscriptReadOwnerContext.Provider value={owner}>
      <NodexTooltipProvider>
        <InlineVisualizationWindowProvider>
          <InlineVisualizationSurfaceProvider id="main" hostId="local" threadId="thread" active>
            <TimelineHarness {...props} />
          </InlineVisualizationSurfaceProvider>
        </InlineVisualizationWindowProvider>
      </NodexTooltipProvider>
    </CodexTranscriptReadOwnerContext.Provider>,
    { wrapper: LocalConversationTestQueryProvider },
  );
}

let originalApi: typeof window.api;
beforeEach(() => {
  installAsyncRequestAnimationFrame();
  originalApi = window.api;
  window.api = {
    ...originalApi,
    on: originalApi?.on ?? (() => () => {}),
    invoke: async (channel, ...args) => {
      if (channel !== "codex:visualization:read") return originalApi?.invoke(channel, ...args);
      const input = args[0];
      if (!input || typeof input !== "object") throw new Error("Missing visualization read input");
      const file: unknown = Reflect.get(input, "file");
      if (typeof file !== "string") throw new Error("Missing visualization file");
      expect(input).toMatchObject({ hostId: "local", sourceThreadId: "thread", turnId: "one" });
      return { path: `/workspace/${file}`, contents: `<button>${file}</button>` };
    },
  };
  guest.create.mockReset().mockImplementation((input) => {
    const element = document.createElement("div");
    element.innerHTML = input.html;
    const snapshot = {
      status: "ready" as const,
      height: 150,
      fullscreenHeight: null,
      displayMode: "inline" as const,
      error: null,
    };
    return {
      element,
      annotations: createInlineVisualizationAnnotations({ allowed: true, globals: () => {} }),
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      setActive: vi.fn(),
      setDisplayMode: () => "inline",
      captureImage: vi.fn(async () => new Uint8Array()),
      copyAsImage: vi.fn(async () => {}),
      dispose: vi.fn(async () => {
        element.remove();
      }),
    };
  });
});
afterEach(() => {
  window.api = originalApi;
});

describe("native realtime history in the production virtualizer", () => {
  test("renders voice-only history, updates one keyed leaf, and releases the last consumer", async () => {
    const { owner } = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "transcriptSegment",
            id: "voice-a",
            realtimeSessionId: "session",
            role: "assistant",
            text: "First voice",
          },
        },
        {
          type: "realtime",
          position: 2,
          item: {
            type: "transcriptSegment",
            id: "voice-b",
            realtimeSessionId: "session",
            role: "user",
            text: "Other voice",
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const view = renderTimeline(owner);
    await settleAsyncRender();
    const untouched = view.getByText("Other voice");
    const structure = owner.readStructure();
    const projectWholeTurn = vi.spyOn(owner, "readTurn");
    await act(async () => {
      owner.applyEvent({
        type: "changes",
        changes: [{ type: "realtime-text", itemId: "voice-a", delta: " updated" }],
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText("First voice updated")).toBeDefined());
    expect(view.getByText("Other voice")).toBe(untouched);
    expect(owner.readStructure()).toBe(structure);
    expect(projectWholeTurn).not.toHaveBeenCalled();
    expect(owner.readStructure()?.turns).toHaveLength(0);
    view.unmount();
    expect(owner.readStructure()).toBeNull();
    expect(owner.readRealtimeItem("voice-a")).toBeNull();
  });

  test("keeps native messages on either side of a voice item in rollout order", async () => {
    const before = {
      type: "agentMessage",
      id: "before",
      text: "Before voice",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    } as const;
    const after = { ...before, id: "after", text: "After voice" };
    const { owner } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 1, turnId: "one", item: before },
          {
            type: "realtime",
            position: 2,
            item: {
              type: "transcriptSegment",
              id: "voice",
              realtimeSessionId: "session",
              role: "assistant",
              text: "Voice between",
            },
          },
          { type: "item", position: 3, turnId: "one", item: after },
          completedTurn(4),
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [before, after],
    );
    const view = renderTimeline(owner);
    await settleAsyncRender();
    const first = view.getByText("Before voice");
    const voice = view.getByText("Voice between");
    const last = view.getByText("After voice");
    expect(first.compareDocumentPosition(voice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(voice.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      owner.applyEvent({ type: "reset", value: null });
      await Promise.resolve();
    });
    expect(view.queryByText("Voice between")).toBeNull();
    expect(owner.readRealtimeItem("voice")).toBeNull();
  });

  test.each(["wholeItem", "inlineMarkdown", "inlineVisualization"] as const)(
    "renders a native %s promotion in place once and retains the adjacent transcript",
    async (type) => {
      const before = {
        type: "agentMessage",
        id: "before",
        text: "Before artifact",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      } as const;
      const artifact =
        type === "wholeItem"
          ? ({ type: "plan", id: "artifact", text: "Native artifact" } as const)
          : {
              ...before,
              id: "artifact",
              text:
                type === "inlineMarkdown"
                  ? "::codex-realtime-inline{}\nNative artifact"
                  : '::codex-inline-vis{file="chart.html"}',
            };
      const after = { ...before, id: "after", text: "After artifact" };
      const { owner } = timelineOwnerFixture(
        {
          data: [
            { type: "item", position: 1, turnId: "one", item: artifact },
            {
              type: "realtime",
              position: 2,
              item: {
                type: "transcriptSegment",
                id: "voice",
                realtimeSessionId: "session",
                role: "user",
                text: "Voice before artifact",
              },
            },
            {
              type: "realtime",
              position: 3,
              item: {
                type: "bemItemPromoted",
                id: "promotion",
                realtimeSessionId: "session",
                turnId: "one",
                itemId: "artifact",
                presentation: type === "inlineVisualization" ? { type, index: 0 } : { type },
              },
            },
            { type: "item", position: 4, turnId: "one", item: after },
            completedTurn(5),
          ],
          nextCursor: null,
          activeRealtimeSessionAtPageStart: "session",
        },
        [artifact, after],
      );
      const view = renderTimeline(owner);
      await settleAsyncRender();
      const voice = view.getByText("Voice before artifact");
      const promoted =
        type === "inlineVisualization"
          ? await view.findByText("chart.html")
          : view.getByText("Native artifact");
      const last = view.getByText("After artifact");
      expect(
        voice.compareDocumentPosition(promoted) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      if (type !== "wholeItem")
        expect(
          promoted.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      if (type !== "inlineMarkdown") return;
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "text",
              key: {
                hostId: "local",
                threadId: "thread",
                entityKey: "turn:one",
                itemId: "artifact",
              },
              target: { field: "text" },
              edits: [{ at: artifact.text.length, deleteCount: 0, insert: " updated" }],
            },
          ],
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(view.getByText("Native artifact updated")).toBeDefined());
      expect(view.getByText("Voice before artifact")).toBe(voice);
      expect(view.getByText("After artifact")).toBe(last);
    },
  );

  test("retries a failed current item page in place without reopening the chat", async () => {
    const answer = { type: "plan", id: "answer", text: "Current item" } as const;
    const { owner } = timelineOwnerFixture(
      { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
      [answer],
    );
    const ref: CodexConversationHistoryTurnItemsRef = {
      turnId: "one",
      expectedTopologyGeneration: 1,
      edge: "older",
      progressKey: "page-a",
    };
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Native page failed"))
      .mockResolvedValue("stop");
    const view = renderTimeline(owner, { itemRef: ref, loadItems: load });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByRole("button", { name: "Try again" })).toBeDefined());
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[0]).toBe(ref);
    await waitFor(() => expect(view.queryByRole("button", { name: "Try again" })).toBeNull());
  });

  test("renders two indexed promotions of one native assistant at their separate timeline positions", async () => {
    const artifact = {
      type: "agentMessage",
      id: "artifact",
      text: '::codex-inline-vis{file="chart.html"}\n::codex-inline-vis{file="table.html"}',
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    } as const;
    const { owner } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 0, turnId: "one", item: artifact },
          {
            type: "realtime",
            position: 1,
            item: {
              type: "bemItemPromoted",
              id: "chart-promotion",
              realtimeSessionId: "session",
              turnId: "one",
              itemId: artifact.id,
              presentation: { type: "inlineVisualization", index: 0 },
            },
          },
          {
            type: "realtime",
            position: 2,
            item: {
              type: "transcriptSegment",
              id: "voice",
              realtimeSessionId: "session",
              role: "assistant",
              text: "Voice between visualizations",
            },
          },
          {
            type: "realtime",
            position: 3,
            item: {
              type: "bemItemPromoted",
              id: "table-promotion",
              realtimeSessionId: "session",
              turnId: "one",
              itemId: artifact.id,
              presentation: { type: "inlineVisualization", index: 1 },
            },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [artifact],
    );
    const view = renderTimeline(owner);
    await settleAsyncRender();
    const chart = await view.findByText("chart.html");
    const voice = view.getByText("Voice between visualizations");
    const table = await view.findByText("table.html");
    expect(chart.closest("[data-turn-key]")?.getAttribute("data-turn-key")).not.toBe(
      table.closest("[data-turn-key]")?.getAttribute("data-turn-key"),
    );
    expect(chart.compareDocumentPosition(voice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(voice.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(owner.readItemSlots("turn:one")?.entries).toHaveLength(1);
    const structure = owner.readStructure();
    await act(async () => {
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "text",
            key: {
              hostId: "local",
              threadId: "thread",
              entityKey: "turn:one",
              itemId: artifact.id,
            },
            target: { field: "text" },
            edits: [
              { at: artifact.text.indexOf("table.html"), deleteCount: 10, insert: "updated.html" },
            ],
          },
        ],
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText("updated.html")).toBeDefined());
    expect(view.getByText("chart.html")).toBe(chart);
    expect(view.getByText("Voice between visualizations")).toBe(voice);
    expect(owner.readStructure()).toBe(structure);
  });

  test("whole-item promotions share one work rendering for the same canonical item", async () => {
    const artifact = { type: "plan", id: "artifact", text: "Repeated native artifact" } as const;
    const { owner } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 0, turnId: "one", item: artifact },
          ...["first", "second"].map((id, index) => ({
            type: "realtime" as const,
            position: index + 1,
            item: {
              type: "bemItemPromoted" as const,
              id,
              realtimeSessionId: "session",
              turnId: "one",
              itemId: artifact.id,
              presentation: { type: "wholeItem" as const },
            },
          })),
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [artifact],
    );
    const sliceRead = vi.spyOn(owner, "readTurnSlice");
    const view = renderTimeline(owner);
    await settleAsyncRender();
    expect(view.getAllByText("Repeated native artifact")).toHaveLength(1);
    expect(sliceRead).toHaveBeenCalled();
    const rendered: ReturnType<typeof owner.readTurnSlice> | undefined =
      sliceRead.mock.results.at(-1)?.value;
    expect(rendered?.itemIds).toEqual([artifact.id]);
    expect(rendered?.items.map((item) => item.rawItemId)).toEqual([artifact.id]);
  });
});
