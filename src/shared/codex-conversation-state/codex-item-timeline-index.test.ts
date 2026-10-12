import { describe, expect, test } from "vite-plus/test";
import { enablePatches, produceWithPatches } from "immer";
import { CodexItemTimelineIndex } from "./codex-item-timeline-index";
import type {
  CodexCanonicalItemTimeline,
  CodexCanonicalTimelineEntry,
} from "./codex-conversation-state";

enablePatches();
const entry = (id: string, position: number): CodexCanonicalTimelineEntry => ({
  type: "realtime",
  position,
  item: {
    type: "transcriptSegment",
    id,
    realtimeSessionId: "session",
    role: "assistant",
    text: id,
  },
});
const fixture = (size = 3): CodexCanonicalItemTimeline => ({
  activeRealtimeSessionAtPageStart: null,
  entries: Array.from({ length: size }, (_, index) => entry(String(index), index)),
});

describe("resident timeline identity index", () => {
  test("retains indexed positions across sparse append and completion mutations", () => {
    const index = new CodexItemTimelineIndex();
    const before = { itemTimeline: fixture() };
    expect(index.position(before.itemTimeline, "realtime:1")).toBe(1);
    const [appended, patches] = produceWithPatches(before, (draft) => {
      draft.itemTimeline.entries.push(entry("new", 3));
    });
    index.update(before.itemTimeline, appended.itemTimeline, patches);
    expect(index.position(appended.itemTimeline, "realtime:new")).toBe(3);
    const [completed, completedPatches] = produceWithPatches(appended, (draft) => {
      const item = draft.itemTimeline.entries[1]!;
      if (item.type === "realtime" && item.item.type === "transcriptSegment")
        item.item.text = "final";
    });
    index.update(appended.itemTimeline, completed.itemTimeline, completedPatches);
    expect(index.position(completed.itemTimeline, "realtime:1")).toBe(1);
    expect(index.position(completed.itemTimeline, "realtime:new")).toBe(3);
  });

  test("history prepend, removal and whole replacement rebuild with their authoritative positions", () => {
    const index = new CodexItemTimelineIndex();
    const before = { itemTimeline: fixture() };
    expect(index.position(before.itemTimeline, "realtime:1")).toBe(1);
    const [prepended, patches] = produceWithPatches(before, (draft) => {
      draft.itemTimeline.entries = [entry("older", 0), ...draft.itemTimeline.entries];
    });
    index.update(before.itemTimeline, prepended.itemTimeline, patches);
    expect(index.position(prepended.itemTimeline, "realtime:1")).toBe(2);
    const [removed, removedPatches] = produceWithPatches(prepended, (draft) => {
      draft.itemTimeline.entries.pop();
    });
    index.update(prepended.itemTimeline, removed.itemTimeline, removedPatches);
    expect(index.position(removed.itemTimeline, "realtime:2")).toBeUndefined();
    const replaced = fixture(1);
    index.update(removed.itemTimeline, replaced);
    expect(index.position(replaced, "realtime:1")).toBeUndefined();
    expect(index.position(undefined, "realtime:1")).toBeUndefined();
  });

  test("a sparse live append does not rescan a 10,000-entry resident timeline", () => {
    const index = new CodexItemTimelineIndex();
    let reads = 0;
    const before = fixture(10_000);
    for (const entry of before.entries) {
      const item = entry.type === "realtime" ? entry.item : undefined;
      if (!item) throw new Error("Invalid pressure fixture");
      Object.defineProperty(entry, "item", {
        get: () => {
          reads++;
          return item;
        },
        enumerable: true,
      });
    }
    expect(index.position(before, "realtime:9999")).toBe(9999);
    reads = 0;
    const appended = { ...before, entries: [...before.entries, entry("new", 10_000)] };
    index.update(before, appended, [
      { op: "add", path: ["itemTimeline", "entries", 10_000], value: appended.entries.at(-1) },
    ]);
    expect(index.position(appended, "realtime:9999")).toBe(9999);
    expect(index.position(appended, "realtime:new")).toBe(10_000);
    expect(reads).toBe(0);
  });
});
