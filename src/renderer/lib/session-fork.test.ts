import { describe, expect, test } from "vite-plus/test";
import { sessionForkDestinations } from "./session-fork";

describe("Session fork destinations", () => {
  test("keeps an ordinary fork available outside Git and labels a managed source accurately", () => {
    expect(sessionForkDestinations({ isWorktree: false, canCreateWorktree: false })).toEqual([
      { target: "local", label: "Fork chat", iconKey: "local" },
    ]);
    expect(sessionForkDestinations({ isWorktree: true, canCreateWorktree: false })).toEqual([
      { target: "local", label: "Fork chat in same worktree", iconKey: "fork" },
    ]);
  });

  test("offers a new worktree only when the source supports it", () => {
    expect(sessionForkDestinations({ isWorktree: true, canCreateWorktree: true })).toEqual([
      { target: "local", label: "Fork chat in same worktree", iconKey: "fork" },
      { target: "newWorktree", label: "Fork chat in new worktree", iconKey: "worktree" },
    ]);
  });
});
