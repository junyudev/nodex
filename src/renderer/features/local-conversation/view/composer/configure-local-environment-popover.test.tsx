import { useState } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { openNodexMenu, settleAsyncRender } from "@/test/dom";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import type { NewChatStartInSelectorModel } from "../../thread-stage-types";
import { ConfigureLocalEnvironmentPopover } from "./configure-local-environment-popover";

vi.mock("../../composer-git-context", () => ({
  loadComposerWorkingTreeChanges: async () => true,
}));

const BRANCH_STATE = {
  currentBranch: "main",
  defaultBranch: "main",
  branches: ["main", "feature/local"],
  remoteBranchRefs: ["refs/remotes/origin/feature/remote"],
};
const CONFIG_PATH = ".codex/environments/environment.toml";
const MODEL: NewChatStartInSelectorModel = {
  target: { runInTarget: "localProject" },
  disabled: false,
  worktreeAvailable: true,
  environmentAvailable: true,
  environments: [
    {
      configPath: CONFIG_PATH,
      fileName: "environment.toml",
      state: "success",
      exists: true,
      name: "Development",
      hasSetupScript: true,
      hasCleanupScript: false,
      actionCount: 0,
      parseErrorMessage: null,
      readErrorMessage: null,
      tooLargeMessage: null,
      environment: null,
    },
  ],
  environmentsLoading: false,
  environmentsError: false,
  selectedEnvironmentPath: CONFIG_PATH,
  defaultEnvironmentPath: CONFIG_PATH,
  environmentNeedsAttention: false,
  environmentRepairConfigPath: null,
  repositoryName: "nodex",
};

async function press(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
  await settleAsyncRender();
}
async function escape(element: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(element, { key: "Escape" });
    await Promise.resolve();
  });
  await settleAsyncRender();
}

function setup(overrides: Partial<NewChatStartInSelectorModel> = {}) {
  const checkout = vi.fn(async (_branch: string) => true);
  const create = vi.fn(async (_branch: string) => true);
  const changeTarget = vi.fn();
  const changeEnvironment = vi.fn();
  const refresh = vi.fn(async () => {});
  const settings = vi.fn();
  function Harness() {
    const [model, setModel] = useState({ ...MODEL, ...overrides });
    const [state, setState] = useState(BRANCH_STATE);
    return (
      <NodexTooltipProvider>
        <ConfigureLocalEnvironmentPopover
          model={model}
          actions={{
            onNewThreadStartInTargetChange: (target) => {
              changeTarget(target);
              setModel((current) => ({ ...current, target }));
            },
            onNewThreadStartInEnvironmentChange: (selectedEnvironmentPath) => {
              changeEnvironment(selectedEnvironmentPath);
              setModel((current) => ({ ...current, selectedEnvironmentPath }));
            },
            onRefreshNewThreadStartInEnvironments: refresh,
            onOpenNewThreadLocalEnvironmentsSettings: settings,
          }}
          cwd="/repo"
          branchState={state}
          branchBusy={false}
          branchLoading={false}
          branchError={false}
          startingState={
            model.target.worktreeStartingState ?? { type: "branch", branchName: "main" }
          }
          worktreeAvailable
          onRefreshBranches={refresh}
          onCheckoutBranch={async (branch) => {
            const result = await checkout(branch);
            if (result) setState((current) => ({ ...current, currentBranch: branch }));
            return result;
          }}
          onCreateBranch={async (branch) => {
            const result = await create(branch);
            if (result)
              setState((current) => ({
                ...current,
                currentBranch: branch,
                branches: [...current.branches, branch],
              }));
            return result;
          }}
        />
      </NodexTooltipProvider>
    );
  }
  const view = render(<Harness />);
  return { view, checkout, create, changeTarget, changeEnvironment, refresh, settings };
}

