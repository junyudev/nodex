import { describe, expect, test } from "vite-plus/test";
import {
  applyThreadSearchDomMarks,
  applyLocalConversationSearchHighlights,
} from "./local-conversation-thread-search-dom-marks";

describe("applyThreadSearchDomMarks", () => {
  test("highlights voice units and selects the exact occurrence without touching tool output", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-content-search-unit-key="voice:item">needle and needle</div><div data-content-search-unit-key="promoted:inlineMarkdown">inline needle</div><div data-tool-output>needle</div><div data-widget>needle</div>`;
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
