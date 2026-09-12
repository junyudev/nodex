import { describe, expect, it } from "vite-plus/test";
import {
  mergeCodexResumedItemsPagination,
  advanceCodexReconnectedItemsPagination,
} from "./codex-history-resume";
import { mergeCodexCanonicalHistoryItems } from "./codex-history-item-merge";
import type { CodexCanonicalItem } from "./codex-conversation-state";
import type { CodexHistoryTurnItemsPagination } from "./codex-history-topology";
const item = (id: string, text = id): CodexCanonicalItem => ({
  type: "agentMessage",
  id,
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const pagination: CodexHistoryTurnItemsPagination = {
  olderCursor: "previous-older",
  hasLoadedOldest: false,
  isLoadingOlder: false,
  itemsView: "summary",
  oldestUserInput: null,
  openingUserMessageId: null,
  newestSnapshotItemId: "resident-last",
};

describe("resumed item history", () => {
  it("reuses the previous older cursor when the new snapshot overlaps its resident anchor", () => {
    const result = mergeCodexResumedItemsPagination(
      pagination,
      { ...pagination, olderCursor: "snapshot-older", newestSnapshotItemId: "new" },
      [item("resident-last"), item("new")],
    );
    expect(result.olderCursor).toBe("previous-older");
    expect(result.reconnect).toBeUndefined();
    expect(result.hasLoadedOldest).toBe(false);
  });
  it("retains a reconnect anchor across consecutive resumes and stops scanning when it is reached", () => {
    const first = mergeCodexResumedItemsPagination(
      pagination,
      { ...pagination, olderCursor: "snapshot-older", newestSnapshotItemId: "new" },
      [item("new")],
    );
    const second = mergeCodexResumedItemsPagination(
      first,
      { ...pagination, olderCursor: "second-snapshot", newestSnapshotItemId: "newest" },
      [item("newest")],
    );
    expect(second.reconnect).toEqual({
      beforeItemId: "newest",
      stopItemId: "resident-last",
      olderCursorAfterReconnect: "previous-older",
    });
    const gap = advanceCodexReconnectedItemsPagination(second, [item("gap")], "gap-cursor");
    expect(gap.reconnect?.beforeItemId).toBe("gap");
    const joined = advanceCodexReconnectedItemsPagination(
      gap,
      [item("resident-last"), item("bridge")],
      "discard-this-cursor",
    );
    expect(joined.olderCursor).toBe("previous-older");
    expect(joined.reconnect).toBeUndefined();
  });
  it("recognizes a complete resident prefix after overlap and does not mistake summary ids for coverage", () => {
    const complete = { ...pagination, olderCursor: null, hasLoadedOldest: true };
    const incoming = { ...pagination, olderCursor: "snapshot" };
    expect(
      mergeCodexResumedItemsPagination(complete, incoming, [item("resident-last")]).hasLoadedOldest,
    ).toBe(true);
    expect(
      mergeCodexResumedItemsPagination(
        complete,
        { ...incoming, summaryItemIds: ["resident-last"] },
        [item("resident-last")],
      ).reconnect,
    ).toBeDefined();
  });
  it("snapshot merges refresh assistant values without aliasing text and insert reconnect items at their snapshot boundary", () => {
    const result = mergeCodexCanonicalHistoryItems(
      [item("old", "same"), item("snapshot", "before")],
      [item("renamed", "same"), item("snapshot", "after")],
      { snapshotBeforeItemId: null },
    );
    expect(result.items.map((value) => value.id)).toEqual(["old", "renamed", "snapshot"]);
    expect(result.items.at(-1)).toEqual(item("snapshot", "after"));
    expect(result.aliases.size).toBe(0);
    expect(
      mergeCodexCanonicalHistoryItems([item("old"), item("snapshot")], [item("bridge")], {
        snapshotBeforeItemId: "snapshot",
      }).items.map((value) => value.id),
    ).toEqual(["old", "bridge", "snapshot"]);
  });
});
