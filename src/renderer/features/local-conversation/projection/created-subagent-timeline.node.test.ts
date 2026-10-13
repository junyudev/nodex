import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem, ThreadTimelineEntry } from "@nodex/codex-app-server-protocol/v2";
import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";
import { isCodexTimelineTurnEntry } from "./normalized-timeline-entries";
import { createSubagentActivityReadQuery } from "./subagent-activity-read-query";

const created = (id: string, namespace: string | null = "codex_app"): ThreadItem => ({
  type: "dynamicToolCall",
  id,
  namespace,
  tool: "create_thread",
  arguments: {},
  status: "completed",
  contentItems: [{ type: "inputText", text: '{"threadId":"child","hostId":"remote"}' }],
  success: true,
  durationMs: 1,
});
const activity = (
  id: string,
  kind: "started" | "completed" | "interrupted" = "started",
  child = "child",
): Extract<ThreadItem, { type: "subAgentActivity" }> => ({
  type: "subAgentActivity",
  id,
  kind,
  agentThreadId: child,
  agentPath: `root/${child === "child" ? "reviewer" : "writer"}`,
});
const receipt = (
  itemId: string,
  position: number,
  id = `presentation:${itemId}`,
): ThreadTimelineEntry => ({
  type: "realtime",
  position,
  item: {
    type: "bemItemPromoted",
    id,
    realtimeSessionId: "session",
    turnId: "one",
    itemId,
    presentation: { type: "wholeItem" },
  },
});
const nativeRow = (item: ThreadItem, position: number): ThreadTimelineEntry => ({
  type: "item",
  turnId: "one",
  position,
  item,
});
describe("native created/subagent presentation identity", () => {
  test("keeps the first creation receipt for each raw item, independently of an equal target", () => {
    const first = created("first"),
      second = created("second"),
      legacy = created("legacy", null);
    const { project } = timelineOwnerFixture(
      {
        data: [
          nativeRow(first, 0),
          receipt("first", 1, "first-receipt"),
          receipt("first", 2, "repeat-receipt"),
          nativeRow(second, 3),
          receipt("second", 4),
          nativeRow(legacy, 5),
          receipt("legacy", 6),
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [first, second, legacy],
    );
    const rows = project().entries.filter(isCodexTimelineTurnEntry);
    const cards = rows.filter((row) => row.timelineWholeItem?.type === "createdThreads");
    expect(cards.map((row) => [row.turnKey, row.timelineSlice.itemIds])).toEqual([
      ["timeline:presentation:first-receipt", ["first"]],
      ["timeline:presentation:presentation:second", ["second"]],
    ]);
    expect(
      cards.map((row) =>
        row.timelineWholeItem?.type === "createdThreads" ? row.timelineWholeItem.resultCount : null,
      ),
    ).toEqual([2, 1]);
    expect(
      rows.filter((row) => !row.timelineWholeItem).flatMap((row) => row.timelineSlice.itemIds),
    ).toEqual(["legacy"]);
  });
  test("one started receipt consumes all lifecycle identities for its child and leaves another child independent", () => {
    const started = activity("start"),
      done = activity("done", "completed"),
      other = activity("other", "started", "other");
    const { project } = timelineOwnerFixture(
      {
        data: [nativeRow(started, 0), receipt("start", 1), nativeRow(other, 2), nativeRow(done, 3)],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [started, other, done],
    );
    const rows = project().entries.filter(isCodexTimelineTurnEntry);
    expect(
      rows
        .filter((row) => row.timelineWholeItem?.type === "subagentActivity")
        .map((row) => row.timelineSlice.itemIds),
    ).toEqual([["start", "done"]]);
    const work = rows.find((row) => !row.timelineWholeItem);
    expect(work?.timelineSlice.itemIds).toEqual(["other"]);
    expect(work?.timelineDedicatedSubagentThreadIds).toEqual(["child"]);
  });
  test("a keyed group is stable across unrelated text and updates/releases only its real native addresses", () => {
    const started = activity("start"),
      done = activity("done", "completed");
    const text: ThreadItem = {
      type: "agentMessage",
      id: "text",
      text: "unchanged",
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const { owner } = timelineOwnerFixture(
      {
        data: [nativeRow(started, 0), receipt("start", 1), nativeRow(done, 2), nativeRow(text, 3)],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [started, done, text],
    );
    const retain = owner.subscribeStructure(() => {});
    const query = createSubagentActivityReadQuery(owner, "turn:one", ["start", "done"]);
    const initial = query.read();
    const listener = vi.fn();
    const release = query.subscribe(listener);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "item",
          key: { hostId: "local", threadId: "thread", entityKey: "turn:one", itemId: "text" },
          value: { ...text, text: "changed" },
        },
      ],
    });
    expect(listener).not.toHaveBeenCalled();
    expect(query.read()).toBe(initial);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "item",
          key: { hostId: "local", threadId: "thread", entityKey: "turn:one", itemId: "done" },
          value: activity("done", "interrupted"),
        },
      ],
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(query.read().at(-1)?.displayStatus).toBe("interrupted");
    release();
    retain();
    expect(query.read()).toEqual([]);
  });
  test("10,000 ordinary items plus a dedicated child stay linear and never materialize a whole Turn", () => {
    const items: ThreadItem[] = Array.from({ length: 10_000 }, (_, index) => ({
      type: "agentMessage",
      id: `text:${index}`,
      text: "text",
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    }));
    items.push(activity("start"), activity("done", "completed"));
    const { owner, project } = timelineOwnerFixture(
      {
        data: [...items.map(nativeRow), receipt("start", items.length)],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      items,
    );
    const readTurn = vi.spyOn(owner, "readTurn"),
      readSlice = vi.spyOn(owner, "readTurnSlice"),
      readItem = vi.spyOn(owner, "readItem");
    const rows = project().entries.filter(isCodexTimelineTurnEntry);
    expect(
      rows.find((row) => row.timelineWholeItem?.type === "subagentActivity")?.timelineSlice.itemIds,
    ).toEqual(["start", "done"]);
    expect(readItem.mock.calls.length).toBeLessThanOrEqual(items.length * 2 + 10);
    expect(readTurn).not.toHaveBeenCalled();
    expect(readSlice).not.toHaveBeenCalled();
  });
});
