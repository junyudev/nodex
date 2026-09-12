import { describe, expect, it } from "vite-plus/test";
import {
  mergeCodexAnchoredHistoryItems,
  mergeCodexCanonicalHistoryItems,
} from "./codex-history-item-merge";
import type { CodexCanonicalItem } from "./codex-conversation-state";

const answer = (id: string, text = id): Extract<CodexCanonicalItem, { type: "agentMessage" }> => ({
  type: "agentMessage",
  id,
  text,
  phase: "final_answer",
  memoryCitation: null,
  questions: null,
  delivery: null,
});

describe("history item merge", () => {
  it("places new items around resident anchors while retaining newer live values", () => {
    const resident = [
      { id: "b", value: "live" },
      { id: "d", value: "live" },
    ];
    const incoming = ["a", "b", "c", "d", "e"].map((id) => ({ id, value: "history" }));
    const merged = mergeCodexAnchoredHistoryItems(resident, incoming, (item) => item.id, "prepend");
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(merged[1]).toBe(resident[0]);
    expect(merged[3]).toBe(resident[1]);
  });

  it.each(["prepend", "append"] as const)(
    "%s preserves disjoint incoming occurrences",
    (direction) => {
      const result = mergeCodexAnchoredHistoryItems(
        ["resident"],
        ["a", "a", "b"],
        (item) => item,
        direction,
      );
      expect(result).toEqual(
        direction === "prepend" ? ["a", "a", "b", "resident"] : ["resident", "a", "a", "b"],
      );
    },
  );

  it("coalesces a renamed final answer into its existing identity and retains its citation", () => {
    const original = {
      ...answer("local", "same answer"),
      memoryCitation: { entries: [], threadIds: ["rollout"] },
    } as CodexCanonicalItem;
    const result = mergeCodexCanonicalHistoryItems(
      [original],
      [answer("persisted", "same answer")],
      "prepend",
    );
    expect(result.items).toEqual([original]);
    expect(result.aliases.get("persisted")).toBe("local");
  });

  it("applies a final-answer alias to every incoming occurrence", () => {
    const resident = answer("local", "same");
    const result = mergeCodexCanonicalHistoryItems(
      [resident],
      [answer("persisted", "same"), answer("persisted", "same")],
      "prepend",
    );
    expect(result.items).toEqual([resident]);
    expect(result.aliases.get("persisted")).toBe("local");
  });

  it("does not coalesce distinct final answers or commentary with matching text", () => {
    const original = answer("first", "same");
    const commentary = {
      ...answer("commentary", "same"),
      phase: "commentary",
    } as CodexCanonicalItem;
    const result = mergeCodexCanonicalHistoryItems(
      [original],
      [commentary, answer("second", "different")],
      "prepend",
    );
    expect(result.items.map((item) => item.id)).toEqual(["commentary", "second", "first"]);
    expect(result.aliases.size).toBe(0);
  });
});
