import { describe, expect, test } from "vite-plus/test";
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type { CodexWorktreeInitActivity } from "@/lib/codex-worktree-init-activity";
import { WorktreeInitActivityList } from "./worktree-init-activity-list";

function renderActivities(
  activities: readonly CodexWorktreeInitActivity[],
  actions: ReactNode = null,
) {
  return render(
    <TooltipProvider>
      <WorktreeInitActivityList activities={activities} actions={actions} />
    </TooltipProvider>,
  );
}

describe("WorktreeInitActivityList", () => {
  test("remounts the previous action target closed when a later activity appears", () => {
    const worktree: CodexWorktreeInitActivity = {
      id: "pending:1:worktree",
      kind: "worktree",
      status: "completed",
      outputText: "Worktree ready\n",
    };
    const setup: CodexWorktreeInitActivity = {
      id: "pending:1:setup",
      kind: "setup",
      status: "failed",
      outputText: "Setup failed\n",
    };
    const conversation: CodexWorktreeInitActivity = {
      id: "pending:1:conversation",
      kind: "conversation",
      status: "failed",
      outputText: "",
    };
    const view = renderActivities([worktree, setup], <button type="button">Retry</button>);

    expect(
      view.getByRole("button", { name: "Worktree created" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      view
        .getByRole("button", { name: "Failed to set up the environment" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    view.rerender(
      <TooltipProvider>
        <WorktreeInitActivityList
          activities={[worktree, setup, conversation]}
          actions={<button type="button">Retry</button>}
        />
      </TooltipProvider>,
    );

    expect(
      view
        .getByRole("button", { name: "Failed to set up the environment" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      view
        .getByRole("button", { name: "Failed to start the conversation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("keeps completed transcript activities collapsed and renders ANSI as safe text", () => {
    const view = renderActivities([
      {
        id: "item:worktree",
        kind: "worktree",
        status: "completed",
        outputText: "plain \u001b[31mred\u001b[0m\n",
      },
      {
        id: "item:setup",
        kind: "setup",
        status: "skipped",
        outputText: "No setup\n",
      },
    ]);

    expect(
      view.getByRole("button", { name: "Worktree created" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      view.getByRole("button", { name: "Environment setup skipped" }).getAttribute("aria-expanded"),
    ).toBe("false");
    const worktreeButton = view.getByRole("button", { name: "Worktree created" });
    expect(worktreeButton.parentElement?.nextElementSibling ?? null).toBe(null);
    expect((view.container.textContent ?? "").includes("plain red")).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Worktree created" }));
    expect(worktreeButton.parentElement?.nextElementSibling?.getAttribute("aria-hidden")).toBe(
      "false",
    );
    expect((view.container.textContent ?? "").includes("plain red")).toBe(true);
    expect((view.container.textContent ?? "").includes("\u001b")).toBe(false);
  });

  test("opens running output without actions and preserves a manual collapse while streaming", () => {
    const creating: CodexWorktreeInitActivity = {
      id: "pending:1:worktree",
      kind: "worktree",
      status: "running",
      outputText: "Preparing worktree\n",
    };
    const view = renderActivities([creating]);
    const toggle = view.getByRole("button", { name: "Creating a worktree" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <TooltipProvider>
        <WorktreeInitActivityList
          activities={[{ ...creating, outputText: "Preparing worktree\nApplying diff\n" }]}
        />
      </TooltipProvider>,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect((view.container.textContent ?? "").includes("Applying diff")).toBe(true);
  });

  test("renders a running conversation as shimmer text without disclosure or actions", () => {
    const view = renderActivities(
      [
        {
          id: "pending:1:conversation",
          kind: "conversation",
          status: "running",
          outputText: "",
        },
      ],
      <button type="button">Retry</button>,
    );

    expect(
      Boolean(
        view.getByText("Starting the conversation", {
          selector: ".loading-shimmer-pure-text",
        }),
      ),
    ).toBe(true);
    expect(view.queryByRole("button", { name: "Starting the conversation" })).toBe(null);
    expect(view.queryByRole("button", { name: "Retry" })).toBe(null);
    expect(Boolean(view.container.querySelector(".loading-shimmer-pure-text"))).toBe(true);
  });
});
