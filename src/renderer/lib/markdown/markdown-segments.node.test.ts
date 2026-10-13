import { describe, expect, test } from "vite-plus/test";
import {
  createMarkdownSegmentOwner,
  createMarkdownSegmentTimeline,
  createMarkdownTextSegmentCache,
  type MarkdownSegmenter,
} from "./markdown-segments";

describe("committed Markdown segments", () => {
  test("preserves exact ASCII punctuation and CJK/emoji text with segmenter identity and admission budgets", () => {
    const cache = createMarkdownTextSegmentCache();
    let calls = 0;
    const segmenter: MarkdownSegmenter = {
      segment(text) {
        calls += 1;
        return [{ segment: text, isWordLike: true }];
      },
    };
    const first = cache.read(" Hello, world! abc_def-123", true, segmenter);
    expect(first).toEqual([" ", "Hello, ", "world! ", "abc_", "def-", "123"]);
    const cjk = new Intl.Segmenter("zh", { granularity: "word" });
    const text = "你好，世界 👋🏽！";
    expect(cache.read(text, true, cjk).join("")).toBe(text);
    const cached = cache.read("中".repeat(4096), true, segmenter);
    expect(cache.read("中".repeat(4096), true, segmenter)).toBe(cached);
    expect(calls).toBe(1);
    const long = "中".repeat(4097);
    expect(cache.read(long, true, segmenter).join("")).toBe(long);
    cache.read(long, true, segmenter);
    expect(calls).toBe(3);
    expect(cache.read("中".repeat(4096), false, segmenter)).not.toBe(cached);
    expect(cache.read("中".repeat(4096), true, { segment: segmenter.segment })).not.toBe(cached);
  });
  test("text cache hits do not refresh its 500-entry insertion order", () => {
    const cache = createMarkdownTextSegmentCache();
    const first = cache.read("text0", true, null);
    for (let index = 1; index < 500; index += 1) cache.read(`text${index}`, true, null);
    expect(cache.read("text0", true, null)).toBe(first);
    cache.read("text500", true, null);
    expect(cache.read("text0", true, null)).not.toBe(first);
  });
  test("discarded concurrent candidates never consume IDs and repeated/reordered words remain unique", () => {
    const owner = createMarkdownSegmentOwner();
    const initial = owner.prepare(["one ", "two ", "one "]);
    owner.commit(initial);
    const discarded = owner.prepare(["discard ", "entirely "]);
    expect(discarded.segments[0]?.key).toBe("fade-segment-3");
    const actual = owner.prepare(["two ", "one ", "one ", "new"]);
    expect(actual.segments.map((value) => value.key)).toEqual([
      "fade-segment-1",
      "fade-segment-0",
      "fade-segment-2",
      "fade-segment-3",
    ]);
    owner.commit(actual);
    const extended = owner.prepare(["two more ", "one ", "one ", "new"]);
    expect(extended.segments.map((value) => value.key)).toEqual(
      actual.segments.map((value) => value.key),
    );
    expect(new Set(extended.segments.map((value) => value.key)).size).toBe(4);
  });
  test("timing persists by key, settlement admits only current own targets, and disposal fences late events", () => {
    let time = 100;
    const timeline = createMarkdownSegmentTimeline(() => time);
    timeline.commit(["a", "b"], true);
    expect(timeline.attach({}, "a", 10)).toBe(0);
    expect(timeline.attach({}, "b", 10)).toBe(10);
    time = 200;
    expect(timeline.attach({}, "b", 10)).toBe(-90);
    timeline.settle("a", false);
    expect(timeline.isSettled("a")).toBe(false);
    timeline.settle("a", true);
    expect(timeline.isSettled("a")).toBe(true);
    timeline.commit(["b"], true);
    timeline.settle("retired", true);
    expect(timeline.isSettled("retired")).toBe(false);
    timeline.commit(["b"], false);
    expect(timeline.isSettled("b")).toBe(true);
    timeline.dispose();
    expect(timeline.attach({}, "b", 10)).toBeNull();
    timeline.settle("late", true);
    expect(timeline.isSettled("late")).toBe(false);
  });
});
