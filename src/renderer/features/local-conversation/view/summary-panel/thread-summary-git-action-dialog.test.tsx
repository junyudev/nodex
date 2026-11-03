import { useState } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import type { GitActionStatusResult } from "@/lib/types";
import { render } from "@/test/dom";
import { threadSummaryGitOperations } from "../../thread-summary-git-operations";
import { ThreadSummaryGitActionDialog } from "./thread-summary-git-action-dialog";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
vi.mock("../../thread-summary-git-operations", () => ({
  threadSummaryGitOperations: {
    readStatus: vi.fn(),
    generateCommitMessage: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
  },
}));

const status: GitActionStatusResult = {
  cwd: "/repo",
  isGitRepository: true,
  currentBranch: "feature",
  defaultBranch: "main",
  upstreamBranch: "origin/feature",
  remotes: ["origin"],
  hasHeadCommit: true,
  hasStagedChanges: true,
  hasUnstagedChanges: false,
  hasUntrackedFiles: false,
  hasUncommittedChanges: true,
  commitsAhead: 1,
  canCommit: true,
  canPush: true,
  pushNeedsUpstream: false,
  errorMessage: null,
};

function Dialog({ mode }: { mode: "commit" | "push" }) {
  const [open, setOpen] = useState(true);
  return (
    <ThreadSummaryGitActionDialog
      open={open}
      cwd="/repo"
      initialMode={mode}
      onOpenChange={setOpen}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(threadSummaryGitOperations.readStatus).mockResolvedValue(status);
  vi.mocked(threadSummaryGitOperations.generateCommitMessage).mockResolvedValue({
    cwd: "/repo",
    status: "success",
    message: "Save changes",
    stderr: "",
    errorMessage: null,
  });
  vi.mocked(threadSummaryGitOperations.commit).mockResolvedValue({
    cwd: "/repo",
    status: "success",
    branch: "feature",
    stdout: "",
    stderr: "",
    errorMessage: null,
  });
});

describe("ThreadSummaryGitActionDialog failures", () => {
  test.each([
    ["generation", "commit", "Commit", "Couldn’t generate a commit message"],
    ["commit", "commit", "Commit", "Couldn’t commit changes"],
    ["push", "push", "Push", "Couldn’t push changes"],
    ["push", "commit", "Commit and push", "Couldn’t push changes"],
  ] as const)(
    "reports a rejected %s operation after %s closes",
    async (operation, mode, action, title) => {
      const cause = new Error(
        "Error invoking remote method 'git:action': Error: Repository is read-only",
      );
      const run =
        operation === "generation"
          ? threadSummaryGitOperations.generateCommitMessage
          : threadSummaryGitOperations[operation];
      vi.mocked(run).mockRejectedValueOnce(cause);
      const view = render(<Dialog mode={mode} />);
      const button = await view.findByRole("button", { name: action });
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(toast.danger).toHaveBeenCalledExactlyOnceWith(title, {
          description: "Repository is read-only",
        }),
      );
      expect(view.queryByRole("dialog")).toBeNull();
    },
  );

  test("reports structured Git stderr as the reason after the commit dialog closes", async () => {
    vi.mocked(threadSummaryGitOperations.commit).mockResolvedValueOnce({
      cwd: "/repo",
      status: "error",
      branch: "feature",
      stdout: "",
      stderr: "  Commit hook rejected changes\n",
      errorMessage: null,
    });
    const view = render(<Dialog mode="commit" />);
    const button = await view.findByRole("button", { name: "Commit" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(toast.danger).toHaveBeenCalledExactlyOnceWith("Couldn’t commit changes", {
        description: "Commit hook rejected changes",
      }),
    );
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("keeps Git status read failures inline while the dialog is open", async () => {
    vi.mocked(threadSummaryGitOperations.readStatus).mockRejectedValueOnce(
      new Error("Repository is unavailable"),
    );
    const view = render(<Dialog mode="commit" />);
    expect(await view.findByText("Repository is unavailable")).toBeTruthy();
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(toast.danger).not.toHaveBeenCalled();
  });
});
