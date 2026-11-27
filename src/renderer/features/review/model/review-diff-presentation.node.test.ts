import { describe, expect, test } from "vite-plus/test";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { expandPartialDiffMetadata } from "./expand-partial-diff-metadata";
import {
  isReviewDiffExpanded,
  reconcileReviewDiffExpansionSource,
  setAllReviewDiffsExpanded,
  setReviewDiffExpanded,
  toggleReviewDiffExpanded,
  type ReviewDiffExpansionState,
} from "./review-diff-expansion";
import {
  buildReviewFileContextMenu,
  reviewFileTargetPreferredOpener,
  type ReviewFileContextMenuInput,
} from "./review-file-context-menu";

describe("expand partial diff metadata", () => {
  const PATCH = [
    "diff --git a/example.ts b/example.ts",
    "index 1111111..2222222 100644",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -2,3 +2,3 @@",
    " a",
    "-b",
    "+B",
    " c",
    "@@ -6,2 +6,2 @@",
    " d",
    "-tail",
    "+tail2",
    "",
  ].join("\n");

  const DELETION_LINES = ["zero\n", "a\n", "b\n", "c\n", "middle\n", "d\n", "tail\n", "after\n"];
  const ADDITION_LINES = ["zero\n", "a\n", "B\n", "c\n", "middle\n", "d\n", "tail2\n", "after\n"];

  function parseMetadata(): FileDiffMetadata {
    const metadata = parsePatchFiles(PATCH).flatMap((patch) => patch.files)[0];
    if (!metadata) throw new Error("Expected the test patch to contain one file");
    return metadata;
  }

  describe("expandPartialDiffMetadata", () => {
    test("expands partial hunk indices without recomputing a full-file diff", () => {
      const metadata = parseMetadata();
      const result = expandPartialDiffMetadata(metadata, DELETION_LINES, ADDITION_LINES);

      expect(result).not.toBeNull();
      expect(result?.isPartial).toBe(false);
      expect(result?.deletionLines).toEqual(DELETION_LINES);
      expect(result?.additionLines).toEqual(ADDITION_LINES);
      expect(result?.deletionCharacterCount).toBe(DELETION_LINES.join("").length);
      expect(result?.additionCharacterCount).toBe(ADDITION_LINES.join("").length);
      expect(
        result?.hunks.map((hunk) => ({
          additionLineIndex: hunk.additionLineIndex,
          deletionLineIndex: hunk.deletionLineIndex,
          collapsedBefore: hunk.collapsedBefore,
          splitLineStart: hunk.splitLineStart,
          unifiedLineStart: hunk.unifiedLineStart,
        })),
      ).toEqual([
        {
          additionLineIndex: 1,
          deletionLineIndex: 1,
          collapsedBefore: 1,
          splitLineStart: 1,
          unifiedLineStart: 1,
        },
        {
          additionLineIndex: 5,
          deletionLineIndex: 5,
          collapsedBefore: 1,
          splitLineStart: 5,
          unifiedLineStart: 6,
        },
      ]);
      expect(result?.splitLineCount).toBe(8);
      expect(result?.unifiedLineCount).toBe(10);
    });

    test("changed full context gets a distinct highlight despite unchanged patch IDs", () => {
      const metadata = parseMetadata();
      const first = expandPartialDiffMetadata(metadata, DELETION_LINES, ADDITION_LINES);
      const second = expandPartialDiffMetadata(
        metadata,
        ["other context\n", ...DELETION_LINES.slice(1)],
        ["other context\n", ...ADDITION_LINES.slice(1)],
      );
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.cacheKey).not.toBe(second?.cacheKey);
    });

    test("rejects mismatched collapsed and trailing context", () => {
      const metadata = parseMetadata();

      expect(
        expandPartialDiffMetadata(metadata, DELETION_LINES, [
          "different",
          ...ADDITION_LINES.slice(1),
        ]),
      ).toBeNull();
      expect(
        expandPartialDiffMetadata(metadata, DELETION_LINES, [
          ...ADDITION_LINES.slice(0, -1),
          "different-tail\n",
        ]),
      ).toBeNull();
      expect(
        expandPartialDiffMetadata(metadata, [...DELETION_LINES, "old-only"], ADDITION_LINES),
      ).toBeNull();
    });

    test("rejects partial hunk content that does not match the full files", () => {
      const metadata = parseMetadata();
      const changedDeletionLines = [...DELETION_LINES];
      changedDeletionLines[2] = "not-the-deleted-line";

      expect(expandPartialDiffMetadata(metadata, changedDeletionLines, ADDITION_LINES)).toBeNull();
    });

    test("optionally ignores whitespace while validating context and hunks", () => {
      const metadata = parseMetadata();
      const whitespaceDeletionLines = DELETION_LINES.map((line) => `  ${line.trimEnd()}\t\n`);
      const whitespaceAdditionLines = ADDITION_LINES.map((line) => `${line.trimEnd()} \n`);

      expect(
        expandPartialDiffMetadata(metadata, whitespaceDeletionLines, whitespaceAdditionLines),
      ).toBeNull();
      expect(
        expandPartialDiffMetadata(metadata, whitespaceDeletionLines, whitespaceAdditionLines, {
          ignoreWhitespace: true,
        }),
      ).not.toBeNull();
    });
  });
});

