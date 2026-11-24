import { describe, expect, test } from "vite-plus/test";
import { changelogInlineTokens } from "./changelog-inline";

describe("changelogInlineTokens", () => {
  test("keeps code spans and strong runs apart from text", () => {
    expect(
      changelogInlineTokens("**Settings > General > Language** follows `LANG` by default."),
    ).toEqual([
      { kind: "strong", text: "Settings > General > Language" },
      { kind: "text", text: " follows " },
      { kind: "code", text: "LANG" },
      { kind: "text", text: " by default." },
    ]);
  });

  test("a code span keeps asterisks and shorter backtick runs as code", () => {
    expect(changelogInlineTokens("Rename `` a`b `` and `NODEX_**`.")).toEqual([
      { kind: "text", text: "Rename " },
      { kind: "code", text: "a`b" },
      { kind: "text", text: " and " },
      { kind: "code", text: "NODEX_**" },
      { kind: "text", text: "." },
    ]);
  });

  test("unmatched markers stay as written", () => {
    expect(changelogInlineTokens("Use ** and ` freely")).toEqual([
      { kind: "text", text: "Use ** and ` freely" },
    ]);
  });
});
