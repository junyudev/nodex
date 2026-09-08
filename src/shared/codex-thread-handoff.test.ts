import { describe, expect, test } from "vite-plus/test";
import { resolveCodexThreadHandoffStepLabel } from "./codex-thread-handoff";

const context = {
  direction: "local-to-worktree" as const,
  localBranch: "LocalCase",
  sourceBranch: "SourceCase",
  worktreeBranch: "WorktreeCase",
};

describe("Handoff step presentation", () => {
  test("uses the destination's branch and falls back to the source branch", () => {
    expect(resolveCodexThreadHandoffStepLabel("checkout-local-branch", context)).toBe(
      "Checking out LocalCase locally",
    );
    expect(resolveCodexThreadHandoffStepLabel("checkout-worktree-branch", context)).toBe(
      "Checking out WorktreeCase in worktree",
    );
    expect(
      resolveCodexThreadHandoffStepLabel("checkout-worktree-branch", {
        ...context,
        worktreeBranch: null,
      }),
    ).toBe("Checking out SourceCase in worktree");
    expect(
      resolveCodexThreadHandoffStepLabel("checkout-local-branch", {
        ...context,
        localBranch: null,
      }),
    ).toBe("Checking out SourceCase locally");
  });

  test.each([
    ["local-to-worktree", "Moving chat to worktree"],
    ["worktree-to-local", "Moving chat to local"],
    ["cross-host", "Moving chat to the destination worktree"],
  ] as const)("describes the destination for %s", (direction, label) => {
    expect(resolveCodexThreadHandoffStepLabel("switching-thread", { ...context, direction })).toBe(
      label,
    );
  });
});
