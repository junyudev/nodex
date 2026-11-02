import { expect, test } from "vite-plus/test";
import { resolveWorkbenchWorkspaceInsets } from "./workbench-shell-geometry";

test("Windows reserves the workspace header only for its content column", () => {
  expect(resolveWorkbenchWorkspaceInsets(true, true)).toEqual({
    workspaceTop: 0,
    contentTop: 44,
    surfaceTop: 0,
  });
});

test("a Windows full page has only the page-surface gutter", () => {
  expect(resolveWorkbenchWorkspaceInsets(true, false)).toEqual({
    workspaceTop: 0,
    contentTop: 8,
    surfaceTop: 8,
  });
});

test.each([true, false])(
  "macOS keeps its shared titlebar when a workspace header is %s",
  (header) => {
    expect(resolveWorkbenchWorkspaceInsets(false, header)).toEqual({
      workspaceTop: 44,
      contentTop: 0,
      surfaceTop: 44,
    });
  },
);
