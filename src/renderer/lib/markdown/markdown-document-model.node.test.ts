import { describe, expect, test } from "vite-plus/test";
import {
  createAdaptiveMarkdownBuffer,
  type AdaptiveMarkdownScheduler,
} from "./adaptive-markdown-buffer";
import { defaultRemarkPlugins, defaultRehypePlugins } from "streamdown";
import type { Element, RootContent, Root, Nodes as HtmlNodes, Root as HtmlRoot } from "hast";
import { createMarkdownDocumentOwner, MARKDOWN_FADE_TAG } from "./markdown-document";
import {
  createMarkdownSyntaxEngine,
  type MarkdownSyntaxPolicy,
  createMarkdownPrefixCache,
  type ImmutableMarkdown,
} from "./markdown-syntax";
import { createMarkdownElementKeyOwner } from "./markdown-element-keys";
import {
  createMarkdownSegmentOwner,
  createMarkdownSegmentTimeline,
  createMarkdownTextSegmentCache,
  type MarkdownSegmenter,
} from "./markdown-segments";
import { createMathPlugin } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import { findMarkdownOpenCodeFence, findMarkdownStablePrefix } from "./markdown-prefix";

describe("adaptive markdown buffer", () => {
  function clockFixture() {
    let nowMs = 0;
    let nextId = 0;
    const timeouts = new Map<number, { due: number; callback: () => void }>();
    const frames = new Map<number, () => void>();
    const callbacks: Array<() => void> = [];
    const scheduler: AdaptiveMarkdownScheduler = {
      nowSeconds: () => nowMs / 1_000,
      timeout(callback, delayMs) {
        const id = nextId++;
        timeouts.set(id, { due: nowMs + delayMs, callback });
        callbacks.push(callback);
        return () => {
          timeouts.delete(id);
        };
      },
      frame(callback) {
        const id = nextId++;
        frames.set(id, callback);
        callbacks.push(callback);
        return () => {
          frames.delete(id);
        };
      },
    };
    return {
      scheduler,
      callbacks,
      pending: () => ({ timeouts: timeouts.size, frames: frames.size }),
      advance(ms: number) {
        const end = nowMs + ms;
        for (;;) {
          const next = [...timeouts.entries()].sort((a, b) => a[1].due - b[1].due)[0];
          if (!next || next[1].due > end) break;
          nowMs = next[1].due;
          timeouts.delete(next[0]);
          next[1].callback();
        }
        nowMs = end;
      },
      publishFrame() {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback();
      },
    };
  }

  describe("adaptive Markdown presentation", () => {
    test("history is immediately complete and repeated reads retain the immutable snapshot", () => {
      const clock = clockFixture();
      const owner = createAdaptiveMarkdownBuffer(
        { source: "History", streamId: "a", active: false },
        clock.scheduler,
      );
      const snapshot = owner.getSnapshot();
      owner.update({ source: "History", streamId: "a", active: false });
      expect(owner.getSnapshot()).toBe(snapshot);
      expect(snapshot).toEqual({
        source: "History",
        streamId: "a",
        text: "History",
        isComplete: true,
      });
      expect(clock.pending()).toEqual({ timeouts: 0, frames: 0 });
    });

    test("append retains the displayed prefix and coalesces publication into one frame", () => {
      const clock = clockFixture();
      const owner = createAdaptiveMarkdownBuffer(
        { source: "Prefix", streamId: "a", active: true },
        clock.scheduler,
      );
      let notifications = 0;
      owner.subscribe(() => {
        notifications++;
      });
      const source = "Prefix" + "a".repeat(100);
      owner.update({ source, streamId: "a", active: true });
      expect(owner.getSnapshot().text).toBe("Prefix");
      clock.advance(50);
      clock.advance(50);
      expect(clock.pending()).toEqual({ timeouts: 1, frames: 1 });
      expect(notifications).toBe(0);
      clock.publishFrame();
      expect(notifications).toBe(1);
      expect(owner.getSnapshot().text.startsWith("Prefix")).toBe(true);
      expect(owner.getSnapshot().text.length).toBeGreaterThan(6);
      expect(owner.getSnapshot().text.length).toBeLessThan(source.length);
      expect(source.startsWith(owner.getSnapshot().text)).toBe(true);
      expect(owner.getSnapshot().isComplete).toBe(false);
      clock.advance(10_000);
      clock.publishFrame();
      expect(owner.getSnapshot().text).toBe(source);
      expect(owner.getSnapshot().isComplete).toBe(false);
      expect(clock.pending()).toEqual({ timeouts: 0, frames: 0 });
    });

    test("arrival floor is measured in seconds and preserves fractional progress", () => {
      const measure = (floor: number) => {
        const clock = clockFixture();
        const owner = createAdaptiveMarkdownBuffer(
          { source: "", streamId: "a", active: true },
          clock.scheduler,
        );
        owner.update({
          source: "a".repeat(100),
          streamId: "a",
          active: true,
          arrivalIntervalFloorSeconds: floor,
        });
        clock.advance(50);
        owner.update({
          source: "a".repeat(200),
          streamId: "a",
          active: true,
          arrivalIntervalFloorSeconds: floor,
        });
        clock.advance(50);
        clock.publishFrame();
        return owner.getSnapshot().text.length;
      };
      expect(measure(0.01)).toBeGreaterThan(measure(10));
      const clock = clockFixture();
      const owner = createAdaptiveMarkdownBuffer(
        { source: "", streamId: "a", active: true },
        clock.scheduler,
      );
      owner.update({ source: "x", streamId: "a", active: true });
      clock.advance(50);
      clock.publishFrame();
      expect(owner.getSnapshot().text).toBe("");
      clock.advance(1_000);
      clock.publishFrame();
      expect(owner.getSnapshot().text).toBe("x");
    });

    test.each([
      { source: "replacement", streamId: "a", active: true },
      { source: "Prefix-new-stream", streamId: "b", active: true },
      { source: "Prefix-finished", streamId: "a", active: false },
    ])("identity, replacement or completion flush immediately: $source", (next) => {
      const clock = clockFixture();
      const owner = createAdaptiveMarkdownBuffer(
        { source: "Prefix", streamId: "a", active: true },
        clock.scheduler,
      );
      owner.update({ source: "Prefix" + "a".repeat(100), streamId: "a", active: true });
      clock.advance(50);
      const stale = [...clock.callbacks];
      owner.update(next);
      const snapshot = owner.getSnapshot();
      expect(snapshot.text).toBe(next.source);
      expect(snapshot.streamId).toBe(next.streamId);
      expect(snapshot.isComplete).toBe(!next.active);
      expect(clock.pending()).toEqual({ timeouts: 0, frames: 0 });
      for (const callback of stale) callback();
      expect(owner.getSnapshot()).toBe(snapshot);
    });

    test("idle-to-active starts from full source, and cancellation can survive layout replay", () => {
      const clock = clockFixture();
      const owner = createAdaptiveMarkdownBuffer(
        { source: "Old", streamId: "a", active: false },
        clock.scheduler,
      );
      owner.update({ source: "Old resumed", streamId: "a", active: true });
      expect(owner.getSnapshot().text).toBe("Old resumed");
      owner.update({ source: "Old resumed" + "x".repeat(100), streamId: "a", active: true });
      const stale = [...clock.callbacks];
      owner.cancel();
      const snapshot = owner.getSnapshot();
      for (const callback of stale) callback();
      expect(owner.getSnapshot()).toBe(snapshot);
      owner.update({ source: "Old resumed" + "x".repeat(100), streamId: "a", active: true });
      clock.advance(50);
      clock.publishFrame();
      expect(owner.getSnapshot().text.length).toBeGreaterThan("Old resumed".length);
    });
  });
});

