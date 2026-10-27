import { describe, expect, test } from "vite-plus/test";
import { workspaceFileChangedSections } from "./workspace-file-change-blocks";
import { workspaceFileEditorDiffFromContents } from "./workspace-file-editor-diff";

describe("editable diff documents", () => {
  test.each(["", "first\nsecond", "first\r\nsecond\r\n"])(
    "keeps unchanged text mountable: %j",
    (content) => {
      const diff = workspaceFileEditorDiffFromContents({
        path: "example.txt",
        oldContent: content,
        newContent: content,
      });
      expect(diff.hunks).toHaveLength(1);
      expect(diff.additionLines.join("")).toBe(content);
      expect(diff.deletionLines.join("")).toBe(content);
      expect(diff.unifiedLineCount).toBeGreaterThan(0);
      expect(workspaceFileChangedSections(diff)).toEqual([]);
    },
  );

  test("retains canonical changed blocks and rename paths", () => {
    const diff = workspaceFileEditorDiffFromContents({
      path: "new.txt",
      oldPath: "old.txt",
      oldContent: "a\nb\nc",
      newContent: "a\nnew\nc",
    });
    expect(diff.name).toBe("new.txt");
    expect(diff.prevName).toBe("old.txt");
    expect(workspaceFileChangedSections(diff)).toEqual([
      { type: "change", additions: 1, deletions: 1, additionLineIndex: 1, deletionLineIndex: 1 },
    ]);
  });
});
