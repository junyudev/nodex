import { expect, test } from "vite-plus/test";
import { resolveWorkspaceSearchContext } from "./workspace-search-context";

const input = {
  hostId: "remote",
  projectRoots: ["/repo", "/docs"],
  executionCwd: "/worktree",
  workspaceBrowserRoot: null,
  isWorktree: true,
};
test("a worktree replaces only the primary checkout while retaining secondary roots", () => {
  expect(resolveWorkspaceSearchContext(input)).toEqual({
    hostId: "remote",
    roots: ["/worktree", "/docs"],
    skillRoots: ["/worktree", "/docs"],
  });
});
test("file search collapses nested roots while skill config retains the execution cwd", () => {
  expect(
    resolveWorkspaceSearchContext({ ...input, isWorktree: false, executionCwd: "/repo/src" }),
  ).toEqual({
    hostId: "remote",
    roots: ["/repo", "/docs"],
    skillRoots: ["/repo/src", "/repo", "/docs"],
  });
});
test("projectless search uses its browser root", () => {
  expect(
    resolveWorkspaceSearchContext({
      ...input,
      projectRoots: [],
      isWorktree: false,
      workspaceBrowserRoot: "/outputs",
    })?.roots,
  ).toEqual(["/outputs"]);
});