describe("markdown document", () => {
  const policy: MarkdownSyntaxPolicy = {
    family: false,
    normalizeLists: true,
    repairIncomplete: true,
    blockLocal: true,
    remarkPlugins: Object.values(defaultRemarkPlugins),
    rehypePlugins: Object.values(defaultRehypePlugins),
  };
  function collect(node: RootContent, tag: string): Element[] {
    if (node.type !== "element") return [];
    return [
      ...(node.tagName === tag ? [node] : []),
      ...node.children.flatMap((child) => collect(child, tag)),
    ];
  }

  describe("typed mounted Markdown document", () => {
    test("prefix/terminal keep one segment key domain while prepared renders leave committed state unchanged", () => {
      const owner = createMarkdownDocumentOwner(null, createMarkdownSyntaxEngine());
      const input = {
        source: "Stable paragraph\n\ntail",
        sourceIdentity: "native-a",
        streaming: true,
        animate: true,
        policy,
      };
      const first = owner.prepare(input);
      owner.commit(first);
      const growth = owner.prepare({ ...input, source: `${input.source}\n\nnext` });
      const firstWord = first.html.children.flatMap((node) => collect(node, MARKDOWN_FADE_TAG))[0]!;
      const growthWord = growth.html.children.flatMap((node) =>
        collect(node, MARKDOWN_FADE_TAG),
      )[0]!;
      expect(growthWord).toBe(firstWord);
      expect(growth.keys.get(growthWord)).toBe(first.keys.get(firstWord));
      const discarded = owner.prepare({ ...input, source: "entirely different" });
      expect(discarded.segments!.nextId).toBeGreaterThan(first.segments!.nextId);
      owner.commit(growth);
      const terminal = owner.prepare({
        ...input,
        source: `${input.source}\n\nnext`,
        streaming: false,
        animate: false,
        policy: { ...policy, repairIncomplete: false },
      });
      expect(terminal.segments).toBeNull();
      expect(
        terminal.html.children.flatMap((node) => collect(node, MARKDOWN_FADE_TAG)),
      ).toHaveLength(0);
      owner.commit(terminal);
      expect(
        growth.segments!.segments.every((value) => owner.getTimeline().isSettled(value.key)),
      ).toBe(true);
    });
    test("new native source identity gets independent segment IDs and excludes code/math from prose segmentation", () => {
      const owner = createMarkdownDocumentOwner(null, createMarkdownSyntaxEngine());
      const base = {
        sourceIdentity: "a",
        source: "words\n\n```text\nnot animated\n```",
        streaming: false,
        animate: false,
        policy,
      };
      const first = owner.prepare(base);
      owner.commit(first);
      expect(first.segments).toBeNull();
      expect(first.html.children.flatMap((node) => collect(node, "code"))[0]?.children).toEqual([
        { type: "text", value: "not animated\n" },
      ]);
      const second = owner.prepare({
        ...base,
        sourceIdentity: "b",
        source: "new words",
        animate: true,
      });
      expect(second.segments!.segments[0]?.key).toBe("fade-segment-0");
    });
    test("a retired native document cannot settle a replacement with the same segment key", () => {
      const owner = createMarkdownDocumentOwner(null, createMarkdownSyntaxEngine());
      const base = {
        sourceIdentity: "first",
        source: "same text",
        streaming: true,
        animate: true,
        policy,
      };
      const first = owner.prepare(base);
      owner.commit(first);
      const retired = owner.getTimeline();
      const second = owner.prepare({ ...base, sourceIdentity: "replacement" });
      owner.commit(second);
      expect(second.segments!.segments[0]?.key).toBe(first.segments!.segments[0]?.key);
      retired.settle(second.segments!.segments[0]!.key, true);
      expect(owner.getTimeline().isSettled(second.segments!.segments[0]!.key)).toBe(false);
      expect(retired.attach({}, "fade-segment-0", 0)).toBeNull();
    });
  });
});

