import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender } from "@/test/dom";
import type { NewChatStartInSelectorModel, ThreadStageActions } from "../../thread-stage-types";
import { NewChatStartInSelector } from "./new-chat-start-in-selector";

function buildModel(overrides?: Partial<NewChatStartInSelectorModel>): NewChatStartInSelectorModel {
  return {
    target: {
      runInTarget: "localProject",
      runInEnvironmentPath: null,
    },
    disabled: false,
    worktreeAvailable: true,
    environments: [],
    environmentsLoading: false,
    environmentsError: false,
    selectedEnvironmentPath: null,
    defaultEnvironmentPath: null,
    environmentNeedsAttention: false,
    environmentRepairConfigPath: null,
    ...overrides,
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  const noopAsync = async () => undefined;
  return {
    onCollaborationModeChange: () => undefined,
    onModelChange: () => undefined,
    onReasoningEffortChange: () => undefined,
    onPermissionModeChange: () => undefined,
    onQueueingEnabledChange: () => undefined,
    onSendPrompt: noopAsync,
    onSendCapturedFollowUp: noopAsync,
    onSteerPrompt: noopAsync,
    onInterruptTurn: noopAsync,
    onRespondApproval: noopAsync,
    onRespondUserInput: noopAsync,
    onRespondMcpElicitation: noopAsync,
    onResolvePlanImplementationRequest: noopAsync,
    onEnqueueQueuedFollowUp: noopAsync,
    onRemoveQueuedFollowUp: noopAsync,
    onReorderQueuedFollowUps: noopAsync,
    onSendQueuedFollowUpNow: noopAsync,
    onEditQueuedFollowUp: noopAsync,
    onEditLastUserTurn: noopAsync,
    onForkFromTurn: noopAsync,
    onUnarchiveThread: noopAsync,
    onOpenTurnDiffReview: () => undefined,
    onConsumeComposerIntent: () => undefined,
    onOpenThread: () => undefined,
    onCleanBackgroundTerminals: noopAsync,
    onNewThreadStartInTargetChange: () => undefined,
    ...overrides,
  };
}

async function renderSelector(
  model: NewChatStartInSelectorModel,
  actions = buildActions(),
  worktreeAvailable = true,
): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <TooltipProvider>
        <NewChatStartInSelector
          model={model}
          actions={actions}
          worktreeAvailable={worktreeAvailable}
        />
      </TooltipProvider>,
    );
    await Promise.resolve();
  });
  await settleAsyncRender();
  return view;
}

async function openMenu(trigger: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  await settleAsyncRender();
  await waitFor(() => {
    if (!document.body.querySelector("[data-new-chat-start-in-option='localProject']")) {
      throw new Error("Expected start-in selector menu to open.");
    }
  });
}

describe("NewChatStartInSelector", () => {
  afterEach(async () => {
    await settleAsyncRender();
    await act(async () => {
      cleanup();
      document.body.replaceChildren();
      await Promise.resolve();
    });
    await settleAsyncRender();
  });

  test("renders the closed Work locally trigger", async () => {
    const view = await renderSelector(buildModel());

    const trigger = view.getByRole("button", { name: "Start in" });
    expect(trigger.textContent?.includes("Work locally")).toBe(true);
  });

  test("renders the available execution-target menu rows", async () => {
    const view = await renderSelector(buildModel());

    await openMenu(view.getByRole("button", { name: "Start in" }));

    const bodyText = document.body.textContent ?? "";
    expect(bodyText.includes("Work in")).toBe(true);
    expect(bodyText.includes("Local")).toBe(true);
    expect(bodyText.includes("New worktree")).toBe(true);
    expect(bodyText.includes("Connect Codex web")).toBe(false);
    expect(bodyText.includes("Send to cloud")).toBe(false);
    expect(bodyText.includes("Usage remaining")).toBe(false);
    expect(bodyText.includes("Upgrade for more usage")).toBe(false);
    expect(bodyText.includes("Learn more")).toBe(false);
  });

  test("emits worktree selection", async () => {
    const selected: string[] = [];
    const view = await renderSelector(
      buildModel(),
      buildActions({
        onNewThreadStartInTargetChange: (target) => {
          selected.push(target.runInTarget);
        },
      }),
    );

    await openMenu(view.getByRole("button", { name: "Start in" }));
    const row = document.body.querySelector("[data-new-chat-start-in-option='newWorktree']");
    if (!(row instanceof HTMLElement)) throw new Error("Expected New worktree row.");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(selected[0]).toBe("newWorktree");
  });

  test("disables new worktree for non-git projects", async () => {
    const view = await renderSelector(buildModel(), buildActions(), false);

    await openMenu(view.getByRole("button", { name: "Start in" }));
    const row = document.body.querySelector("[data-new-chat-start-in-option='newWorktree']");
    expect(row?.getAttribute("data-disabled")).toBe("");
  });

  test("explains the primary worktree and directly accessed folders in multi-root projects", async () => {
    const view = await renderSelector(
      buildModel({
        repositoryName: "nodex",
        additionalSourceFolderCount: 2,
      }),
    );

    await openMenu(view.getByRole("button", { name: "Start in" }));
    const row = document.body.querySelector("[data-new-chat-start-in-option='newWorktree']");
    expect(row?.textContent).toContain("New worktree · nodex");
    expect(row?.textContent).toContain("Work locally in 2 other folders");
  });

  test("disables the trigger while submitting", async () => {
    const view = await renderSelector(buildModel({ disabled: true }));

    const trigger = view.getByRole("button", { name: "Start in" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});
