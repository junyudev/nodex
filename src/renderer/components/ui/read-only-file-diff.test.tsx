import { createElement, Fragment } from "react";
import { render } from "@testing-library/react";
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { ReadOnlyFileDiff } from "./read-only-file-diff";

const state = vi.hoisted(() => ({
  value: "unavailable" as "working" | "starting" | "unavailable",
  rendered: null as FileDiffMetadata | null,
}));
vi.mock("@/lib/source-highlight-pool", () => ({
  getSourceHighlightPool: () => null,
  primeSourceHighlight: vi.fn(),
  SourceHighlightPoolProvider: Fragment,
  useSourceHighlightPoolState: () => state.value,
}));
vi.mock("@/lib/diff-highlight-pool", () => ({
  getWordDiffHighlightPool: () => null,
  WordDiffHighlightPoolProvider: Fragment,
  useWordDiffHighlightPoolState: () => state.value,
}));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => {
    state.rendered = fileDiff;
    return createElement("div");
  },
}));
const diff = {
  ...parseDiffFromFile(
    { name: "a.html", contents: "old\n" },
    { name: "a.html", contents: "new\n" },
  ),
  lang: "html" as const,
  deletionLines: ["a".repeat(40_000)],
  additionLines: ["b".repeat(40_000)],
};
beforeEach(() => {
  state.value = "unavailable";
  state.rendered = null;
});

describe("read-only diff fallback", () => {
  test.each(["none", "word-alt"] as const)(
    "counts both sides without a working %s pool",
    (lineDiffType) => {
      render(<ReadOnlyFileDiff fileDiff={diff} options={{ lineDiffType }} />);
      expect(state.rendered?.lang).toBe("text");
    },
  );

  test("restores the language and a distinct cache key only once workers are ready", () => {
    state.value = "starting";
    const view = render(<ReadOnlyFileDiff fileDiff={diff} />);
    const plainKey = state.rendered?.cacheKey;
    expect(state.rendered?.lang).toBe("text");
    state.value = "working";
    view.rerender(<ReadOnlyFileDiff fileDiff={diff} />);
    expect(state.rendered?.lang).toBe("html");
    expect(state.rendered?.cacheKey).not.toBe(plainKey);
  });

  test("retains syntax for a small diff without workers", () => {
    render(
      <ReadOnlyFileDiff
        fileDiff={{ ...diff, deletionLines: ["old\n"], additionLines: ["new\n"] }}
      />,
    );
    expect(state.rendered?.lang).toBe("html");
  });
});
