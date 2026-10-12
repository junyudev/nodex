import { act, fireEvent, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import {
  ReducedMotionProvider,
  useReducedMotionPreference,
} from "../../../../../lib/use-reduced-motion";
import { MarkdownRenderer } from "./markdown-renderer";
import { ThreadAssistantBodyBlock } from "../../blocks/local-conversation-block-leaves";
import type { ThreadTranscriptBlockModel } from "../../../thread-stage-types";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { timelineOwnerFixture } from "../../../projection/normalized-timeline.test-fixtures";
import { isCodexTimelineTurnEntry } from "../../../projection/normalized-timeline-entries";
import { CodexTranscriptReadOwnerContext } from "../../../normalized-transcript-hooks";
import { LocalConversationTimelinePromotion } from "../../local-conversation-timeline-promotion";

// Observe the real presentation owner independently of the rich parser's own animation timers.
vi.mock("./markdown-core", () => ({
  MarkdownCore: ({
    content,
    animateStreamingText,
  }: {
    content: string;
    animateStreamingText?: boolean;
  }) => (
    <output aria-label={animateStreamingText ? "Animated Markdown" : "Markdown"}>{content}</output>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const source = "Prefix" + "x".repeat(200);
const leaf = (content: string, streaming = true, streamId = "thread:answer") => (
  <MarkdownRenderer
    content={content}
    parseIncompleteMarkdown={streaming}
    animateStreamingText={streaming}
    adaptiveBuffering={{ streamId }}
  />
);

describe("mounted adaptive Markdown", () => {
  test("native Markdown promotion follows the real Turn despite its completed row and commentary source phase", async () => {
    vi.useFakeTimers();
    const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };
    const item = (text: string): Extract<ThreadItem, { type: "agentMessage" }> => ({
      type: "agentMessage",
      id: "answer",
      text: `::codex-realtime-inline{}\n${text}`,
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
      questions: null,
    });
    const fixture = timelineOwnerFixture(
      {
        data: [
          {
            type: "realtime",
            position: 1,
            item: {
              type: "bemItemPromoted",
              id: "promotion",
              realtimeSessionId: "session",
              turnId: "one",
              itemId: "answer",
              presentation: { type: "inlineMarkdown" },
            },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [item("Prefix")],
    );
    const retain = fixture.owner.subscribeStructure(() => {});
    const completed = fixture.owner.readTurnDetails(key.entityKey)!;
    fixture.owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key,
          details: { ...completed, status: "inProgress" },
          hasSubagentActivity: false,
        },
      ],
    });
    const entry = fixture
      .project()
      .entries.find(
        (value) =>
          isCodexTimelineTurnEntry(value) && value.timelinePresentation?.type === "inlineMarkdown",
      );
    if (!entry || !isCodexTimelineTurnEntry(entry)) throw new Error("Missing Markdown promotion");
    expect(entry.turnStatus).toBe("completed");
    const wholeReads = [
      vi.spyOn(fixture.owner, "readTurn"),
      vi.spyOn(fixture.owner, "readTurnSlice"),
      vi.spyOn(fixture.owner, "readItemSlots"),
    ];
    const view = render(
      <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
        <LocalConversationTimelinePromotion entry={entry} cwd={null} />
      </CodexTranscriptReadOwnerContext.Provider>,
    );
    try {
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [{ type: "item", key: { ...key, itemId: "answer" }, value: item(source) }],
        });
      });
      expect(view.getByLabelText("Animated Markdown").textContent).toBe("Prefix");
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [{ type: "turn", key, details: completed, hasSubagentActivity: false }],
        });
      });
      expect(view.getByLabelText("Markdown").textContent).toBe(source);
      for (const read of wholeReads) expect(read).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      retain();
    }
  });

  test("the actual assistant caller buffers final answers and leaves commentary immediate", () => {
    vi.useFakeTimers();
    const block = (content: string, phase: string): ThreadTranscriptBlockModel => ({
      id: phase,
      type: "assistantMessage",
      turnId: "turn",
      createdAt: 1,
      updatedAt: 1,
      searchableText: content,
      searchUnitKey: phase,
      entry: {
        threadId: "thread",
        turnId: "turn",
        itemId: phase,
        entryId: phase,
        type: "assistant_message",
        kind: "assistantMessage",
        role: "assistant",
        status: "inProgress",
        assistantPhase: phase,
        markdownText: content,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const tree = (content: string) => (
      <>
        <section aria-label="Answer">
          <ThreadAssistantBodyBlock
            block={block(content, "final_answer")}
            isLatestTurn
            isStreamingTurn
          />
        </section>
        <section aria-label="Commentary">
          <ThreadAssistantBodyBlock
            block={block(content, "commentary")}
            isLatestTurn
            isStreamingTurn
          />
        </section>
      </>
    );
    const view = render(tree("Prefix"));
    view.rerender(tree(source));
    expect(
      within(view.getByLabelText("Answer")).getByLabelText("Animated Markdown").textContent,
    ).toBe("Prefix");
    expect(
      within(view.getByLabelText("Commentary")).getByLabelText("Animated Markdown").textContent,
    ).toBe(source);
    view.unmount();
  });

  test("completion and stream replacement show full text immediately during layout replay", async () => {
    vi.useFakeTimers();
    const view = render(<StrictMode>{leaf("Prefix")}</StrictMode>);
    view.rerender(<StrictMode>{leaf(source)}</StrictMode>);
    expect(view.getByLabelText("Animated Markdown").textContent).toBe("Prefix");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    const partial = view.getByLabelText("Animated Markdown").textContent!;
    expect(partial.length).toBeGreaterThan("Prefix".length);
    expect(partial.length).toBeLessThan(source.length);
    view.rerender(<StrictMode>{leaf(source, false)}</StrictMode>);
    expect(view.getByLabelText("Markdown").textContent).toBe(source);
    view.rerender(<StrictMode>{leaf("Different stream", true, "thread:other")}</StrictMode>);
    expect(view.getByLabelText("Animated Markdown").textContent).toBe("Different stream");
    view.unmount();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  });

  test("motion preference disables buffering and flushes an already running owner", async () => {
    vi.useFakeTimers();
    function Preference() {
      const { setPreference } = useReducedMotionPreference();
      return <button onClick={() => setPreference("on")}>Reduce motion</button>;
    }
    const tree = (content: string) => (
      <ReducedMotionProvider>
        <Preference />
        {leaf(content)}
      </ReducedMotionProvider>
    );
    const view = render(tree("Prefix"));
    view.rerender(tree(source));
    expect(view.getByLabelText("Animated Markdown").textContent).toBe("Prefix");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Reduce motion" }));
      await Promise.resolve();
    });
    expect(view.getByLabelText("Markdown").textContent).toBe(source);
    view.rerender(tree(source + " immediate"));
    expect(view.getByLabelText("Markdown").textContent).toBe(source + " immediate");
    view.unmount();
  });

  test("item owners remain independent while unbuffered callers display their source", async () => {
    vi.useFakeTimers();
    const tree = (first: string, second: string) => (
      <>
        <section aria-label="First">{leaf(first)}</section>
        <section aria-label="Second">{leaf(second, true, "thread:second")}</section>
        <section aria-label="Immediate">
          <MarkdownRenderer content={first} parseIncompleteMarkdown animateStreamingText />
        </section>
      </>
    );
    const view = render(tree("Prefix", "Other"));
    view.rerender(tree(source, "Other"));
    expect(view.getByLabelText("First").textContent).toBe("Prefix");
    expect(view.getByLabelText("Second").textContent).toBe("Other");
    expect(view.getByLabelText("Immediate").textContent).toBe(source);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(view.getByLabelText("First").textContent!.length).toBeGreaterThan(6);
    expect(view.getByLabelText("Second").textContent).toBe("Other");
    view.unmount();
  });
});
