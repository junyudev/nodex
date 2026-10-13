import { describe, expect, test } from "vite-plus/test";
import { ordinarySparseHistoryFixture } from "./ordinary-history-position.test-fixtures";
import { isCodexRealtimeTimelineEntry } from "./normalized-timeline-entries";
import {
  isNormalizedConversationTurnEntry,
  materializeConversationTurnListEntry,
} from "../selectors";
import { selectTurnRenderModel } from "./build-turn-render-model";
import { createLocalConversationSearchSource } from "../view/local-conversation-search-source";

describe("ordinary sparse history position", () => {
  test("joins true canonical occurrences while keeping native search and item addresses", async () => {
    const fixture = ordinarySparseHistoryFixture();
    try {
      const projected = fixture.project();
      expect(projected.entries.find((entry) => entry.turnId === "40")).toMatchObject({
        historyPositionKey: "history-content:search:window:4",
        historyEntityKey: "turn:40",
        turnKey: "history-content:search:window:4",
        turnSearchKey: "40",
      });
      const rows = projected.historyRows!;
      const keys = new Set(projected.entries.map((entry) => entry.turnKey));
      expect(
        rows.filter((row) => row.kind === "content").every((row) => keys.has(row.turnKey)),
      ).toBe(true);
      const search = createLocalConversationSearchSource({
        routeContextId: "thread",
        getTurns: () => [],
        getProjectedEntries: () => fixture.project().entries,
        readOwner: () => fixture.owner,
        scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
      });
      expect(search.findMatches("History target 40")).toMatchObject([
        { key: "40:user:0", itemId: "user-40", turnKey: "history-content:search:window:4" },
      ]);
      const middle = rows.find(
        (row) => row.kind === "gap" && row.olderBoundary?.islandId === "search:window",
      );
      if (!middle || middle.kind !== "gap" || !middle.olderBoundary)
        throw new Error("Missing newer search edge");
      expect(middle.olderBoundary.edge).toBe("newer");
      expect(await fixture.loadBoundary(middle.olderBoundary)).toBe("applied");
      expect(fixture.calls.filter((call) => call.method === "thread/turns/list")).toEqual([
        {
          method: "thread/turns/list",
          params: {
            threadId: "ordinary-history",
            cursor: "after:44",
            limit: 5,
            itemsView: "notLoaded",
            sortDirection: "asc",
          },
        },
      ]);
      expect(fixture.project().entries.find((entry) => entry.turnId === "45")).toMatchObject({
        historyEntityKey: "turn:45",
        turnKey: "history-content:turn:45",
        turnSearchKey: "45",
      });
      expect(search.findMatches("History target 45")).toMatchObject([
        { key: "45:user:0", itemId: "user-45", turnKey: "history-content:turn:45" },
      ]);
    } finally {
      fixture.dispose();
    }
  });

  test("a position-only receipt preserves raw leaf and search identity but updates placement", () => {
    const fixture = ordinarySparseHistoryFixture();
    try {
      const before = fixture.project().entries.find((entry) => entry.turnId === "40")!;
      const item = fixture.owner.readItem("turn:40", "user-40");
      let leafUpdates = 0;
      const unsubscribe = fixture.owner.subscribeItem("turn:40", "user-40", () => leafUpdates++);
      fixture.update((draft) => {
        const entry = draft.turnHistory!.history.islands[0]!.entries[4]!;
        entry.key = "new-position";
      });
      const after = fixture.project().entries.find((entry) => entry.turnId === "40")!;
      if (isCodexRealtimeTimelineEntry(after)) throw new Error("Unexpected realtime occurrence");
      expect(after).not.toBe(before);
      expect(after.turnKey).toBe("history-content:new-position");
      expect(after.turnSearchKey).toBe(before.turnSearchKey);
      expect(fixture.owner.readItem("turn:40", "user-40")).toBe(item);
      expect(leafUpdates).toBe(0);
      const materialized = materializeConversationTurnListEntry(after);
      if (!materialized || !isNormalizedConversationTurnEntry(after))
        throw new Error("Missing occurrence");
      const model = selectTurnRenderModel({ entry: materialized });
      expect(model.searchUnits.find((unit) => unit.itemId === "user-40")).toMatchObject({
        key: "40:user:0",
        turnKey: after.turnKey,
      });
      unsubscribe();
    } finally {
      fixture.dispose();
    }
  });
});
