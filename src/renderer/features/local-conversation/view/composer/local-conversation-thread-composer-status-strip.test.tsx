import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { buildComposerShellFixture } from "@/test/composer-shell-fixture";
import { buildComposerActions } from "@/test/composer-actions-fixture";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { changeComposerBranch } from "../../composer-git-context";
import { ComposerContextRailSlot } from "../composer-context-rail";
import { ThreadComposerStatusStrip } from "./local-conversation-thread-composer-status-strip";
import type { ConfigureLocalEnvironmentPopover } from "./configure-local-environment-popover";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";

const branches = vi.hoisted(() => ({
  first: { currentBranch: "main", defaultBranch: "main", branches: ["main", "topic"] },
  second: { currentBranch: "other", defaultBranch: "other", branches: ["other"] },
  change: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
vi.mock("@/lib/use-git-branch-state", () => ({
  useGitBranchState: (cwd: string) => ({
    data: cwd === "/second" || cwd === "/other-project" ? branches.second : branches.first,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: async () => ({
      data: cwd === "/second" || cwd === "/other-project" ? branches.second : branches.first,
    }),
  }),
}));
vi.mock("../../composer-git-context", () => ({ changeComposerBranch: branches.change }));
vi.mock("./new-chat-location-selector", () => ({ NewChatLocationSelector: () => null }));
vi.mock("./configure-local-environment-popover", () => ({
  ConfigureLocalEnvironmentPopover: function BranchPicker({
    branchState,
    branchBusy,
    onCheckoutBranch,
    onCreateBranch,
  }: Parameters<typeof ConfigureLocalEnvironmentPopover>[0]) {
    return (
      <>
        <button disabled={branchBusy} onClick={() => void onCreateBranch("feature")}>
          Create branch
        </button>
        <output aria-label="Selected branch">{branchState.currentBranch}</output>
        <button disabled={branchBusy} onClick={() => void onCheckoutBranch("feature")}>
          Switch branch
        </button>
      </>
    );
  },
}));

function branchModel(cwd: string): ThreadFooterModel {
  return {
    isNewThreadTab: true,
    conversation: null,
    projectWorkspacePath: cwd,
    newThreadTarget: { sessionId: "draft" },
    newThreadStartInSelector: { target: { runInTarget: "localProject" } },
  } as ThreadFooterModel;
}

function strip(cwd = "/repo") {
  const model = {
    ...buildComposerShellFixture(),
    isNewThreadTab: true,
    conversation: null,
    projectWorkspacePath: cwd,
    newThreadTarget: { projectId: "project", projectName: "Project", sessionId: "session" },
    newThreadStartInSelector: {
      target: { runInTarget: "localProject" as const },
      disabled: false,
      worktreeAvailable: true,
      environments: [],
      environmentsLoading: false,
      environmentsError: false,
      selectedEnvironmentPath: null,
      defaultEnvironmentPath: null,
      environmentNeedsAttention: false,
      environmentRepairConfigPath: null,
    },
  };
  return (
    <NodexTooltipProvider>
      <ThreadComposerStatusStrip model={model} actions={buildComposerActions()} />
    </NodexTooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  branches.change.mockReset();
});

describe("new-chat branch action failures", () => {
  test.each([
    ["Switch branch", false, "Couldn’t switch branches"],
    ["Create branch", true, "Couldn’t create a branch"],
  ] as const)("reports %s and releases it for retry", async (action, create, title) => {
    vi.mocked(changeComposerBranch).mockRejectedValueOnce(new Error("Git is locked"));
    const view = render(strip());
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: action }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(toast.danger).toHaveBeenCalledExactlyOnceWith(title, { description: "Git is locked" }),
    );
    expect(changeComposerBranch).toHaveBeenCalledWith({ cwd: "/repo", branch: "feature", create });
    expect(view.getByRole("button", { name: action }).hasAttribute("disabled")).toBe(false);
  });

  test("does not report a late failure from the previous Project", async () => {
    let reject: (error: Error) => void = () => {};
    vi.mocked(changeComposerBranch).mockImplementationOnce(
      () =>
        new Promise((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const view = render(strip());
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create branch" }));
      await Promise.resolve();
    });
    view.rerender(strip("/other-project"));
    await act(async () => {
      reject(new Error("Old checkout is locked"));
      await Promise.resolve();
    });
    expect(toast.danger).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Create branch" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("ComposerContextRailSlot", () => {
  test("removes stale target controls in the same render that hides the slot", async () => {
    const renderSlot = (visible: boolean) => (
      <ComposerContextRailSlot visible={visible}>
        <div data-testid="new-task-target-controls">Project / Work locally / branch</div>
      </ComposerContextRailSlot>
    );
    const view = render(renderSlot(true));

    expect(view.queryByTestId("new-task-target-controls")).not.toBeNull();

    await act(async () => {
      view.rerender(renderSlot(false));
      await Promise.resolve();
    });

    expect(view.queryByTestId("new-task-target-controls")).toBeNull();
    expect(view.container.querySelector('[data-composer-external-footer-slot="true"]')).toBeNull();
  });
});

describe("composer branch context", () => {
  test("shows cached branches on mount and fences a pending checkout when the workspace changes", async () => {
    let finish!: (result: typeof branches.first) => void;
    branches.change.mockImplementation(
      () =>
        new Promise<typeof branches.first>((resolve) => {
          finish = resolve;
        }),
    );
    const actions = {} as ThreadStageActions;
    const tree = (cwd: string) => (
      <ThreadComposerStatusStrip model={branchModel(cwd)} actions={actions} />
    );
    const view = render(tree("/first"));
    expect(view.getByLabelText("Selected branch").textContent).toBe("main");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Switch branch" }));
    });
    expect(
      (view.getByRole("button", { name: "Switch branch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      view.rerender(tree("/second"));
    });
    expect(view.getByLabelText("Selected branch").textContent).toBe("other");
    expect(
      (view.getByRole("button", { name: "Switch branch" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () => {
      finish({ ...branches.first, currentBranch: "topic" });
    });
    expect(view.getByLabelText("Selected branch").textContent).toBe("other");
    expect(branches.change).toHaveBeenCalledWith({
      cwd: "/first",
      branch: "feature",
      create: false,
    });
  });
});
