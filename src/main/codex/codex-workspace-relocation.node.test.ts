import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyManagedWorktreeRoot } from "./codex-managed-worktree-allocation";
import type { CodexThreadExecutionLocation } from "./codex-thread-handoff-journal";
import { planWorkspaceRelocation } from "./codex-workspace-relocation";

describe("legacy Runtime worktree locations", () => {
  it.each([
    ["/previous/worktrees/ab12/repo/packages/app", "/previous/worktrees/ab12/repo"],
    ["/previous/worktrees/aa0123456789/repo/ab12/pkg", "/previous/worktrees/aa0123456789/repo"],
    ["/previous/worktrees/261001-2215-deadbeef/src", "/previous/worktrees/261001-2215-deadbeef"],
    ["/configured/ab12/repo", null],
    ["/configured/ab12/repo/ab12/packages/app", null],
    ["/unrelated/folder", null],
    // A hex-like folder above the managed root, such as a home folder, is not the allocation.
    ["/Users/cafe/.nodex/worktrees/ab12/repo/src", "/Users/cafe/.nodex/worktrees/ab12/repo"],
    // Without a checkout named after the Project, the closest allocation wins.
    ["/Users/cafe/worktrees/ab12/renamed/src", "/Users/cafe/worktrees/ab12/renamed"],
  ] as const)("classifies %s without a filesystem probe", (cwd, expected) => {
    expect(legacyManagedWorktreeRoot(cwd, ["/configured/ab12/repo"])).toBe(expected);
  });
});

describe("relocation into a Project folder", () => {
  it("maps a nested cwd against the managed checkout and keeps independent roots in order", () => {
    const worktree = path.resolve("/old/worktrees/ab12/repo");
    const checkout = path.resolve("/repo");
    const cwd = path.join(worktree, "packages", "app");
    const additional = path.join(worktree, "shared");
    const source: CodexThreadExecutionLocation = {
      hostId: "local",
      cwd,
      workspaceRoots: [cwd, "/ext/z", worktree, additional, checkout, "/ext/a"],
      managedWorktreePath: worktree,
      projectId: "project",
      projectlessOutputDirectory: null,
      projectlessWorkspaceBrowserRoot: null,
    };
    expect(planWorkspaceRelocation(source, checkout)).toEqual({
      mappedCwd: path.join(checkout, "packages", "app"),
      additionalRoots: ["/ext/z", additional, "/ext/a"],
    });
    expect(
      planWorkspaceRelocation({ ...source, cwd: path.resolve("/other") }, checkout).mappedCwd,
    ).toBe(checkout);
  });
});
