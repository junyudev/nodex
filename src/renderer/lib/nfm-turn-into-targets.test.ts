import { describe, expect, test } from "vite-plus/test";

import { applyLocalNfmTurnInto, NFM_TURN_INTO_DEFINITIONS } from "./nfm-turn-into-targets";

describe("NFM Turn into target catalog", () => {
  test("exposes the complete lossless target matrix with one typed intent per menu item", () => {
    expect(NFM_TURN_INTO_DEFINITIONS).toHaveLength(16);
    expect(new Set(NFM_TURN_INTO_DEFINITIONS.map((item) => item.key)).size).toBe(16);
    expect(
      NFM_TURN_INTO_DEFINITIONS.filter((item) => item.target.kind === "heading").map((item) => ({
        level: item.target.kind === "heading" ? item.target.level : null,
        toggleable: item.target.kind === "heading" ? item.target.toggleable : null,
      })),
    ).toEqual([
      { level: "one", toggleable: false },
      { level: "two", toggleable: false },
      { level: "three", toggleable: false },
      { level: "one", toggleable: true },
      { level: "two", toggleable: true },
      { level: "three", toggleable: true },
    ]);
    expect(
      NFM_TURN_INTO_DEFINITIONS.map((item) => item.target.kind).filter(
        (kind) => kind !== "heading",
      ),
    ).toEqual([
      "paragraph",
      "bulleted_list",
      "numbered_list",
      "todo_list",
      "toggle_list",
      "quote",
      "callout",
      "prompt",
      "code",
      "equation",
    ]);
  });

  test("turns an ordinary selection inside one editor transaction", () => {
    const calls: string[] = [];
    const editor = {
      transact: (callback: () => void) => {
        calls.push("begin");
        callback();
        calls.push("commit");
      },
      updateBlock: (block: unknown) => {
        calls.push(`update:${String(block)}`);
      },
    };

    applyLocalNfmTurnInto(editor, ["one", "two"], { type: "toggleListItem" });

    expect(calls).toEqual(["begin", "update:one", "update:two", "commit"]);
  });
});
