import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import { isCodexRealtimeTimelineEntry } from "../projection/normalized-timeline-entries";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";

describe("native voice user content", () => {
  test.each([
    { name: "UTF-8 budget", body: "语".repeat(90_000) },
    { name: "line budget", body: "User line\n".repeat(5_001) },
  ])("keeps the full expandable Markdown occurrence beyond its former $name", async ({ body }) => {
    const overflow = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1_000);
    const text = body + "\n\n[Tailneedle](https://example.com/result)";
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
    const entry = fixture.project().entries.find(isCodexRealtimeTimelineEntry)!;
    const wholeReads = [
      vi.spyOn(fixture.owner, "readTurn"),
      vi.spyOn(fixture.owner, "readTurnSlice"),
      vi.spyOn(fixture.owner, "readItemSlots"),
    ];
    const view = render(
      <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
        <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd={null} />
      </CodexTranscriptReadOwnerContext.Provider>,
      { wrapper: LocalConversationTestQueryProvider },
    );
    try {
      const disclosure = await view.findByRole("button", { name: "Show more" });
      const tail = (await view.findByText("Tailneedle")).closest("a");
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(view.queryByRole("button", { name: "User message source" })).toBeNull();
      wholeReads.forEach((read) => expect(read).not.toHaveBeenCalled());
      await act(async () => {
        fireEvent.click(disclosure);
        await Promise.resolve();
      });
      await view.findByRole("button", { name: "Show less" });
      expect(view.getByRole("link", { name: "Tailneedle" })).toBe(tail);
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "realtime-text",
              itemId: "user",
              delta: "\n\n[Updated tail](https://example.com/updated)",
            },
          ],
        });
      });
      await view.findByRole("button", { name: "Show more" });
      await view.findByText("Updated tail");
      await waitFor(() =>
        expect(
          view.container
            .querySelector("[data-native-realtime-item-id]")
            ?.getAttribute("data-native-realtime-item-id"),
        ).toBe("user"),
      );
      wholeReads.forEach((read) => expect(read).not.toHaveBeenCalled());
      expect(fixture.owner.readStructure()?.turns).toHaveLength(0);
    } finally {
      view.unmount();
      retain();
      overflow.mockRestore();
      wholeReads.forEach((read) => read.mockRestore());
    }
  });
});
