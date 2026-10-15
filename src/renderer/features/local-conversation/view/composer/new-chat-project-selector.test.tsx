import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender } from "@/test/dom";
import type { NewChatProjectSelectorModel, ThreadStageActions } from "../../thread-stage-types";
import { NewChatProjectSelector } from "./new-chat-project-selector";

function buildModel(overrides?: Partial<NewChatProjectSelectorModel>): NewChatProjectSelectorModel {
  return {
    selectedProjectId: "nodex",
    disabled: false,
    canAddProject: true,
    projects: [
      {
        id: "nodex",
        label: "Nodex",
        appearance: { color: "green", marker: { kind: "icon", icon: "plant" } },
        description: "/Users/asc/repo/nodex",
        primaryWorkspaceRoot: "/Users/asc/repo/nodex",
        searchText: "nodex /users/asc/repo/nodex",
      },
      {
        id: "devtools-codex",
        label: "Devtools Codex",
        appearance: { color: "blue", marker: { kind: "icon", icon: "function" } },
        description: "/Users/asc/repo/devtools-codex",
        primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
        searchText: "devtools-codex devtools codex /users/asc/repo/devtools-codex",
      },
    ],
    ...overrides,
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  const noopAsync = async () => undefined;
  return {
    onCollaborationModeChange: () => undefined,
    onModelChange: () => undefined,
    onReasoningEffortChange: () => undefined,

    onQueueingEnabledChange: () => undefined,
    onSendPrompt: noopAsync,
    onSendCapturedFollowUp: noopAsync,
    onSteerPrompt: noopAsync,
    onInterruptTurn: noopAsync,
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
    onNewThreadProjectChange: () => undefined,
    onRequestNewChatProjectCreate: () => undefined,
    ...overrides,
  };
}

async function openMenu(trigger: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  await settleAsyncRender();
  await waitFor(() => {
    if (!document.body.querySelector("[data-new-chat-project-search='true']")) {
      throw new Error("Expected project selector menu to open.");
    }
  });
}

async function renderSelector(
  model: NewChatProjectSelectorModel,
  actions = buildActions(),
  variant: "footer" | "heading" = "footer",
): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <TooltipProvider>
        <NewChatProjectSelector model={model} actions={actions} variant={variant} />
      </TooltipProvider>,
    );
    await Promise.resolve();
  });
  await settleAsyncRender();
  return view;
}

describe("NewChatProjectSelector", () => {
  afterEach(async () => {
    await settleAsyncRender();
    await act(async () => {
      cleanup();
      document.body.replaceChildren();
      await Promise.resolve();
    });
    await settleAsyncRender();
  });

  test("renders selected project trigger and selected row", async () => {
    const view = await renderSelector(buildModel());

    const trigger = view.getByRole("button", { name: "Select project" });
    expect(trigger.textContent?.includes("Nodex")).toBe(true);

    await openMenu(trigger);

    const selectedRow = document.body.querySelector("[data-new-chat-project-option='nodex']");
    expect(selectedRow?.getAttribute("data-selected")).toBe("true");
  });

  test("shows the empty state when no projects are available", async () => {
    const view = await renderSelector(buildModel({ projects: [], selectedProjectId: null }));

    await openMenu(view.getByRole("button", { name: "Select project" }));
    expect(document.body.textContent?.includes("No projects found")).toBe(true);
  });

  test("emits project selection", async () => {
    const selected: Array<string | null> = [];
    const view = await renderSelector(
      buildModel(),
      buildActions({
        onNewThreadProjectChange: (projectId) => {
          selected.push(projectId);
        },
      }),
    );

    await openMenu(view.getByRole("button", { name: "Select project" }));
    const devtoolsRow = document.body.querySelector(
      "[data-new-chat-project-option='devtools-codex']",
    );
    if (!(devtoolsRow instanceof HTMLElement)) {
      throw new Error("Expected Devtools Codex row.");
    }
    await act(async () => {
      fireEvent.click(devtoolsRow);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(selected[0]).toBe("devtools-codex");
  });

  test("keeps the heading textual while retaining markers in the project menu", async () => {
    const selected: Array<string | null> = [];
    const model = buildModel();
    const view = await renderSelector(
      {
        ...model,
        projects: model.projects.map((project) =>
          project.id === "nodex"
            ? {
                ...project,
                appearance: { color: "orange", marker: { kind: "emoji", emoji: "🔥" } },
              }
            : project,
        ),
      },
      buildActions({
        onNewThreadProjectChange: (projectId) => {
          selected.push(projectId);
        },
      }),
      "heading",
    );

    const trigger = view.getByRole("button", { name: "Select project" });
    expect(trigger.textContent).toBe("Nodex?");
    expect(trigger.querySelector("[aria-hidden='true']")).toBeNull();

    await openMenu(trigger);
    const selectedRow = document.body.querySelector("[data-new-chat-project-option='nodex']");
    expect(selectedRow?.querySelector("[aria-hidden='true']")?.textContent).toBe("🔥");
    const devtoolsRow = document.body.querySelector(
      "[data-new-chat-project-option='devtools-codex']",
    );
    if (!(devtoolsRow instanceof HTMLElement)) {
      throw new Error("Expected Devtools Codex row.");
    }
    await act(async () => {
      fireEvent.click(devtoolsRow);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(selected[0]).toBe("devtools-codex");
  });

  test("emits add-project action", async () => {
    let addProjectCount = 0;
    const view = await renderSelector(
      buildModel(),
      buildActions({
        onRequestNewChatProjectCreate: () => {
          addProjectCount += 1;
        },
      }),
    );

    await openMenu(view.getByRole("button", { name: "Select project" }));
    await waitFor(() => {
      if (!document.body.querySelector("[data-new-chat-project-add='true']")) {
        throw new Error("Expected add project row.");
      }
    });
    const addRow = document.body.querySelector("[data-new-chat-project-add='true']");
    if (!(addRow instanceof HTMLElement)) throw new Error("Expected add project row.");
    await act(async () => {
      fireEvent.click(addRow);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(addProjectCount).toBe(1);
  });

  test("clears the selected project from the menu", async () => {
    const selected: Array<string | null> = [];
    const view = await renderSelector(
      buildModel(),
      buildActions({
        onNewThreadProjectChange: (projectId) => {
          selected.push(projectId);
        },
      }),
      "heading",
    );

    await openMenu(view.getByRole("button", { name: "Select project" }));
    const clearRow = document.body.querySelector("[data-new-chat-project-clear='true']");
    if (!(clearRow instanceof HTMLElement)) throw new Error("Expected clear-project row.");
    await act(async () => {
      fireEvent.click(clearRow);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(selected).toEqual([null]);
  });
});
