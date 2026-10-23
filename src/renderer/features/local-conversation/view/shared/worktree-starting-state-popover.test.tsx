import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender } from "@/test/dom";
import { WorktreeStartingStatePopover } from "./worktree-starting-state-popover";

const BRANCH_STATE = {
  currentBranch: "main",
  defaultBranch: "main",
  branches: ["main", "feature/local"],
  remoteBranchRefs: ["refs/remotes/origin/feature/remote"],
};

async function openMenu(view: ReturnType<typeof render>): Promise<void> {
  await act(async () => {
    const trigger = view.getByLabelText("Select starting state");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settleAsyncRender();
  });
}

describe("worktree starting-state popover", () => {
  test("selects dirty working-tree and exact remote-ref descriptors without mutating Git", async () => {
    const selected: unknown[] = [];
    const view = render(
      <NodexTooltipProvider>
        <WorktreeStartingStatePopover
          cwd="/repo"
          state={BRANCH_STATE}
          startingState={{ type: "branch", branchName: "main" }}
          branchLoading={false}
          branchError={false}
          repositoryName="nodex"
          loadLocalChanges={async () => true}
          onRefresh={async () => {}}
          onChange={(value) => selected.push(value)}
        />
      </NodexTooltipProvider>,
    );

    await openMenu(view);
    await waitFor(() => expect(document.body.textContent).toContain("Local file state"));
    expect(document.body.textContent).toContain("with local code changes");
    expect(document.body.textContent).toContain("Local branches");
    expect(document.body.textContent).toContain("Remote branches");
    expect(view.getByLabelText("Search repository branches").getAttribute("placeholder")).toBe(
      "Search branches…",
    );

    await act(async () => {
      fireEvent.click(view.getByText("origin/feature/remote"));
      await settleAsyncRender();
    });
    expect(selected).toEqual([
      {
        type: "branch",
        branchName: "origin/feature/remote",
        remoteRef: "refs/remotes/origin/feature/remote",
      },
    ]);
  });

  test("shows branch loading failure and retries both status and branch queries", async () => {
    let refreshCount = 0;
    let statusCount = 0;
    const view = render(
      <NodexTooltipProvider>
        <WorktreeStartingStatePopover
          cwd="/repo"
          state={BRANCH_STATE}
          startingState={{ type: "branch", branchName: "main" }}
          branchLoading={false}
          branchError
          loadLocalChanges={async () => {
            statusCount += 1;
            return false;
          }}
          onRefresh={async () => {
            refreshCount += 1;
          }}
          onChange={() => undefined}
        />
      </NodexTooltipProvider>,
    );

    await openMenu(view);
    const retry = await view.findByRole("button", { name: "Retry loading branches" });
    await act(async () => {
      fireEvent.click(retry);
      await settleAsyncRender();
    });
    expect(refreshCount).toBeGreaterThanOrEqual(2);
    expect(statusCount).toBeGreaterThanOrEqual(2);
  });
});