describe("Composer local environment configuration", () => {
  test("keeps settings open while toggling worktrees and makes Environment available only for a worktree", async () => {
    const { view, changeTarget } = setup();
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    expect(
      view
        .getByRole("menuitem", { name: "Environment: No environment" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await press(view.getByRole("switch", { name: "New worktree" }));
    expect(view.getByRole("switch", { name: "New worktree" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      view
        .getByRole("menuitem", { name: "Environment: Development" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    expect(changeTarget).toHaveBeenCalledWith({ runInTarget: "newWorktree" });
    await press(view.getByRole("switch", { name: "New worktree" }));
    expect(
      view
        .getByRole("menuitem", { name: "Environment: No environment" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  test("chooses an exact worktree starting ref without checkout, then restores Branch focus", async () => {
    const { view, checkout, changeTarget } = setup({ target: { runInTarget: "newWorktree" } });
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    await press(view.getByRole("menuitem", { name: "Branch: main" }));
    await press(await view.findByRole("menuitem", { name: "origin/feature/remote" }));
    expect(changeTarget).toHaveBeenCalledWith({
      runInTarget: "newWorktree",
      worktreeStartingState: {
        type: "branch",
        branchName: "origin/feature/remote",
        remoteRef: "refs/remotes/origin/feature/remote",
      },
    });
    expect(checkout).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("menuitem", { name: "Branch: origin/feature/remote" }),
      ),
    );
  });

  test("returns from Environment on selection or Escape and resets search before reopening", async () => {
    const { view, changeEnvironment } = setup({ target: { runInTarget: "newWorktree" } });
    const trigger = view.getByRole("button", { name: "Configure local environment" });
    await openNodexMenu(trigger);
    await press(view.getByRole("menuitem", { name: "Environment: Development" }));
    await press(await view.findByRole("menuitem", { name: "Work without environment" }));
    expect(changeEnvironment).toHaveBeenCalledWith(null);
    const row = view.getByRole("menuitem", { name: "Environment: No environment" });
    await waitFor(() => expect(document.activeElement).toBe(row));
    await press(row);
    const search = await view.findByRole("textbox", { name: "Search environments" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "missing" } });
      await Promise.resolve();
    });
    await escape(search);
    expect(view.queryByRole("textbox", { name: "Search environments" })).toBeNull();
    await press(view.getByRole("menuitem", { name: "Environment: No environment" }));
    expect(
      ((await view.findByRole("textbox", { name: "Search environments" })) as HTMLInputElement)
        .value,
    ).toBe("");
    await escape(view.getByRole("textbox", { name: "Search environments" }));
    await escape(view.getByRole("menuitem", { name: "Environment: No environment" }));
    await waitFor(() => expect(view.queryByRole("switch", { name: "New worktree" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  test("checks out a local branch through a nested menu without dismissing configuration", async () => {
    const { view, checkout } = setup();
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    await openNodexMenu(view.getByRole("menuitem", { name: "Branch: main" }));
    await press(await view.findByRole("menuitem", { name: "feature/local" }));
    expect(checkout).toHaveBeenCalledWith("feature/local");
    expect(view.getByRole("switch", { name: "New worktree" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Branch: feature/local" })).toBeTruthy();
    expect(view.queryByRole("textbox", { name: "Search branches" })).toBeNull();
  });

  test("retains Environment repair path and opens its settings", async () => {
    const { view, settings } = setup({
      target: { runInTarget: "newWorktree" },
      environmentNeedsAttention: true,
      environmentRepairConfigPath: ".codex/environments/broken.toml",
    });
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    await press(view.getByRole("menuitem", { name: "Environment: Needs attention" }));
    await press(await view.findByRole("menuitem", { name: "Environment settings" }));
    expect(settings).toHaveBeenCalledWith(".codex/environments/broken.toml");
    expect(view.queryByRole("switch", { name: "New worktree" })).toBeNull();
  });
  test("keeps the local Branch row in settings keyboard navigation", async () => {
    const { view } = setup();
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    const toggle = view.getByRole("switch", { name: "New worktree" });
    await act(async () => {
      toggle.focus();
      fireEvent.keyDown(toggle, { key: "ArrowDown" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Branch: main" })),
    );
  });

  test("navigates Environment results from search and between registered rows", async () => {
    const { view, changeEnvironment } = setup({ target: { runInTarget: "newWorktree" } });
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    await press(view.getByRole("menuitem", { name: "Environment: Development" }));
    const search = await view.findByRole("textbox", { name: "Search environments" });
    await act(async () => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      await Promise.resolve();
    });
    const noEnvironment = view.getByRole("menuitem", { name: "Work without environment" });
    expect(document.activeElement).toBe(noEnvironment);
    await act(async () => {
      fireEvent.keyDown(noEnvironment, { key: "ArrowDown" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Development" })),
    );
    await act(async () => {
      search.focus();
      fireEvent.change(search, { target: { value: "Development" } });
      fireEvent.keyDown(search, { key: "Enter", isComposing: true });
      fireEvent.keyDown(search, { key: "Escape", isComposing: true });
      await Promise.resolve();
    });
    expect(changeEnvironment).not.toHaveBeenCalled();
    expect(view.getByRole("textbox", { name: "Search environments" })).toBe(search);
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => expect(changeEnvironment).toHaveBeenCalledWith(CONFIG_PATH));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("menuitem", { name: "Environment: Development" }),
      ),
    );
  });

  test("waits for branch search to settle before keyboard selection and preserves IME input", async () => {
    const { view, changeTarget } = setup({ target: { runInTarget: "newWorktree" } });
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    await press(view.getByRole("menuitem", { name: "Branch: main" }));
    const search = await view.findByRole("textbox", { name: "Search repository branches" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "feature/remote" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
      await Promise.resolve();
    });
    expect(changeTarget).not.toHaveBeenCalled();
    await press(view.getByRole("menuitem", { name: "feature/local" }));
    expect(changeTarget).not.toHaveBeenCalled();
    await waitFor(() => expect(view.queryByRole("menuitem", { name: "main" })).toBeNull());
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter", isComposing: true });
      fireEvent.keyDown(search, { key: "Escape", isComposing: true });
      await Promise.resolve();
    });
    expect(changeTarget).not.toHaveBeenCalled();
    expect(view.getByRole("textbox", { name: "Search repository branches" })).toBe(search);
    await act(async () => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      view.getByRole("menuitem", { name: "origin/feature/remote" }),
    );
    await act(async () => {
      search.focus();
      fireEvent.keyDown(search, { key: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(changeTarget).toHaveBeenCalledWith({
        runInTarget: "newWorktree",
        worktreeStartingState: {
          type: "branch",
          branchName: "origin/feature/remote",
          remoteRef: "refs/remotes/origin/feature/remote",
        },
      }),
    );
  });

  test("can disable a selected worktree after its project loses worktree support", async () => {
    const { view, changeTarget } = setup({
      target: { runInTarget: "newWorktree" },
      worktreeAvailable: false,
    });
    await openNodexMenu(view.getByRole("button", { name: "Configure local environment" }));
    await press(view.getByRole("switch", { name: "New worktree" }));
    expect(changeTarget).toHaveBeenCalledWith({ runInTarget: "localProject" });
    expect(view.getByRole("switch", { name: "New worktree" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});
