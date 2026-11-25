import { act } from "@testing-library/react";
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
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "./local-conversation-search-source";
import { applyLocalConversationSearchHighlights } from "./local-conversation-thread-search-dom-marks";

const query = "Tailneedle";
const tail = `\n\n## Answer result\n\n[${query}](https://example.com/result)`;
const pressures = [
  { name: "UTF-8 bytes", body: "语".repeat(90_000) },
  { name: "line count", body: "row\n".repeat(5_001) },
] as const;
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

function assertTailFind(
  root: HTMLElement,
  source: ReturnType<typeof searchSource>,
  needle = query,
) {
  const units = source.findMatches(needle);
  expect(units).toHaveLength(1);
  const unit = units[0]!;
  const result = projectLocalConversationResidentSearchResult({
    units,
    query: needle,
    contextId: "thread",
    limit: 250,
  });
  expect(result.totalMatches).toBe(1);
  const target = { turnKey: unit.turnKey, unitKey: unit.key, occurrenceIndex: 0 };
  expect(result.matches[0]?.meta).toEqual(target);
  const active = applyLocalConversationSearchHighlights({ root, query: needle, target });
  expect(active?.textContent).toBe(needle);
  expect(active?.closest("a")?.getAttribute("href")).toBe("https://example.com/result");
}

describe("large assistant rich content", () => {
  test.each(pressures)("keeps ordinary Markdown and tail Find beyond $name", async ({ body }) => {
    const content = body + tail;
    const fixture = timelineOwnerFixture(
      { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
      [agent(content)],
    );
    const retain = fixture.owner.subscribeStructure(() => {});
    const source = searchSource(fixture);
    const unit = source.findMatches(query)[0]!;
    const view = render(
      <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
        <CodexTranscriptTurnEntityContext.Provider value={key.entityKey}>
          <ThreadAssistantBodyBlock
            block={assistantBlock(content, unit.key)}
            isLatestTurn
            isStreamingTurn={false}
          />
        </CodexTranscriptTurnEntityContext.Provider>
      </CodexTranscriptReadOwnerContext.Provider>,
      { wrapper: LocalConversationTestQueryProvider },
    );
    try {
      await view.findByRole("heading", { name: "Answer result" });
      await view.findByRole("link", { name: query });
      assertTailFind(view.container, source);
    } finally {
      view.unmount();
      retain();
    }
  });

  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- The pressure fixture renders and marks 5,001 lines.
  test.each(["inlineMarkdown", "realtimeAssistant"] as const)(
    "keeps %s keyed content searchable beyond its former budget",
    { timeout: 90_000 },
    async (kind) => {
      const content = (kind === "inlineMarkdown" ? pressures[0].body : pressures[1].body) + tail;
      const item = agent(`::codex-realtime-inline{}\n${content}`);
      const fixture = timelineOwnerFixture(
        {
          data: [
            {
              type: "realtime",
              position: 1,
              item:
                kind === "inlineMarkdown"
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
        kind === "inlineMarkdown" ? [item] : [],
      );
      const retain = fixture.owner.subscribeStructure(() => {});
      const entry = fixture
        .project()
        .entries.find((value) =>
          kind === "inlineMarkdown"
            ? isCodexTimelineTurnEntry(value) &&
              value.timelinePresentation?.type === "inlineMarkdown"
            : isCodexRealtimeTimelineEntry(value),
        );
      if (!entry) throw new Error("Expected native presentation");
      const leaf = isCodexRealtimeTimelineEntry(entry) ? (
        <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd={null} />
      ) : isCodexTimelineTurnEntry(entry) ? (
        <LocalConversationTurnEntry
          entry={entry}
          conversationId="thread"
          cwd={null}
          canEditTurnUserPrefix={false}
          canForkTurn={false}
        />
      ) : null;
      const wholeReads = [
        vi.spyOn(fixture.owner, "readTurn"),
        vi.spyOn(fixture.owner, "readTurnSlice"),
        vi.spyOn(fixture.owner, "readItemSlots"),
      ];
      const view = render(
        <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
          {leaf}
        </CodexTranscriptReadOwnerContext.Provider>,
        { wrapper: LocalConversationTestQueryProvider },
      );
      try {
        await view.findByRole("link", { name: query });
        wholeReads.forEach((read) => expect(read).not.toHaveBeenCalled());
        assertTailFind(view.container, searchSource(fixture));
        wholeReads.forEach((read) => read.mockClear());
        const delta = "\n\n[Updatedneedle](https://example.com/result)";
        await act(async () => {
          fixture.owner.applyEvent({
            type: "changes",
            changes:
              kind === "inlineMarkdown"
                ? [
                    {
                      type: "text",
                      key: { ...key, itemId: "answer" },
                      target: { field: "text" },
                      edits: [{ at: item.text.length, deleteCount: 0, insert: delta }],
                    },
                  ]
                : [{ type: "realtime-text", itemId: "voice", delta }],
          });
        });
        await view.findByRole("link", { name: "Updatedneedle" });
        wholeReads.forEach((read) => expect(read).not.toHaveBeenCalled());
        assertTailFind(view.container, searchSource(fixture), "Updatedneedle");
      } finally {
        view.unmount();
        retain();
        wholeReads.forEach((read) => read.mockRestore());
      }
    },
  );
});
