import { act, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
} from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
} from "../projection/normalized-timeline-entries";
import type { ThreadTranscriptBlockModel } from "../thread-stage-types";
import { ThreadAssistantBodyBlock } from "./blocks/local-conversation-block-leaves";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import { createLocalConversationSearchSource } from "./local-conversation-search-source";
import { applyLocalConversationSearchHighlights } from "./local-conversation-thread-search-dom-marks";

// The document is stateful; the enclosing Markdown/parser and keyed subscriptions remain real.
vi.mock("./local-conversation-inline-visualization", () => ({
  LocalConversationInlineVisualization: function InteractiveDocument() {
    const [count, setCount] = useState(0);
    return (
      <button type="button" aria-label="Document counter" onClick={() => setCount((n) => n + 1)}>
        {count}
      </button>
    );
  },
}));

const query = "Tailneedle";
const tail = `\n\n## Answer result\n\n[${query}](https://example.com/result)`;
const agent = (text: string): Extract<ThreadItem, { type: "agentMessage" }> => ({
  type: "agentMessage",
  moderation: null,
  id: "answer",
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };

function assistantBlock(content: string, searchUnitKey: string): ThreadTranscriptBlockModel {
  return {
    id: "answer",
    type: "assistantMessage",
    turnId: "one",
    createdAt: 1,
    updatedAt: 2,
    searchableText: content,
    searchUnitKey,
    entry: {
      threadId: "thread",
      turnId: "one",
      itemId: "answer",
      rawItemId: "answer",
      entryId: "answer",
      type: "assistant_message",
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      role: "assistant",
      status: "completed",
      markdownText: content,
      createdAt: 1,
      updatedAt: 2,
    },
  };
}

function searchSource(fixture: ReturnType<typeof timelineOwnerFixture>) {
  return createLocalConversationSearchSource({
    routeContextId: "thread",
    getTurns: () => [],
    getProjectedEntries: () => fixture.project().entries,
    readOwner: () => fixture.owner,
    scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
  });
}

describe("large assistant rich content", () => {
  test.each(["ordinary", "inlineMarkdown", "voiceAssistant"] as const)(
    "keeps canonical source search independent of a repaired display tail for %s",
    async (family) => {
      const content = "**Visible** [unseen";
      const item = agent(
        family === "inlineMarkdown" ? `::codex-realtime-inline{}\n${content}` : content,
      );
      const fixture = timelineOwnerFixture(
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
        family === "voiceAssistant" ? undefined : { status: "inProgress" },
      );
      const retain = fixture.owner.subscribeStructure(() => {});
      const details = fixture.owner.readTurnDetails(key.entityKey);
      const voice = fixture.owner.readRealtimeItem("voice");
      if (voice)
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            { type: "realtime-item", itemId: "voice", value: { ...voice, completed: false } },
          ],
        });
      else if (details)
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "turn",
              key,
              details: {
                ...details,
                status: "inProgress",
                lifecycleStatusByItemId: { answer: "inProgress" },
              },
              hasSubagentActivity: false,
            },
          ],
        });
      const source = searchSource(fixture);
      const unit = source.findMatches("Visible")[0]!;
      const entry = fixture
        .project()
        .entries.find((candidate) =>
          family === "inlineMarkdown"
            ? isCodexTimelineTurnEntry(candidate) &&
              candidate.timelinePresentation?.type === "inlineMarkdown"
            : isCodexRealtimeTimelineEntry(candidate),
        );
      const block = assistantBlock(content, unit.key);
      const leaf = (streaming: boolean) =>
        family === "ordinary" ? (
          <CodexTranscriptTurnEntityContext.Provider value={key.entityKey}>
            <ThreadAssistantBodyBlock block={block} isLatestTurn isStreamingTurn={streaming} />
          </CodexTranscriptTurnEntityContext.Provider>
        ) : entry && isCodexRealtimeTimelineEntry(entry) ? (
          <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd={null} />
        ) : entry && isCodexTimelineTurnEntry(entry) ? (
          <LocalConversationTurnEntry
            entry={entry}
            conversationId="thread"
            cwd={null}
            canEditTurnUserPrefix={false}
            canForkTurn={false}
          />
        ) : null;
      const wrap = (streaming: boolean) => (
        <StrictMode>
          <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
            {leaf(streaming)}
          </CodexTranscriptReadOwnerContext.Provider>
        </StrictMode>
      );
      const view = render(wrap(true), { wrapper: LocalConversationTestQueryProvider });
      try {
        await view.findByText("Visible");
        const strong = view.container.querySelector("strong");
        expect(strong?.textContent).toBe("Visible");
        expect(view.queryByText(/\[unseen/)).toBeNull();
        expect(source.findMatches("unseen")).toHaveLength(1);
        expect(source.findMatches("Visible")[0]?.text).toBe(
          family === "voiceAssistant" ? "**Visible** [unseen" : "Visible [unseen",
        );
        await act(async () => {
          if (voice)
            fixture.owner.applyEvent({
              type: "changes",
              changes: [
                { type: "realtime-item", itemId: "voice", value: { ...voice, completed: true } },
              ],
            });
          else if (details)
            fixture.owner.applyEvent({
              type: "changes",
              changes: [
                {
                  type: "turn",
                  key,
                  details: {
                    ...details,
                    status: "completed",
                    lifecycleStatusByItemId: { answer: "completed" },
                  },
                  hasSubagentActivity: false,
                },
              ],
            });
          view.rerender(wrap(false));
          await Promise.resolve();
        });
        await view.findByText(/\[unseen/);
        expect(view.container.querySelector("strong")).toBe(strong);
        const found = source.findMatches("unseen");
        expect(found).toHaveLength(1);
        await act(async () => {
          applyLocalConversationSearchHighlights({
            root: view.container,
            query: "unseen",
            target: { turnKey: found[0]!.turnKey, unitKey: found[0]!.key, occurrenceIndex: 0 },
          });
          await Promise.resolve();
        });
        expect(view.container.querySelector("mark.codex-thread-find-active")?.textContent).toBe(
          "unseen",
        );
        if (voice) expect(fixture.owner.readRealtimeItem("voice")?.item).toEqual(voice.item);
        else expect(fixture.owner.readItem(key.entityKey, "answer")).toEqual(item);
      } finally {
        view.unmount();
        retain();
      }
    },
  );

  test("retains a focused interactive document through growing keyed text and completion", async () => {
    const initial = '::codex-inline-vis{file="counter.html"}\n\nWorking';
    const fixture = timelineOwnerFixture(
      { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
      [agent(initial)],
    );
    const retain = fixture.owner.subscribeStructure(() => {});
    const details = fixture.owner.readTurnDetails(key.entityKey)!;
    fixture.owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key,
          details: { ...details, status: "inProgress" },
          hasSubagentActivity: false,
        },
      ],
    });
    const block = assistantBlock(initial, "answer-unit");
    const renderLeaf = (isStreamingTurn: boolean) => (
      <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
        <CodexTranscriptTurnEntityContext.Provider value={key.entityKey}>
          <ThreadAssistantBodyBlock block={block} isLatestTurn isStreamingTurn={isStreamingTurn} />
        </CodexTranscriptTurnEntityContext.Provider>
      </CodexTranscriptReadOwnerContext.Provider>
    );
    const view = render(renderLeaf(true), { wrapper: LocalConversationTestQueryProvider });
    try {
      const original = await view.findByRole("button", { name: "Document counter" });
      await act(async () => {
        original.focus();
        fireEvent.click(original);
        await Promise.resolve();
      });
      await waitFor(() => expect(original.textContent).toBe("1"));
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key: { ...key, itemId: "answer" },
              value: agent(initial + tail),
            },
          ],
        });
      });
      await view.findByRole("link", { name: query });
      expect(view.getByRole("button", { name: "Document counter" })).toBe(original);
      expect(original.textContent).toBe("1");
      expect(document.activeElement).toBe(original);
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [{ type: "turn", key, details, hasSubagentActivity: false }],
        });
      });
      view.rerender(renderLeaf(false));
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Document counter" })).toBe(original),
      );
      expect(original.textContent).toBe("1");
      expect(document.activeElement).toBe(original);
    } finally {
      view.unmount();
      retain();
    }
  });
});
