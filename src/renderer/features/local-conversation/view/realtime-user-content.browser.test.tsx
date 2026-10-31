import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import { isCodexRealtimeTimelineEntry } from "../projection/normalized-timeline-entries";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";
import { createLocalConversationSearchSource } from "./local-conversation-search-source";
import { revealContentSearchUnit } from "../../content-search/content-search-reveal-owner";
import { waitForLocalConversationSearchLayout } from "./local-conversation-search-scroll";
import { applyLocalConversationSearchHighlights } from "./local-conversation-thread-search-dom-marks";
import { TestQueryProvider } from "../../../test/query";
import "../../../globals.css";

describe("native voice user disclosure geometry", () => {
  test("the native user owner reveals a folded Find tail without replacing its Markdown content", async () => {
    const text = "A spoken user line\n".repeat(60) + "\n[Tailneedle](https://example.com/result)";
    const fixture = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "transcriptSegment",
            id: "user",
            realtimeSessionId: "session",
            role: "user",
            text,
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const retain = fixture.owner.subscribeStructure(() => {});
    const entries = fixture.project().entries;
    const entry = entries.find(isCodexRealtimeTimelineEntry)!;
    const source = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => entries,
      readOwner: () => fixture.owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    const view = render(
      <div style={{ width: 420 }}>
        <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
          <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd={null} />
        </CodexTranscriptReadOwnerContext.Provider>
      </div>,
      { wrapper: TestQueryProvider },
    );
    try {
      await view.findByRole("button", { name: "Show more" });
      const tail = (await view.findByText("Tailneedle")).closest("a")!;
      const unit = view.container.querySelector<HTMLElement>("[data-content-search-unit-key]")!;
      await waitFor(() => expect(tail.hasAttribute("inert")).toBe(true));
      expect(tail.getBoundingClientRect().top).toBeGreaterThan(unit.getBoundingClientRect().bottom);
      const targetUnit = source.findMatches("Tailneedle")[0]!;
      await act(async () => {
        expect(revealContentSearchUnit(unit)).toBe(true);
        await waitForLocalConversationSearchLayout();
      });
      await view.findByRole("button", { name: "Show less" });
      expect(view.getByRole("link", { name: "Tailneedle" })).toBe(tail);
      expect(tail.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        unit.getBoundingClientRect().bottom + 1,
      );
      await act(async () => {
        const mark = applyLocalConversationSearchHighlights({
          root: view.container,
          query: "Tailneedle",
          target: { turnKey: targetUnit.turnKey, unitKey: targetUnit.key, occurrenceIndex: 0 },
        });
        expect(mark?.textContent).toBe("Tailneedle");
        expect(mark?.closest("a")).toBe(tail);
        await Promise.resolve();
      });
      expect(fixture.owner.readStructure()?.turns).toHaveLength(0);
    } finally {
      view.unmount();
      retain();
    }
  });
});