describe("markdown element keys", () => {
  const paragraph = (): Element => ({
    type: "element",
    tagName: "p",
    properties: {},
    children: [
      { type: "text", value: "Before " },
      {
        type: "element",
        tagName: "img",
        properties: { src: "https://example.com/image.png", alt: "Retained" },
        children: [],
      },
    ],
  });
  const heading = (value: string): Element => ({
    type: "element",
    tagName: "h1",
    properties: {},
    children: [{ type: "text", value }],
  });
  const root = (...children: Element[]): Root => ({ type: "root", children });

  test("semantic sibling keys survive preceding insertions without consuming IDs for discarded renders", () => {
    const owner = createMarkdownElementKeyOwner();
    const original = paragraph();
    const first = owner.prepare(root(original), new WeakMap());
    owner.commit(first);
    const discarded = heading("Discarded");
    const pending = owner.prepare(root(discarded, paragraph()), new WeakMap());
    const actual = heading("Actual");
    const retained = paragraph();
    const next = owner.prepare(root(actual, retained), new WeakMap());
    expect(next.keys.get(actual)).toBe(pending.keys.get(discarded));
    expect(next.keys.get(retained)).toBe(first.keys.get(original));
    expect(next.keys.get(retained.children[1]!)).toBe(first.keys.get(original.children[1]!));
    owner.commit(next);
    const duplicate = paragraph();
    const final = owner.prepare(root(paragraph(), duplicate), new WeakMap());
    expect(final.keys.get(duplicate)).not.toBe(first.keys.get(original));
    expect(new Set(final.roots.map((value) => value.key)).size).toBe(2);
  });

  test("a ten-thousand-block preceding insertion preserves identities with a bounded record-read budget", () => {
    const owner = createMarkdownElementKeyOwner();
    const make = (index: number): Element => ({
      type: "element",
      tagName: "p",
      properties: {},
      children: [{ type: "text", value: `unique-${index} paragraph` }],
    });
    const original = Array.from({ length: 10_000 }, (_value, index) => make(index));
    const first = owner.prepare(root(...original), new WeakMap());
    let reads = 0;
    owner.commit({
      ...first,
      roots: first.roots.map(
        (value) =>
          new Proxy(value, {
            get(target, key, receiver) {
              if (key === "seed" || key === "key") reads += 1;
              return Reflect.get(target, key, receiver);
            },
          }),
      ),
    });
    const nextNodes = original.map((_value, index) => make(index));
    const next = owner.prepare(root(heading("inserted"), ...nextNodes), new WeakMap());
    expect(next.keys.get(nextNodes[0]!)).toBe(first.keys.get(original[0]!));
    expect(next.keys.get(nextNodes.at(-1)!)).toBe(first.keys.get(original.at(-1)!));
    expect(new Set(next.roots.map((value) => value.key)).size).toBe(10_001);
    expect(reads).toBeLessThanOrEqual(60_000);
  });

  test("semantic first-word distinctions between units 64 and 80 retain their own reordered element identities", () => {
    const owner = createMarkdownElementKeyOwner();
    const word = "a".repeat(70);
    const first = heading(`${word}first`);
    const second = heading(`${word}other`);
    const initial = owner.prepare(root(first, second), new WeakMap());
    owner.commit(initial);
    const reorderedFirst = heading(`${word}other`);
    const reorderedSecond = heading(`${word}first`);
    const next = owner.prepare(root(reorderedFirst, reorderedSecond), new WeakMap());
    expect(next.keys.get(reorderedFirst)).toBe(initial.keys.get(second));
    expect(next.keys.get(reorderedSecond)).toBe(initial.keys.get(first));
  });
});

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

