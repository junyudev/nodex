import { describe, expect, test } from "vite-plus/test";
import { normalizeWorkspaceFilesTabState } from "./workspace-file-types";

describe("normalizeWorkspaceFilesTabState", () => {
  test("keeps only serializable presentation state and recoverable drafts", () => {
    expect(
      normalizeWorkspaceFilesTabState({
        richView: false,
        treeVisible: false,
        treeWidth: 320,
        wordWrap: false,
        draft: {
          path: "/repo/index.ts",
          content: "local",
          baseMtimeMs: 1,
          updatedAt: "2026-07-27T00:00:00.000Z",
        },
        runtimeEditor: { unsafe: true },
      }),
    ).toEqual({
      richView: false,
      treeVisible: false,
      treeWidth: 320,
      wordWrap: false,
      draft: {
        path: "/repo/index.ts",
        content: "local",
        baseMtimeMs: 1,
        updatedAt: "2026-07-27T00:00:00.000Z",
      },
    });
    expect(normalizeWorkspaceFilesTabState("invalid")).toEqual({});
  });

  test("preserves a bounded one-shot reveal location and rejects invalid values", () => {
    expect(
      normalizeWorkspaceFilesTabState({
        pendingReveal: {
          line: 12,
          column: 3,
          endLine: 14,
          endColumn: 2,
        },
      }),
    ).toEqual({
      pendingReveal: {
        line: 12,
        column: 3,
        endLine: 14,
        endColumn: 2,
      },
    });
    expect(
      normalizeWorkspaceFilesTabState({
        pendingReveal: { line: 0, column: -1 },
      }),
    ).toEqual({});
    expect(
      normalizeWorkspaceFilesTabState({
        pendingReveal: { column: 3 },
      }),
    ).toEqual({});
    expect(
      normalizeWorkspaceFilesTabState({
        pendingReveal: { line: 14, endLine: 12 },
      }),
    ).toEqual({});
    expect(
      normalizeWorkspaceFilesTabState({
        pendingReveal: { line: 14, endColumn: 3 },
      }),
    ).toEqual({});
  });
});
