import { describe, expect, test } from "bun:test";
import { resolveFindShortcutSeedQuery } from "./find-shortcut-seed";

describe("resolveFindShortcutSeedQuery", () => {
  test("returns empty string when editor state is missing", () => {
    expect(resolveFindShortcutSeedQuery(undefined)).toBe("");
  });

  test("returns empty string when selection is collapsed", () => {
    const seed = resolveFindShortcutSeedQuery({
      prosemirrorState: {
        selection: { empty: true, from: 5, to: 5 },
        doc: { textBetween: () => "ignored" },
      },
    });

    expect(seed).toBe("");
  });

  test("returns trimmed selected text and uses spaces for block boundaries", () => {
    const calls: Array<[number, number, string | undefined]> = [];
    const seed = resolveFindShortcutSeedQuery({
      prosemirrorState: {
        selection: { empty: false, from: 3, to: 18 },
        doc: {
          textBetween: (from, to, blockSeparator) => {
            calls.push([from, to, blockSeparator]);
            return "  selected text  ";
          },
        },
      },
    });

    expect(seed).toBe("selected text");
    expect(JSON.stringify(calls)).toBe(JSON.stringify([[3, 18, " "]]));
  });
});
