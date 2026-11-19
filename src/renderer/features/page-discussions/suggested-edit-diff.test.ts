import { describe, expect, it } from "vitest";
import { diffSuggestedEdit } from "./suggested-edit-diff";

describe("diffSuggestedEdit", () => {
  it("marks replaced words between unchanged text", () => {
    expect(
      diffSuggestedEdit("Pages doubled every week.", "Pages grew 2.4x in four weeks."),
    ).toEqual({
      kind: "segments",
      segments: [
        { kind: "equal", text: "Pages " },
        { kind: "delete", text: "doubled every week" },
        { kind: "insert", text: "grew 2.4x in four weeks" },
        { kind: "equal", text: "." },
      ],
    });
  });

  it("splits CJK text into words instead of replacing the whole sentence", () => {
    const diff = diffSuggestedEdit(
      "用到 Agent 的 Page 每周翻倍。",
      "用到 Agent 的 Page 在 4 周内涨到 2.4 倍。",
    );
    expect(diff.kind).toBe("segments");
    if (diff.kind !== "segments") return;
    expect(diff.segments[0]).toEqual({ kind: "equal", text: "用到 Agent 的 Page " });
    expect(diff.segments.at(-1)?.kind).toBe("equal");
    expect(diff.segments.at(-1)?.text.endsWith("。")).toBe(true);
    expect(diff.segments.some((segment) => segment.kind === "delete")).toBe(true);
  });

  it("returns one unchanged segment for identical text", () => {
    expect(diffSuggestedEdit("Same text", "Same text")).toEqual({
      kind: "segments",
      segments: [{ kind: "equal", text: "Same text" }],
    });
  });

  it("refuses texts beyond the comparison bound", () => {
    expect(diffSuggestedEdit("a ".repeat(6_000), "b ".repeat(6_000))).toEqual({
      kind: "too_large",
    });
  });
});
