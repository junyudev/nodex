import { describe, expect, test } from "vite-plus/test";
import {
  createMarkdownSegmentOwner,
  createMarkdownSegmentTimeline,
  createMarkdownTextSegmentCache,
  type MarkdownSegmenter,
} from "./markdown-segments";

describe("committed Markdown segments", () => {
  test("preserves exact ASCII punctuation and CJK/emoji text with segmenter identity and admission budgets", () => {
    let calls = 0;
    const segmenter: MarkdownSegmenter = {
      segment(text) {
        calls += 1;
        return [{ segment: text, isWordLike: true }];
      },
    };
    const cache = createMarkdownTextSegmentCache(segmenter).prepare();
    const first = cache.read(" Hello, world! abc_def-123", true);
    expect(first).toEqual([" ", "Hello, ", "world! ", "abc_", "def-", "123"]);
    const cjk = new Intl.Segmenter("zh", { granularity: "word" });
    const text = "你好，世界 👋🏽！";
    expect(createMarkdownTextSegmentCache(cjk).prepare().read(text, true).join("")).toBe(text);
    const cached = cache.read("中".repeat(4096), true);
    expect(cache.read("中".repeat(4096), true)).toBe(cached);
    expect(calls).toBe(1);
    const long = "中".repeat(4097);
    expect(cache.read(long, true).join("")).toBe(long);
    cache.read(long, true);
    expect(calls).toBe(3);
    expect(cache.read("中".repeat(4096), false)).not.toBe(cached);
    expect(
      createMarkdownTextSegmentCache({ segment: segmenter.segment })
        .prepare()
        .read("中".repeat(4096), true),
    ).not.toBe(cached);
  });
  test("text cache hits do not refresh its 500-entry insertion order", () => {
    const cache = createMarkdownTextSegmentCache(null).prepare();
    const first = cache.read("text0", true);
    for (let index = 1; index < 500; index += 1) cache.read(`text${index}`, true);
    expect(cache.read("text0", true)).toBe(first);
    cache.read("text500", true);
    expect(cache.read("text0", true)).not.toBe(first);
  });
  test("keeps only committed text parts read this round, scoped to the mounted document", () => {
    const segment = (text: string) => [{ segment: text, isWordLike: true }];
    const cache = createMarkdownTextSegmentCache({ segment });
    const first = cache.prepare();
    const steady = first.read("固定", true);
    const stale = first.read("旧文本", true);
    first.commit();

    const discarded = cache.prepare();
    const abandoned = discarded.read("未提交", true);
    const actual = cache.prepare();
    expect(actual.read("固定", true)).toBe(steady);
    expect(actual.read("未提交", true)).not.toBe(abandoned);
    actual.commit();
    const next = cache.prepare();
    expect(next.read("固定", true)).toBe(steady);
    expect(next.read("旧文本", true)).not.toBe(stale);
    expect(createMarkdownTextSegmentCache({ segment }).prepare().read("固定", true)).not.toBe(
      steady,
    );
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
  test("does not index an append or tail extension, and protects unchanged repeated text", () => {
    const owner = createMarkdownSegmentOwner();
    const initial = owner.prepare(["same ", "same ", "tail"]);
    owner.commit(initial);
    const keys = (candidate: typeof initial) => candidate.segments.map((segment) => segment.key);
    const extended = owner.prepare(["same ", "same ", "tail revised"]);
    expect(keys(extended)).toEqual(keys(initial));
    owner.commit(extended);
    const appended = owner.prepare(["same ", "same ", "tail revised", "new"]);
    expect(keys(appended).slice(0, 3)).toEqual(keys(initial));
    expect(owner.getMeasurements().contentIndexesBuilt).toBe(0);
    const inserted = owner.prepare(["same extended ", "same ", "same ", "tail revised"]);
    expect(keys(inserted).slice(1)).toEqual(keys(initial));
    expect(keys(inserted)[0]).toBe(keys(appended)[3]);
    expect(owner.getMeasurements().contentIndexesBuilt).toBe(1);
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