describe("markdown syntax", () => {
  const math = createMathPlugin();
  const remarks = [
    ...cjk.remarkPluginsBefore,
    ...Object.values(defaultRemarkPlugins),
    ...cjk.remarkPluginsAfter,
    math.remarkPlugin,
  ];
  const rehypes = [...Object.values(defaultRehypePlugins), math.rehypePlugin];
  const policy: MarkdownSyntaxPolicy = {
    family: true,
    normalizeLists: true,
    repairIncomplete: true,
    remarkPlugins: remarks,
    rehypePlugins: rehypes,
    blockLocal: true,
  };

  function semanticHtml(node: ImmutableMarkdown<HtmlNodes>): unknown {
    if (node.type === "text") return node.value.trim() ? node.value : null;
    if (node.type === "element")
      return {
        tag: node.tagName,
        properties: node.properties,
        children: node.children.map(semanticHtml).filter((value) => value !== null),
      };
    if (node.type === "root")
      return node.children.map(semanticHtml).filter((value) => value !== null);
    return null;
  }

  function combinedHtml(roots: readonly ImmutableMarkdown<HtmlRoot>[]): unknown[] {
    return roots.flatMap((root) => semanticHtml(root) as unknown[]);
  }

  describe("typed Markdown syntax and prefix consumption", () => {
    test.each(["\u2028", "\u2029", "\u0085"])(
      "does not split a paragraph or terminate code at Unicode separator %j",
      (separator) => {
        expect(findMarkdownStablePrefix(`first${separator}${separator}second`)).toBe(0);
        expect(findMarkdownOpenCodeFence(`\`\`\`text\nalpha${separator}\`\`\``)).toBe(true);
        expect(findMarkdownOpenCodeFence(`\`\`\`text\nalpha\n\`\`\`${separator}`)).toBe(true);
      },
    );
    test("preserves Unicode separators as authored code characters in active and completed syntax", () => {
      const engine = createMarkdownSyntaxEngine();
      const value = "alpha\u2028beta\u2029gamma\u0085delta";
      const source = `\`\`\`text\n${value}\n\`\`\``;
      const complete = engine.read(source, policy);
      expect(complete.ast.children.find((node) => node.type === "code")?.value).toBe(value);
      const active = engine.readStreaming(source, policy, createMarkdownPrefixCache());
      expect(
        active.blocks
          .flatMap(({ syntax }) =>
            syntax.node.type === "root" ? syntax.node.children : [syntax.node],
          )
          .find((node) => node.type === "code")?.value,
      ).toBe(value);
    });
    test("preserves authored blank lines in fenced and indented code through streaming and completion", () => {
      const engine = createMarkdownSyntaxEngine();
      const value = "alpha\n\n\n\nbeta";
      for (const source of [
        `\`\`\`text\n${value}\n\`\`\``,
        "    alpha\n\n\n\n    beta\n",
        `\`\`\`text\r\n${value.replaceAll("\n", "\r\n")}\r\n\`\`\``,
      ]) {
        const syntax = engine.read(source, policy);
        const code = syntax.ast.children.find((node) => node.type === "code");
        expect(code?.value).toBe(value);
        const active = engine.readStreaming(source, policy, createMarkdownPrefixCache());
        const activeCode = active.blocks
          .flatMap(({ syntax }) =>
            syntax.node.type === "root" ? syntax.node.children : [syntax.node],
          )
          .find((node) => node.type === "code");
        expect(activeCode?.value).toBe(value);
      }
    });

    test("returns the same immutable typed tree without reparsing or normalizing a raw-source hit", () => {
      const engine = createMarkdownSyntaxEngine();
      const source = "first\r\n\r\nsecond\u2028third";
      const first = engine.read(source, policy);
      const before = engine.getMeasurements();
      expect(engine.read(source, { ...policy })).toBe(first);
      expect(engine.getMeasurements()).toMatchObject({
        parsedUnits: before.parsedUnits,
        normalizedUnits: before.normalizedUnits,
        parseCalls: before.parseCalls,
        fullCacheHits: 1,
      });
      expect(Object.isFrozen(first.ast)).toBe(true);
      expect(Object.isFrozen(first.ast.children)).toBe(true);
      expect(Object.isFrozen(first.ast.children[0])).toBe(true);
      expect(engine.read(source.replaceAll("\r\n", "\n"), policy)).not.toBe(first);
    });

    test("isolates syntax families, extension array identities, repair and normalization policies", () => {
      const engine = createMarkdownSyntaxEngine();
      const source = "**unfinished";
      const first = engine.read(source, policy);
      for (const changed of [
        { ...policy, family: false },
        { ...policy, normalizeLists: false },
        { ...policy, repairIncomplete: false },
        { ...policy, remarkPlugins: [...remarks] },
      ])
        expect(engine.read(source, changed)).not.toBe(first);
      expect(engine.read(source, policy)).toBe(first);
    });

    test("reuses stable AST and transformed HAST while consuming only the new suffix and tail", () => {
      const engine = createMarkdownSyntaxEngine();
      const prefixes = createMarkdownPrefixCache();
      const first = engine.readStreaming("# Stable\n\nfirst tail", policy, prefixes);
      const before = engine.getMeasurements();
      const next = engine.readStreaming("# Stable\n\nfirst tail\n\nnew tail", policy, prefixes);
      expect(next.blocks[0]?.syntax).toBe(first.blocks[0]?.syntax);
      expect(next.blocks[0]?.html).toBe(first.blocks[0]?.html);
      expect(engine.getMeasurements().parsedUnits - before.parsedUnits).toBe(
        "first tail\n\n".length + "new tail".length,
      );
      expect(engine.getMeasurements().transformedUnits - before.transformedUnits).toBe(
        "first tail".length + "new tail".length,
      );
      const stable = next.blocks[0]!.syntax.node;
      expect(Object.isFrozen(stable)).toBe(true);
      expect(stable).toEqual(first.blocks[0]!.syntax.node);
    });

    test("uses full typed document transforms for references, HTML and unknown root-wide extensions", () => {
      const engine = createMarkdownSyntaxEngine();
      const prefixes = createMarkdownPrefixCache();
      const reference = engine.readStreaming(
        "[read][ref]\n\n[ref]: https://example.com",
        policy,
        prefixes,
      );
      expect(reference.fullDocumentReason).toBe("references");
      expect(semanticHtml(reference.blocks[0]!.html)).toEqual([
        {
          tag: "p",
          properties: {},
          children: [
            {
              tag: "a",
              properties: {
                href: "https://example.com/",
                target: "_blank",
                rel: "noopener noreferrer",
              },
              children: ["read"],
            },
          ],
        },
      ]);
      expect(
        engine.readStreaming("<div>before\n\n<strong>after</strong></div>", policy, prefixes)
          .fullDocumentReason,
      ).toBe("html");
      expect(
        engine.readStreaming("first\n\nsecond", { ...policy, blockLocal: false }, prefixes)
          .fullDocumentReason,
      ).toBe("extension");
    });

    test("keeps code containing HTML or reference-like text in the block-local prefix lane", () => {
      const engine = createMarkdownSyntaxEngine();
      const prefixes = createMarkdownPrefixCache();
      const source = "```ts\nconst node = <T>(value: T) => value; // [name]: literal\n```\n\ntail";
      const first = engine.readStreaming(source, policy, prefixes);
      expect(first.fullDocumentReason).toBeNull();
      const next = engine.readStreaming(source + " append", policy, prefixes);
      expect(next.blocks[0]?.html).toBe(first.blocks[0]?.html);
    });

    test("normalizes ordered-list continuations and list headings on the actual cached typed tree", () => {
      const engine = createMarkdownSyntaxEngine();
      const source = "1. Parent\n\n- Child one\n- Child two\n\n2. Next";
      const repaired = engine.read(source, policy);
      expect(repaired.ast.children).toHaveLength(1);
      const list = repaired.ast.children[0];
      if (list?.type !== "list") throw new Error("Missing ordered list");
      expect(list.children).toHaveLength(2);
      expect(list.children[0]?.children[1]?.type).toBe("list");
      expect(repaired.blocks[0]?.source).toBe(source);
      expect(engine.read(source, { ...policy, normalizeLists: false }).ast.children).toHaveLength(
        3,
      );
      const heading = engine.read("- ## Heading", policy).ast.children[0];
      if (heading?.type !== "list") throw new Error("Missing heading list");
      expect(heading.children[0]?.children[0]).toMatchObject({
        type: "paragraph",
        children: [
          { type: "text", value: "## " },
          { type: "text", value: "Heading" },
        ],
      });
      const colon = engine.read("1. Parent:\n\n- Single child", policy).ast.children[0];
      if (colon?.type !== "list") throw new Error("Missing colon parent");
      expect(colon.children[0]?.children[1]?.type).toBe("list");
      expect(engine.read("1. Parent\n\n- Single child", policy).ast.children).toHaveLength(2);
    });

    test("keeps the cached syntax unchanged when a public transformer mutates its input", () => {
      const mutation = () => (tree: import("mdast").Root) => {
        const paragraph = tree.children.find((node) => node.type === "paragraph");
        if (paragraph?.type === "paragraph")
          paragraph.children.push({ type: "text", value: " appended" });
      };
      const changed = { ...policy, remarkPlugins: [...remarks, mutation] };
      const engine = createMarkdownSyntaxEngine();
      const syntax = engine.read("original", changed);
      const before = structuredClone(syntax.ast);
      const transformed = engine.readFull("original", changed, "terminal");
      expect(semanticHtml(transformed.blocks[0]!.html)).toEqual([
        { tag: "p", properties: {}, children: ["original appended"] },
      ]);
      expect(engine.read("original", changed)).toBe(syntax);
      expect(syntax.ast).toEqual(before);
    });

    test("evicts by real read recency at 100 syntax keys while prefix hits retain insertion order", () => {
      const engine = createMarkdownSyntaxEngine();
      const first = engine.read("entry 0", policy);
      const second = engine.read("entry 1", policy);
      for (let index = 2; index < 100; index += 1) engine.read(`entry ${index}`, policy);
      expect(engine.read("entry 0", policy)).toBe(first);
      engine.read("entry 100", policy);
      expect(engine.read("entry 0", policy)).toBe(first);
      expect(engine.read("entry 1", policy)).not.toBe(second);
      const prefixes = createMarkdownPrefixCache();
      const blocks = engine.read("prefix", policy).blocks;
      for (let index = 0; index < 100; index += 1) prefixes.set(`${index}`, blocks);
      expect(prefixes.get("0")).toBe(blocks);
      prefixes.set("100", blocks);
      expect(prefixes.get("0")).toBeUndefined();
      expect(prefixes.get("1")).toBe(blocks);
    });

    test.each([
      "first\n\nsecond",
      "first\r\n\r\nsecond",
      "first\u2028\u2028second",
      "first\n\n- continuation\n\n  nested",
      "first\n\n> quote\n\n> continuation",
      "````js\n\n```\n\ntext\n````\n\nnext",
      "~~~js\n\n```\n\ntext\n~~~\n\nnext",
      "$$\nx\n\n\ny\n$$\n\nnext",
      ":::outer\n\n:::inner\n\ntext\n:::\n\nmore\n:::\n\nnext",
    ])("never makes a prefix boundary inside a scoped block: %s", (source) => {
      const offset = findMarkdownStablePrefix(source);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(source.length);
      if (
        source.startsWith("``") ||
        source.startsWith("~~~") ||
        source.startsWith("$$") ||
        source.startsWith(":::")
      )
        expect(source.slice(offset)).toBe("next");
      if (source === "first\n\nsecond" || source === "first\r\n\r\nsecond")
        expect(source.slice(offset)).toBe("second");
    });

    test.each([
      "# Heading\n\nHello **bold** and _emphasis_.\n\nlast",
      "# 前缀\n\n中文标点，emoji 👩‍💻 and `code`。\n\n尾巴",
      "first\n\n- one\n  - nested\n- two\n\nlast",
      "first\n\n> quoted\n> **bold**\n\nlast",
      "first\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nlast",
      "first\n\n```ts\nconst x = 1;\n```\n\nlast",
      "first\n\n$$\nx^2\n$$\n\nlast",
      "first\n\n[link](https://example.com) and ![image](https://example.com/x.png)\n\nlast",
      "first\n\nfootnote[^a]\n\n[^a]: note",
      "first\n\n[reference][r]\n\n[r]: https://example.com",
      "first\n\n<details><summary>Open</summary><p>body</p></details>",
      "first\r\n\r\nsecond\u2028\u2028third",
    ])("matches the full public rich transform at every arrival prefix: %s", (source) => {
      const engine = createMarkdownSyntaxEngine();
      const prefixes = createMarkdownPrefixCache();
      for (let length = 1; length <= source.length; length += 1) {
        const current = source.slice(0, length);
        const incremental = engine.readStreaming(current, policy, prefixes);
        const full = engine.readFull(current, policy, "terminal");
        expect(combinedHtml(incremental.blocks.map((block) => block.html))).toEqual(
          combinedHtml(full.blocks.map((block) => block.html)),
        );
      }
    });
  });

  describe("syntax capacity and complete large documents", () => {
    test("admits the inclusive one-million boundary but renders oversized source without caching", () => {
      const engine = createMarkdownSyntaxEngine();
      const source = "a".repeat(1_000_000);
      const boundary = engine.read(source, policy);
      expect(engine.read(source, policy)).toBe(boundary);
      const oversized = source + " tail beyond the cache";
      const first = engine.read(oversized, policy);
      expect(engine.read(oversized, policy)).not.toBe(first);
      const result = engine.readFull(oversized, policy, "terminal");
      const paragraph = result.blocks[0]!.html.children[0];
      expect(paragraph?.type).toBe("element");
      if (paragraph?.type !== "element") throw new Error("Missing complete paragraph");
      const text = paragraph.children[0];
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("Missing complete text");
      expect(text.value).toBe(oversized);
    });
    test("enforces the six-million aggregate raw-key budget independently of key count", () => {
      const engine = createMarkdownSyntaxEngine();
      const value = "a".repeat(900_000);
      const first = engine.read(`0 ${value}`, policy);
      const second = engine.read(`1 ${value}`, policy);
      for (let index = 2; index < 7; index += 1) engine.read(`${index} ${value}`, policy);
      expect(engine.read(`1 ${value}`, policy)).toBe(second);
      expect(engine.read(`0 ${value}`, policy)).not.toBe(first);
    });
  });
});
