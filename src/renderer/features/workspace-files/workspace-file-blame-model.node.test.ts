import { describe, expect, test } from "vite-plus/test";
import type { GitReviewBlameLine } from "../../../shared/types";
import {
  formatWorkspaceFileActiveLineBlame,
  formatWorkspaceFileBlameDate,
} from "./workspace-file-blame-model";

const line: GitReviewBlameLine = {
  line: 1,
  commitSha: "0123456789abcdef".repeat(2) + "01234567",
  author: "Full Author Name",
  authorTime: 1_700_000_000,
  summary: "Fix file (#42)",
};

describe("workspace file blame", () => {
  test("formats editable active-line blame with medium local dates", () => {
    const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
      line.authorTime! * 1_000,
    );
    expect(formatWorkspaceFileActiveLineBlame(line, "en-US")).toBe(
      `Full Author Name · Fix file (#42) · 01234567 · ${date}`,
    );
  });

  test("omits the label for uncommitted lines and lines without an author", () => {
    expect(
      formatWorkspaceFileActiveLineBlame({ ...line, commitSha: "0".repeat(40) }, "en-US"),
    ).toBe(null);
    expect(formatWorkspaceFileActiveLineBlame({ ...line, author: null }, "en-US")).toBe(null);
    expect(formatWorkspaceFileActiveLineBlame({ ...line, authorTime: null }, "en-US")).toBe(
      "Full Author Name · Fix file (#42) · 01234567",
    );
  });

  test("formats author times as UTC calendar days", () => {
    expect(formatWorkspaceFileBlameDate(1_700_000_000)).toBe("2023-11-14");
    expect(formatWorkspaceFileBlameDate(null)).toBe(null);
  });
});
