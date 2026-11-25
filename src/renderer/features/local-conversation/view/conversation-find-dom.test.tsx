import { describe, expect, test, afterEach, vi } from "vite-plus/test";
import {
  resolveConversationContentAnchor,
  type ConversationContentAnchor,
} from "./local-conversation-content-anchor";
import { createLocalConversationNativeFindScroll } from "./local-conversation-native-find-scroll";
import type { ContentSearchLocalResult } from "../../content-search/content-search-model";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";
import {
  scrollToLocalConversationSearchMatch,
  waitForLocalConversationSearchLayout,
} from "./local-conversation-search-scroll";
import {
  applyThreadSearchDomMarks,
  applyLocalConversationSearchHighlights,
} from "./local-conversation-thread-search-dom-marks";

describe("conversation content anchor identity", () => {
  test("follows the same message when a prepend renumbers search units and remounts its leaf", () => {
    const root = document.createElement("div");
    const element = document.createElement("div");
    element.setAttribute("data-conversation-item-key", "resident");
    element.setAttribute("data-content-search-unit-key", "turn:user:0");
    root.append(element);
    const anchor: ConversationContentAnchor = {
      element,
      attribute: "data-conversation-item-key",
      key: "resident",
      topWithinViewportPx: 56,
    };
    root.innerHTML = `<div data-conversation-item-key="older" data-content-search-unit-key="turn:user:0"></div><div data-conversation-item-key="resident" data-content-search-unit-key="turn:user:2"></div>`;

    expect(resolveConversationContentAnchor([anchor], root)?.element).toBe(root.lastElementChild);
  });

  test("selects a surviving native leaf after a renamed row releases the first visible segment", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section data-turn-key="voice:older"><div data-native-realtime-item-id="resident" data-content-search-unit-key="voice:older:resident"></div></section>`;
    const anchors: ConversationContentAnchor[] = ["released", "resident"].map((key, index) => ({
      element: null,
      attribute: "data-native-realtime-item-id",
      key,
      topWithinViewportPx: index * 100 - 20,
    }));

    const resolved = resolveConversationContentAnchor(anchors, root);

    expect(resolved?.element).toBe(root.querySelector("[data-native-realtime-item-id]"));
    expect(resolved?.anchor).toBe(anchors[1]);
    expect(resolved?.anchor.topWithinViewportPx).toBe(80);
  });

  test("does not restore a leaf that moved outside the mounted transcript", () => {
    const root = document.createElement("div");
    const element = document.createElement("div");
    element.setAttribute("data-content-search-unit-key", "turn:user:0");
    const anchor: ConversationContentAnchor = {
      element,
      attribute: "data-content-search-unit-key",
      key: "turn:user:0",
      topWithinViewportPx: 12,
    };
    expect(resolveConversationContentAnchor([anchor], root)).toBeNull();

    root.append(element);
    expect(resolveConversationContentAnchor([anchor], root)?.element).toBe(element);
    element.remove();
    expect(resolveConversationContentAnchor([anchor], root)).toBeNull();
  });
});

describe("local conversation native find scroll", () => {
  function frames() {
    let next = 0;
    const pending = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.set(++next, callback);
      return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
    return {
      pending,
      flush: () => {
        for (const [id, callback] of [...pending]) {
          pending.delete(id);
          callback(0);
        }
      },
    };
  }

  function fixture(input: { targetTop?: number; scrollTop?: number } = {}) {
    vi.useFakeTimers();
    const frame = frames();
    const viewport = document.createElement("div");
    const geometry = { height: 1_600, targetTop: input.targetTop ?? 800, clientHeight: 400 };
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => geometry.height },
      clientHeight: { get: () => geometry.clientHeight },
      offsetHeight: { get: () => geometry.clientHeight },
      clientTop: { value: 0 },
    });
    viewport.scrollTop = input.scrollTop ?? 600;
    viewport.getBoundingClientRect = () => new DOMRect(0, 10, 500, geometry.clientHeight);
    document.body.append(viewport);
    const newMark = () => {
      const mark = document.createElement("mark");
      mark.getBoundingClientRect = () => new DOMRect(0, geometry.targetTop, 100, 20);
      const scroll = vi.fn();
      mark.scrollIntoView = scroll;
      viewport.append(mark);
      return { mark, scroll };
    };
    const first = newMark();
    let target: HTMLElement | null = first.mark;
    const readTarget = vi.fn(() => target);
    const finished = vi.fn();
    const abort = new AbortController();
    const operation = createLocalConversationNativeFindScroll({
      scrollElement: viewport,
      readTarget,
      signal: abort.signal,
      onFinish: finished,
    });
    return {
      ...first,
      viewport,
      geometry,
      frame,
      readTarget,
      finished,
      abort,
      operation,
      newMark,
      setTarget: (next: HTMLElement | null) => {
        target = next;
      },
      scrollEnd: () => viewport.dispatchEvent(new Event("scrollend")),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  describe("native Find scroll lifetime", () => {
    test.each([
      { scrollTop: 600, targetTop: 200 },
      { scrollTop: 0, targetTop: 20 },
      { scrollTop: 1_200, targetTop: 380 },
    ])(
      "finishes an already positioned request without scrollend at scrollTop $scrollTop",
      async (input) => {
        const value = fixture(input);
        expect(value.finished).not.toHaveBeenCalled();
        expect(value.scroll).toHaveBeenCalledOnce();
        value.frame.flush();
        await Promise.resolve();
        expect(value.finished).toHaveBeenCalledOnce();
        expect(value.scroll).toHaveBeenCalledOnce();
        expect(value.frame.pending.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    test("compensation retires a pending no-motion confirmation before its layout frame", async () => {
      const value = fixture({ targetTop: 200 });
      value.geometry.targetTop = 800;
      value.geometry.height += 100;
      value.operation.resume();
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.scroll).toHaveBeenCalledTimes(2);
      expect(value.frame.pending.size).toBe(0);
      value.geometry.targetTop = 200;
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
    });

    test("a replacement mark requires its own native request and layout confirmation", async () => {
      const value = fixture({ targetTop: 200 });
      value.mark.remove();
      const replacement = value.newMark();
      value.setTarget(replacement.mark);
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).not.toHaveBeenCalled();
      expect(replacement.scroll).toHaveBeenCalledOnce();
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.scroll).toHaveBeenCalledOnce();
    });

    test("changed dimensions invalidate a pending no-motion confirmation", async () => {
      const value = fixture({ targetTop: 200 });
      value.geometry.height += 100;
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.scroll).toHaveBeenCalledTimes(2);
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
    });

    test("abort cancels a pending no-motion confirmation without another native request", async () => {
      const value = fixture({ targetTop: 200 });
      value.abort.abort();
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.scroll).toHaveBeenCalledOnce();
      expect(value.frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("an in-flight request cannot finish merely because its target moves to center after requesting", async () => {
      const value = fixture();
      value.scroll.mockImplementationOnce(() => {
        value.geometry.targetTop = 200;
      });
      value.operation.resume();
      value.frame.flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.frame.pending.size).toBe(0);
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
    });

    test("resumes native center once after compensation and ignores its early scrollend", async () => {
      const value = fixture();
      expect(value.scroll).toHaveBeenCalledExactlyOnceWith({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
      value.geometry.height += 1_460;
      value.operation.resume();
      value.operation.resume();
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.frame.pending.size).toBe(1);
      value.frame.flush();
      expect(value.scroll).toHaveBeenCalledTimes(2);
      value.scrollEnd();
      expect(value.finished).not.toHaveBeenCalled();
      value.geometry.targetTop = 200;
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      value.operation.resume();
      value.scrollEnd();
      value.frame.flush();
      expect(value.scroll).toHaveBeenCalledTimes(2);
    });

    test("waits for a same-query mark remount without scrolling the detached mark", async () => {
      const value = fixture();
      value.mark.remove();
      value.setTarget(null);
      value.operation.resume();
      for (let i = 0; i < 5; i += 1) {
        value.frame.flush();
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.scroll).toHaveBeenCalledOnce();
      const replacement = value.newMark();
      value.setTarget(replacement.mark);
      value.geometry.targetTop = 200;
      value.frame.flush();
      expect(replacement.scroll).toHaveBeenCalledExactlyOnceWith({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
      expect(value.finished).not.toHaveBeenCalled();
      value.frame.flush();
      expect(value.frame.pending.size).toBe(0);
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    test("retargets a new connected mark at scrollend before accepting its geometry", async () => {
      const value = fixture();
      value.mark.remove();
      const replacement = value.newMark();
      value.setTarget(replacement.mark);
      value.geometry.targetTop = 200;
      value.scrollEnd();
      expect(value.frame.pending.size).toBe(1);
      expect(value.finished).not.toHaveBeenCalled();
      value.frame.flush();
      expect(replacement.scroll).toHaveBeenCalledOnce();
      value.scrollEnd();
      expect(value.finished).not.toHaveBeenCalled();
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
    });

    test("content growth requires a fresh native request before completion", async () => {
      const value = fixture();
      value.geometry.targetTop = 200;
      value.geometry.height += 100;
      value.scrollEnd();
      expect(value.finished).not.toHaveBeenCalled();
      expect(value.frame.pending.size).toBe(1);
      value.frame.flush();
      expect(value.scroll).toHaveBeenCalledTimes(2);
      value.scrollEnd();
      expect(value.finished).not.toHaveBeenCalled();
      value.frame.flush();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
    });

    test("uses the current padded viewport center after footer changes", async () => {
      const value = fixture();
      value.viewport.style.scrollPaddingBottom = "20%";
      value.geometry.targetTop = 200;
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).not.toHaveBeenCalled();
      value.geometry.targetTop = 160;
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
    });

    test.each([
      { scrollTop: 0, targetTop: 20 },
      { scrollTop: 1_200, targetTop: 380 },
    ])("accepts a visible native edge clamp at scrollTop $scrollTop", async (input) => {
      const value = fixture();
      value.viewport.scrollTop = input.scrollTop;
      value.geometry.targetTop = input.targetTop;
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.scroll).toHaveBeenCalledOnce();
    });

    test("resumes and missing-mark polling share the original 1500ms deadline", async () => {
      const value = fixture();
      await vi.advanceTimersByTimeAsync(1_400);
      value.mark.remove();
      value.setTarget(null);
      value.operation.resume();
      value.frame.flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const replacement = value.newMark();
      value.setTarget(replacement.mark);
      value.operation.resume();
      value.frame.flush();
      expect(replacement.scroll).not.toHaveBeenCalled();
    });

    test("abort and repeated cancel release pending resources without another scroll", async () => {
      const value = fixture();
      value.operation.resume();
      value.abort.abort();
      value.operation.cancel();
      value.operation.resume();
      value.frame.flush();
      value.scrollEnd();
      await Promise.resolve();
      expect(value.finished).toHaveBeenCalledOnce();
      expect(value.scroll).toHaveBeenCalledOnce();
      expect(value.frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("already aborted construction finishes asynchronously without reading or scrolling", async () => {
      vi.useFakeTimers();
      const abort = new AbortController();
      abort.abort();
      const readTarget = vi.fn();
      const onFinish = vi.fn();
      createLocalConversationNativeFindScroll({
        scrollElement: document.createElement("div"),
        readTarget,
        signal: abort.signal,
        onFinish,
      });
      expect(onFinish).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(onFinish).toHaveBeenCalledOnce();
      expect(readTarget).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("local conversation search highlight owner", () => {
  const target = (unitKey: string, occurrenceIndex = 0): LocalConversationSearchTarget => ({
    unitKey,
    turnKey: "turn",
    occurrenceIndex,
  });
  const result = (
    targets: readonly LocalConversationSearchTarget[],
    query = "needle",
  ): ContentSearchLocalResult => ({
    query,
    totalMatches: targets.length,
    capped: false,
    matches: targets.map((meta, ordinal) => ({
      id: `${meta.unitKey}:${meta.occurrenceIndex}`,
      ordinal,
      contextId: "conversation:thread",
      domain: "conversation",
      meta,
    })),
  });
  function fixture(html: string) {
    let root: HTMLElement = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    const resolveTarget = vi.fn((match) => match.meta as LocalConversationSearchTarget);
    const owner = createLocalConversationSearchHighlightOwner({
      readRoot: () => root,
      resolveTarget,
    });
    return {
      owner,
      resolveTarget,
      get root() {
        return root;
      },
      replaceRoot(next: HTMLElement) {
        root = next;
        document.body.append(root);
      },
    };
  }
  const deliverMutations = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("conversation search highlight owner", () => {
    test("rebinds a replacement content root to the retained result without another search", () => {
      const f = fixture('<div data-content-search-unit-key="unit">needle</div>');
      try {
        f.owner.publishResult(result([target("unit")]), "unit:0");
        const retired = f.root;
        const next = document.createElement("div");
        next.innerHTML = '<div data-content-search-unit-key="unit">replacement needle</div>';
        f.replaceRoot(next);
        f.owner.refresh();
        expect(retired.querySelector("mark")).toBeNull();
        expect(f.owner.readActiveMatch("unit:0")?.parentElement).toBe(next.firstElementChild);
      } finally {
        f.owner.clear();
      }
    });
    test("marks only retained identities across units instead of 250 per unit", () => {
      const f = fixture(
        `<div data-content-search-unit-key="first">${"needle ".repeat(200)}</div><div data-content-search-unit-key="second">${"needle ".repeat(200)}</div><div data-tool-output>needle</div>`,
      );
      const retained = [
        ...Array.from({ length: 200 }, (_, i) => target("first", i)),
        ...Array.from({ length: 50 }, (_, i) => target("second", i)),
      ];
      try {
        f.owner.publishResult(result(retained), "second:49");
        expect(f.root.querySelectorAll("mark")).toHaveLength(250);
        expect(
          f.root.querySelectorAll('[data-content-search-unit-key="second"] mark'),
        ).toHaveLength(50);
        expect(
          f.owner.readActiveMatch("second:49")?.getAttribute("data-content-search-match-id"),
        ).toBe("second:49");
        expect(f.root.querySelector("[data-tool-output] mark")).toBeNull();
      } finally {
        f.owner.clear();
      }
    });

    test("coalesces new mounted units and text changes after exactly 80ms without re-querying", async () => {
      vi.useFakeTimers();
      const f = fixture('<div data-content-search-unit-key="first">needle</div>');
      try {
        f.owner.publishResult(result([target("first"), target("second")]), "second:0");
        const mounted = document.createElement("div");
        mounted.dataset.contentSearchUnitKey = "second";
        mounted.textContent = "initial";
        f.root.append(mounted);
        await deliverMutations();
        vi.advanceTimersByTime(40);
        mounted.textContent = "updated needle";
        await deliverMutations();
        vi.advanceTimersByTime(39);
        expect(f.owner.readActiveMatch("second:0")).toBeNull();
        vi.advanceTimersByTime(1);
        expect(f.owner.readActiveMatch("second:0")?.textContent).toBe("needle");
        expect(f.resolveTarget).toHaveBeenCalledTimes(4);
        await deliverMutations();
        vi.advanceTimersByTime(160);
        expect(f.resolveTarget).toHaveBeenCalledTimes(4);
      } finally {
        f.owner.clear();
      }
    });

    test("rebuilds a matching text node and respects hidden boundaries", async () => {
      vi.useFakeTimers();
      const f = fixture('<div data-content-search-unit-key="unit">needle</div>');
      const unit = f.root.firstElementChild!;
      try {
        f.owner.publishResult(result([target("unit")]), "unit:0");
        unit.textContent = "prefix needle suffix";
        await deliverMutations();
        vi.advanceTimersByTime(80);
        expect(f.owner.readActiveMatch("unit:0")?.textContent).toBe("needle");
        unit.setAttribute("hidden", "");
        await deliverMutations();
        vi.advanceTimersByTime(80);
        expect(unit.querySelector("mark")).toBeNull();
        unit.removeAttribute("hidden");
        await deliverMutations();
        vi.advanceTimersByTime(80);
        expect(f.owner.readActiveMatch("unit:0")?.textContent).toBe("needle");
      } finally {
        f.owner.clear();
      }
    });

    test("retires pending callbacks and old marks before binding another root/query", async () => {
      vi.useFakeTimers();
      const f = fixture('<div data-content-search-unit-key="old">needle</div>');
      const retired = f.root;
      f.owner.publishResult(result([target("old")]), "old:0");
      retired.append(document.createTextNode("late mutation"));
      await deliverMutations();
      f.owner.clear();
      const next = document.createElement("div");
      next.innerHTML = '<div data-content-search-unit-key="new">replacement</div>';
      f.replaceRoot(next);
      try {
        f.owner.publishResult(result([target("new")], "replacement"), "new:0");
        await deliverMutations();
        vi.advanceTimersByTime(160);
        expect(retired.querySelector("mark")).toBeNull();
        expect(f.owner.readActiveMatch("old:0")).toBeNull();
        expect(f.owner.readActiveMatch("new:0")?.textContent).toBe("replacement");
        next.firstElementChild!.remove();
        expect(f.owner.readActiveMatch("new:0")).toBeNull();
      } finally {
        f.owner.clear();
      }
    });
  });
});

describe("local conversation search scroll", () => {
  function frames() {
    let next = 0;
    const pending = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      pending.set(++next, fn);
      return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
    return {
      pending,
      flush: () => {
        for (const [id, fn] of [...pending]) {
          pending.delete(id);
          fn(0);
        }
      },
    };
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("search scroll readiness", () => {
    test("settles an already aborted navigation without querying or scrolling", async () => {
      const abort = new AbortController();
      abort.abort();
      const readMatch = vi.fn();
      const scroll = vi.fn();
      await scrollToLocalConversationSearchMatch({ readMatch, scroll, signal: abort.signal });
      expect(readMatch).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
    });
    test("waits two layout frames and cancels promptly when rendering is suspended", async () => {
      const frame = frames();
      const abort = new AbortController();
      let settled = false;
      const result = waitForLocalConversationSearchLayout(abort.signal).then(() => {
        settled = true;
      });
      frame.flush();
      await Promise.resolve();
      expect(settled).toBe(false);
      abort.abort();
      await result;
      expect(frame.pending.size).toBe(0);
    });
    test("scrolls exactly the deferred mark and releases its frame and timeout", async () => {
      vi.useFakeTimers();
      const frame = frames();
      let target: HTMLElement | null = null;
      const scroll = vi.fn();
      const result = scrollToLocalConversationSearchMatch({ readMatch: () => target, scroll });
      frame.flush();
      expect(scroll).not.toHaveBeenCalled();
      target = document.createElement("mark");
      frame.flush();
      await result;
      expect(scroll).toHaveBeenCalledExactlyOnceWith(target);
      expect(frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
    test("bounds missing-mark polling at 1500ms without scrolling to another occurrence", async () => {
      vi.useFakeTimers();
      const frame = frames();
      const scroll = vi.fn();
      const result = scrollToLocalConversationSearchMatch({ readMatch: () => null, scroll });
      await vi.advanceTimersByTimeAsync(1_500);
      await result;
      expect(scroll).not.toHaveBeenCalled();
      expect(frame.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("applyThreadSearchDomMarks", () => {
  test("highlights voice units and selects the exact occurrence without touching tool output", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-content-search-unit-key="voice:item">😀 ｎｅｅｄｌｅ and néedle</div><div data-content-search-unit-key="promoted:inlineMarkdown">inline needle</div><div data-tool-output>needle</div><div data-widget>needle</div>`;
    const active = applyLocalConversationSearchHighlights({
      root,
      query: "needle",
      target: { turnKey: "voice", unitKey: "voice:item", occurrenceIndex: 1 },
    });
    expect(root.querySelectorAll("mark")).toHaveLength(3);
    expect(root.querySelector("[data-tool-output] mark")).toBeNull();
    expect(root.querySelector("[data-widget] mark")).toBeNull();
    expect(active).toBe(
      root.querySelectorAll('[data-content-search-unit-key="voice:item"] mark').item(1),
    );
    expect(active?.textContent).toBe("néedle");
    expect(active?.classList.contains("codex-thread-find-active")).toBe(true);
    expect(
      applyLocalConversationSearchHighlights({
        root,
        query: "needle",
        target: { turnKey: "removed", unitKey: "removed", occurrenceIndex: 0 },
      }),
    ).toBeNull();
    expect(root.querySelector(".codex-thread-find-active")).toBeNull();
  });
  test("adds and removes search match classes on visible search units and turn rows", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-content-search-turn-key="turn_1">
        <div data-content-search-unit-key="turn_1:user:0"></div>
        <div data-content-search-unit-key="turn_1:assistant"></div>
      </div>
      <div data-content-search-turn-key="turn_2">
        <div data-content-search-unit-key="turn_2:user:0"></div>
      </div>
    `;

    applyThreadSearchDomMarks({
      root,
      matchedSearchUnitKeys: new Set(["turn_1:assistant"]),
      matchedTurnKeys: new Set(["turn_1"]),
      activeSearchUnitKey: "turn_1:assistant",
    });

    const matchedUnit = root.querySelector(
      '[data-content-search-unit-key="turn_1:assistant"]',
    ) as HTMLDivElement | null;
    const unmatchedUnit = root.querySelector(
      '[data-content-search-unit-key="turn_2:user:0"]',
    ) as HTMLDivElement | null;
    const matchedTurn = root.querySelector(
      '[data-content-search-turn-key="turn_1"]',
    ) as HTMLDivElement | null;

    expect(Boolean(matchedUnit?.className.includes("bg-token-foreground/4"))).toBe(true);
    expect(Boolean(matchedUnit?.className.includes("bg-token-foreground/7"))).toBe(true);
    expect(Boolean(matchedTurn?.className.includes("bg-token-foreground/3"))).toBe(true);
    expect(Boolean(unmatchedUnit?.className.includes("bg-token-foreground/4"))).toBe(false);

    applyThreadSearchDomMarks({
      root,
      matchedSearchUnitKeys: new Set(),
      matchedTurnKeys: new Set(),
      activeSearchUnitKey: null,
    });

    expect(Boolean(matchedUnit?.className.includes("bg-token-foreground/4"))).toBe(false);
    expect(Boolean(matchedUnit?.className.includes("bg-token-foreground/7"))).toBe(false);
    expect(Boolean(matchedTurn?.className.includes("bg-token-foreground/3"))).toBe(false);
  });
  test("selects the second logical occurrence when each result spans formatting elements", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-content-search-unit-key="assistant"><span>need</span><strong>le</strong> and <span>need</span><em>le</em></div>';
    const active = applyLocalConversationSearchHighlights({
      root,
      query: "needle",
      target: { turnKey: "turn", unitKey: "assistant", occurrenceIndex: 1 },
    });
    const fragments = Array.from(root.querySelectorAll(".codex-thread-find-active"));
    expect(fragments.map((fragment) => fragment.textContent).join("")).toBe("needle");
    expect(fragments).toHaveLength(2);
    expect(active).toBe(fragments[0]);
    expect(active?.parentElement).toBe(root.querySelectorAll("span").item(1));
  });
});
