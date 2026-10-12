import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ContentSearchLocalResult } from "../../content-search/content-search-model";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";

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
      expect(f.root.querySelectorAll('[data-content-search-unit-key="second"] mark')).toHaveLength(
        50,
      );
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
