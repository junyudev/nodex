import { fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { ManagedWorktreeRestoreBanner } from "./managed-worktree-restore-banner";

describe("ManagedWorktreeRestoreBanner", () => {
  test("stays absent for available workspaces", () => {
    const view = render(<ManagedWorktreeRestoreBanner availability={{ state: "available" }} />);
    expect(view.queryByRole("status")).toBeNull();
  });

  test("offers the exact restore action only for a recovery snapshot", () => {
    const onRestore = vi.fn();
    const view = render(
      <ManagedWorktreeRestoreBanner
        availability={{
          state: "restorable",
          repositoryPath: "/repo",
          snapshotRef: "refs/codex/snapshots/one",
        }}
        onRestore={onRestore}
      />,
    );
    expect(view.getByText("Worktree cleaned up")).toBeTruthy();
    expect(view.getByText("This chat's worktree was removed to save disk space")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Restore worktree" }));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  test("distinguishes a missing cwd from an inspection failure", () => {
    const gone = render(<ManagedWorktreeRestoreBanner availability={{ state: "gone" }} />);
    expect(gone.getByText("Current working directory missing")).toBeTruthy();
    expect(gone.queryByRole("button")).toBeNull();
    gone.unmount();

    const onRetry = vi.fn();
    const unavailable = render(
      <ManagedWorktreeRestoreBanner
        availability={{
          state: "unavailable",
          reason: "inspection-failed",
          message: "offline",
        }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(unavailable.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
