import { describe, expect, test } from "bun:test";
import {
  EMPTY_BRANCH_SELECTOR_STATE,
  filterBranchSelectorBranches,
  isBranchSelectorMutationCurrent,
  parseBranchSelectorState,
  resolveBranchSelectorCwd,
} from "./branch-selector-state";

describe("branch selector state helpers", () => {
  test("prefers thread cwd over the project workspace path", () => {
    expect(resolveBranchSelectorCwd("/tmp/thread", "/tmp/project")).toBe("/tmp/thread");
  });

  test("falls back to the project workspace path when thread cwd is missing", () => {
    expect(resolveBranchSelectorCwd("   ", "/tmp/project")).toBe("/tmp/project");
  });

  test("normalizes successful branch payloads", () => {
    const state = parseBranchSelectorState({
      currentBranch: " main ",
      branches: ["main", " feature ", "main", "", 42],
    });

    expect(JSON.stringify(state)).toBe(JSON.stringify({
      currentBranch: "main",
      defaultBranch: null,
      branches: ["main", "feature"],
    }));
  });

  test("throws when the backend returns an error payload", () => {
    let message = "";

    try {
      parseBranchSelectorState({ error: "git failed" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("git failed");
  });

  test("returns the empty state when the payload is malformed", () => {
    expect(JSON.stringify(parseBranchSelectorState(null))).toBe(JSON.stringify(EMPTY_BRANCH_SELECTOR_STATE));
  });

  test("filters branches case-insensitively", () => {
    expect(JSON.stringify(filterBranchSelectorBranches(["main", "feature/login", "release"], "LOG"))).toBe(
      JSON.stringify(["feature/login"]),
    );
  });

  test("only applies branch mutation results for the active request and cwd", () => {
    expect(
      isBranchSelectorMutationCurrent({
        activeRequestId: 3,
        requestId: 3,
        activeCwd: "/tmp/repo",
        requestedCwd: "/tmp/repo",
      }),
    ).toBeTrue();

    expect(
      isBranchSelectorMutationCurrent({
        activeRequestId: 4,
        requestId: 3,
        activeCwd: "/tmp/repo",
        requestedCwd: "/tmp/repo",
      }),
    ).toBeFalse();

    expect(
      isBranchSelectorMutationCurrent({
        activeRequestId: 3,
        requestId: 3,
        activeCwd: "/tmp/other",
        requestedCwd: "/tmp/repo",
      }),
    ).toBeFalse();
  });
});