describe("review diff expansion", () => {
  function buildExpansionState(
    overrides: Partial<ReviewDiffExpansionState> = {},
  ): ReviewDiffExpansionState {
    return {
      allDiffsExpanded: true,
      diffExpansionOverrides: [],
      diffExpansionSourceKey: "source:a",
      ...overrides,
    };
  }

  describe("Review diff expansion", () => {
    test("lets a file override the global expansion state without changing the bulk action", () => {
      const collapsed = setAllReviewDiffsExpanded(buildExpansionState(), false);
      const withOneExpanded = setReviewDiffExpanded(collapsed, "src/a.ts", true);

      expect(withOneExpanded.allDiffsExpanded).toBe(false);
      expect(isReviewDiffExpanded(withOneExpanded, "src/a.ts")).toBe(true);
      expect(isReviewDiffExpanded(withOneExpanded, "src/b.ts")).toBe(false);
      expect(toggleReviewDiffExpanded(withOneExpanded, "src/a.ts")).toEqual(collapsed);
    });

    test("makes newly arriving files inherit the current collapse-all state", () => {
      const collapsed = setAllReviewDiffsExpanded(buildExpansionState(), false);
      const reconciled = reconcileReviewDiffExpansionSource(
        collapsed,
        "source:a",
        new Set(["src/a.ts", "src/new.ts"]),
      );

      expect(isReviewDiffExpanded(reconciled, "src/a.ts")).toBe(false);
      expect(isReviewDiffExpanded(reconciled, "src/new.ts")).toBe(false);
    });

    test("supports intrinsically collapsed rows without changing the global action", () => {
      const state = buildExpansionState();
      const expandedDeletedFile = toggleReviewDiffExpanded(state, "src/deleted.ts", false);

      expect(isReviewDiffExpanded(state, "src/deleted.ts", false)).toBe(false);
      expect(expandedDeletedFile.allDiffsExpanded).toBe(true);
      expect(isReviewDiffExpanded(expandedDeletedFile, "src/deleted.ts", false)).toBe(true);
    });

    test("resets expansion on source changes and prunes overrides for removed files", () => {
      const state = buildExpansionState({
        allDiffsExpanded: false,
        diffExpansionOverrides: [
          { key: "src/kept.ts", expanded: true },
          { key: "src/removed.ts", expanded: true },
        ],
      });
      const pruned = reconcileReviewDiffExpansionSource(
        state,
        "source:a",
        new Set(["src/kept.ts"]),
      );
      const reset = reconcileReviewDiffExpansionSource(
        pruned,
        "source:b",
        new Set(["src/kept.ts"]),
      );

      expect(pruned.diffExpansionOverrides).toEqual([{ key: "src/kept.ts", expanded: true }]);
      expect(reset).toEqual({
        allDiffsExpanded: true,
        diffExpansionOverrides: [],
        diffExpansionSourceKey: "source:b",
      });
    });
  });
});

