import type { ComponentProps } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { buildComposerShellFixture } from "@/test/composer-shell-fixture";
import { buildComposerActions } from "@/test/composer-actions-fixture";
import { render } from "@/test/dom";
import { changeComposerBranch } from "../../composer-git-context";
import type { ConfigureLocalEnvironmentPopover } from "./configure-local-environment-popover";
import { ComposerContextRailSlot } from "../composer-context-rail";
import { ThreadComposerStatusStrip } from "./local-conversation-thread-composer-status-strip";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
vi.mock("../../composer-git-context", () => ({ changeComposerBranch: vi.fn() }));
vi.mock("@/lib/use-git-branch-state", () => {
  const data = { currentBranch: "main", defaultBranch: "main", branches: ["main", "feature"] };
  return {
    useGitBranchState: () => ({
      data,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: async () => ({ data }),
    }),
  };
});
vi.mock("./configure-local-environment-popover", () => ({
  ConfigureLocalEnvironmentPopover: (
    props: ComponentProps<typeof ConfigureLocalEnvironmentPopover>,
  ) => (
    <>
      <button disabled={props.branchBusy} onClick={() => void props.onCheckoutBranch("feature")}>
        Switch branch
      </button>
      <button disabled={props.branchBusy} onClick={() => void props.onCreateBranch("feature")}>
        Create branch
      </button>
    </>
  ),
}));

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

beforeEach(() => vi.clearAllMocks());

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
