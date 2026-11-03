import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { ComposerNotice } from "../../thread-stage-types";
import { ComposerNoticeRail } from "./composer-notice-rail";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function renderNotice(notice: ComposerNotice) {
  return render(
    <NodexTooltipProvider delay={0}>
      <ComposerNoticeRail notice={notice} placement="attached" />
    </NodexTooltipProvider>,
  );
}

describe("ComposerNoticeRail", () => {
  beforeEach(() => {
    vi.mocked(toast.danger).mockClear();
  });

  it("announces the condition with the Agent's explanation beside it", () => {
    renderNotice({
      key: "agent:codex:signed-out",
      tone: "warning",
      title: "Codex isn’t signed in",
      detail: "Run `codex login` and try again.",
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Codex isn’t signed inRun codex login and try again.");
    expect(screen.getByText("codex login").tagName).toBe("CODE");
  });

  it("runs one fix at a time and names it while it is pending", async () => {
    const signIn = deferred();
    renderNotice({
      key: "agent:codex:signed-out",
      tone: "warning",
      title: "Codex isn’t signed in",
      actions: [
        { label: "Sign in", pendingLabel: "Opening…", run: () => signIn.promise },
        { label: "Check again", pendingLabel: "Checking…", run: vi.fn() },
      ],
    });

    await act(async () => {
      screen.getByRole("button", { name: "Sign in" }).click();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Opening…" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Check again" })).toHaveProperty("disabled", true);

    await act(async () => {
      signIn.resolve();
      await signIn.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check again" })).toHaveProperty("disabled", false),
    );
    expect(toast.danger).not.toHaveBeenCalled();
  });

  it("keeps the notice and toasts why a fix failed", async () => {
    const retry = deferred();
    renderNotice({
      key: "worktree-preparation:run-1",
      tone: "danger",
      title: "Couldn’t prepare the worktree",
      actions: [{ label: "Retry", pendingLabel: "Retrying…", run: () => retry.promise }],
    });

    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
      retry.reject(new Error("The branch is checked out elsewhere"));
      await retry.promise.catch(() => {});
    });

    await waitFor(() =>
      expect(toast.danger).toHaveBeenCalledWith("Couldn’t prepare the worktree", {
        description: "The branch is checked out elsewhere",
      }),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("status").textContent).toContain("Couldn’t prepare the worktree");
  });
});