describe("review file context menu", () => {
  const fileContext: ReviewFileContextMenuInput = {
    canOpenFile: true,
    canOpenInNewTab: true,
    canRequestChanges: true,
    wrap: false,
    selectedText: "const value = 1;",
    relativePath: "src/example.ts",
    githubUrl: "https://github.com/example/project/blob/main/src/example.ts",
    primary: { id: "cursor", label: "Cursor", opener: "cursor" },
    alternatives: [{ id: "vscode", label: "VS Code", opener: "vscode" }],
  };

  describe("Review file context menu", () => {
    test("keeps selection and path actions beside file opening and line comments", () => {
      const items = buildReviewFileContextMenu(fileContext);
      expect(items.map((item) => (item.type === "separator" ? "separator" : item.label))).toEqual([
        "Open in new tab",
        "Open in Cursor",
        "Open with",
        "Open in GitHub",
        "separator",
        "Request changes",
        "separator",
        "Copy selection",
        "Copy path",
        "Copy relative path",
        "separator",
        "Enable word wrap",
      ]);
      expect(items.find((item) => item.id === "open-with")).toMatchObject({
        type: "submenu",
        submenu: [{ id: "open-target:vscode", label: "VS Code" }],
      });
    });

    test("omits Request changes for ineligible lines and only copies an existing selection", () => {
      const items = buildReviewFileContextMenu({
        ...fileContext,
        canRequestChanges: false,
        selectedText: "",
      });
      expect(items.some((item) => item.id === "copy-selection")).toBe(false);
      expect(items.some((item) => item.id === "request-changes")).toBe(false);
      expect(items.some((item) => item.id === "copy-path")).toBe(true);
    });

    test("remembers editor choices without promoting native viewers or terminals", () => {
      expect(reviewFileTargetPreferredOpener(fileContext.alternatives[0]!)).toBe("vscode");
      for (const opener of ["fileManager", "terminal", "iterm2", "ghostty", "warp"] as const) {
        expect(reviewFileTargetPreferredOpener({ id: opener, label: opener, opener })).toBeNull();
      }
      expect(reviewFileTargetPreferredOpener({ id: "default", label: "Default app" })).toBeNull();
      expect(
        reviewFileTargetPreferredOpener({
          id: "native",
          label: "Native app",
          appPath: "/Applications/Preview.app",
        }),
      ).toBeNull();
    });

    test("does not offer a new editable tab for a deleted file", () => {
      const items = buildReviewFileContextMenu({
        ...fileContext,
        canOpenInNewTab: false,
        githubUrl: null,
      });
      const submenu = items.find((item) => item.id === "open-with");
      if (submenu?.type !== "submenu")
        throw new Error("The deleted file has available external targets");
      expect(submenu.submenu.map((item) => item.id)).toEqual(["open-target:vscode"]);
      expect(items.some((item) => item.id === "open-in-new-tab")).toBe(false);
      expect(items.some((item) => item.id === "open-in-github")).toBe(false);
    });

    test("omits unsupported file targets without inserting empty menu sections", () => {
      const items = buildReviewFileContextMenu({
        ...fileContext,
        canOpenFile: false,
        relativePath: null,
        githubUrl: null,
        primary: null,
        alternatives: [],
      });
      expect(items.filter((item) => item.type !== "separator").map((item) => item.id)).toEqual([
        "request-changes",
        "copy-selection",
        "toggle-wrap",
      ]);
    });
  });
});
