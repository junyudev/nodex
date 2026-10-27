import { describe, expect, test } from "vite-plus/test";
import {
  buildWorkspaceFileDraftLineMap,
  workspaceFileSavedLineNumber,
} from "./workspace-file-draft-line-map";

const mapLines = (saved: string, draft: string) => {
  const ranges = buildWorkspaceFileDraftLineMap(saved, draft);
  return draft.split("\n").map((_, index) => workspaceFileSavedLineNumber(ranges, index + 1));
};

describe("draft line authorship", () => {
  test("maps unchanged lines across insertions, replacements and deletions", () => {
    expect(
      mapLines("first\nsecond\nthird\nfourth\nfifth", "inserted\nfirst\nreplaced\nthird\nfifth"),
    ).toEqual([null, 1, null, 3, 5]);
    expect(mapLines("a\nb\nc", "a\nc")).toEqual([1, 3]);
  });

  test("does not match whitespace edits or changed line endings", () => {
    expect(mapLines("one\ntwo\nthree", "one \ntwo\nthree")).toEqual([null, 2, 3]);
    expect(mapLines("one\r\ntwo\r\n", "one\ntwo\n")).toEqual([null, null, null]);
    expect(mapLines("one\ntwo\n", "one\ntwo")).toEqual([1, null]);
  });

  test("handles unchanged empty and terminal lines without inventing a match", () => {
    expect(mapLines("", "")).toEqual([1]);
    expect(mapLines("one\n", "one\n")).toEqual([1, 2]);
    expect(mapLines("", "new")).toEqual([null]);
    expect(mapLines("removed", "")).toEqual([null]);
    expect(workspaceFileSavedLineNumber(buildWorkspaceFileDraftLineMap("a", "a"), 2)).toBeNull();
    expect(workspaceFileSavedLineNumber([], 0)).toBeNull();
    expect(workspaceFileSavedLineNumber([], 1.5)).toBeNull();
  });

  test("enforces the UTF-16 character budget even for identical content", () => {
    const atLimit = "😀".repeat(131_072);
    expect(workspaceFileSavedLineNumber(buildWorkspaceFileDraftLineMap(atLimit, atLimit), 1)).toBe(
      1,
    );
    expect(buildWorkspaceFileDraftLineMap(atLimit + "a", atLimit + "a")).toBeNull();
    expect(buildWorkspaceFileDraftLineMap("a", atLimit + "a")).toBeNull();
    expect(buildWorkspaceFileDraftLineMap(atLimit + "a", "a")).toBeNull();
  });

  test("allows edit length 512 and suppresses all mapping beyond it", () => {
    const inserted = Array.from({ length: 512 }, (_, index) => `new ${index}\n`).join("");
    expect(
      workspaceFileSavedLineNumber(buildWorkspaceFileDraftLineMap("kept", inserted + "kept"), 513),
    ).toBe(1);
    expect(buildWorkspaceFileDraftLineMap("kept", inserted + "extra\nkept")).toBeNull();
    expect(buildWorkspaceFileDraftLineMap(inserted + "extra\nkept", "kept")).toBeNull();
  });
});
