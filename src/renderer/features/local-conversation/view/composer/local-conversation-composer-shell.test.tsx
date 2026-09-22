import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent, within } from "@testing-library/react";
import { useEffect } from "react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import { openNodexMenu, render, settleAsyncRender, textContent } from "../../../../test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { useAutoReviewApprovalNudgeActions } from "../../auto-review-approval-nudge-state";
import {
  buildThreadStageStorySurfaceModels,
  buildThreadStageStoryScenario,
  type ThreadStageStoryControls,
} from "../thread-stage-story-fixtures";
import {
  LocalConversationAboveComposerPortalHost,
  LocalConversationAboveComposerQueuePortalHost,
} from "../local-conversation-above-composer-portal";
import {
  LocalConversationComposerShell,
  resolveComposerReplacementOwner,
} from "./local-conversation-composer-shell";
import { RendererStateProvider } from "@/app-providers";
import { TestThreadRouteScopePath } from "@/test/maitai-scope-harness";
import { TestQueryProvider } from "@/test/query";

const STORY_CONTROLS: ThreadStageStoryControls = {
  preset: "background-activity",
  permissionMode: "auto",
  authenticatedAccount: true,
  isQueueingEnabled: false,
  collapseAgentBody: false,
};

function buildComposerShellModel() {
  const scenario = buildThreadStageStoryScenario(STORY_CONTROLS);
  return buildThreadStageStorySurfaceModels(scenario, STORY_CONTROLS, scenario.runtime).footerModel;
}

function buildThreadGoal(
  threadId: string,
  status: ThreadGoal["status"],
  overrides: Partial<ThreadGoal> = {},
): ThreadGoal {
  return {
    threadId,
    objective:
      "Finish goal parity with the Codex Electron resume prompt and keep the thread moving while idle.",
    status,
    tokenBudget: null,
    tokensUsed: 42,
    timeUsedSeconds: 120,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function buildComposerShellModelWithThreadGoal(
  status: ThreadGoal["status"],
  overrides: Partial<ThreadGoal> = {},
) {
  const model = buildComposerShellModel();
  if (!model.threadId || !model.conversation) {
    throw new Error("Expected story composer shell model to include a thread conversation");
  }

  const goal = buildThreadGoal(model.threadId, status, overrides);

  return {
    ...model,
    conversation: {
      ...model.conversation,
      threadGoal: goal,
      threadGoalResumeConfirmation: null,
    },
  };
}

function buildComposerShellModelWithGoalResumeConfirmation(status: ThreadGoal["status"]) {
  const model = buildComposerShellModelWithThreadGoal(status);
  const goal = model.conversation?.threadGoal ?? null;
  if (!goal || !model.conversation) {
    throw new Error("Expected story composer shell model to include a thread goal");
  }

  return {
    ...model,
    conversation: {
      ...model.conversation,
      threadGoalResumeConfirmation: goal,
    },
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
    onPermissionModeChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondApproval: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditLastUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
    ...overrides,
  };
}

function installComposerShellWindowApi(
  testInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>,
): void {
  let persistedRevision = 0;
  const persistedValues: Record<string, unknown> = {};
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (testInvoke) {
        const result = await testInvoke(channel, ...args);
        if (result !== undefined) return result;
      }
      switch (channel) {
        case "branch-metadata":
          return {
            currentBranch: "main",
            defaultBranch: "main",
            branches: ["main"],
          };
        case "subscribe-live-query":
        case "unsubscribe-live-query":
          return true;
        case "persisted-atom:sync-request":
          return { revision: persistedRevision, values: persistedValues };
        case "persisted-atom:update": {
          const update = args[0] as { key: string; value: unknown; mutationId: string };
          persistedRevision += 1;
          persistedValues[update.key] = update.value;
          return {
            ...update,
            revision: persistedRevision,
            originRendererId: "test-renderer",
          };
        }
        case "codex:thread:goal:materialize-draft": {
          const draft = args[0] as { objective?: string };
          return {
            objective: draft.objective?.trim() ?? "",
            attachmentDirectory: null,
          };
        }
        case "codex:thread:goal:materialized-cleanup":
          return undefined;
        case "codex:thread:goal:editable-objective:read":
          return args[0];
        case "codex:app-server:request":
          return { type: "result", result: undefined };
        default:
          return null;
      }
    },
    on: () => () => {},
  });
}

function renderComposerShell(
  model: ReturnType<typeof buildComposerShellModel>,
  actions: ThreadStageActions = buildActions(),
  options: { readonly activateAutoReviewNudge?: boolean } = {},
) {
  return render(
    <TestQueryProvider>
      <RendererStateProvider>
        <TestThreadRouteScopePath>
          <TooltipProvider>
            <div className="z-10 mx-auto flex w-full max-w-(--thread-content-max-width) flex-col px-toolbar pb-4">
              {options.activateAutoReviewNudge && model.threadId ? (
                <AutoReviewApprovalNudgeActivator threadId={model.threadId} />
              ) : null}
              <LocalConversationAboveComposerPortalHost conversationId={model.threadId} />
              <LocalConversationAboveComposerQueuePortalHost conversationId={model.threadId} />
              <LocalConversationComposerShell
                model={model}
                actions={actions}
                errorMessage={null}
                onErrorMessage={() => {}}
              />
            </div>
          </TooltipProvider>
        </TestThreadRouteScopePath>
      </RendererStateProvider>
    </TestQueryProvider>,
  );
}

function AutoReviewApprovalNudgeActivator({ threadId }: { readonly threadId: string }) {
  const { recordManualApproval, resolveNudge } = useAutoReviewApprovalNudgeActions();

  useEffect(() => {
    void recordManualApproval({
      threadId,
      eligible: true,
      threshold: 1,
    });
    return () => resolveNudge(threadId);
  }, [recordManualApproval, resolveNudge, threadId]);

  return null;
}

describe("LocalConversationComposerShell", () => {
  beforeEach(() => {
    clearPersistedAtomStoreForTests();
  });

  test("resolves the exact composer replacement owner precedence", () => {
    const cases = [
      {
        threadId: null,
        hasAutoReviewNudge: true,
        isResponseInProgress: false,
        hasRequestCards: true,
      },
      {
        threadId: "thread_1",
        hasAutoReviewNudge: false,
        isResponseInProgress: false,
        hasRequestCards: false,
      },
      {
        threadId: "thread_1",
        hasAutoReviewNudge: false,
        isResponseInProgress: false,
        hasRequestCards: true,
      },
      {
        threadId: "thread_1",
        hasAutoReviewNudge: true,
        isResponseInProgress: false,
        hasRequestCards: true,
      },
      {
        threadId: "thread_1",
        hasAutoReviewNudge: true,
        isResponseInProgress: true,
        hasRequestCards: true,
      },
      {
        threadId: "thread_1",
        hasAutoReviewNudge: true,
        isResponseInProgress: true,
        hasRequestCards: false,
      },
    ];

    expect(cases.map(resolveComposerReplacementOwner).join(",")).toBe(
      "normal,normal,requestStack,autoReviewNudge,requestStack,normal",
    );
  });

  test("keeps every request family on the production stage projection path", () => {
    const cases = [
      ["file-approval-lane", "approval:file"],
      ["permission-lane", "permissionRequest"],
      ["mcp-elicitation-lane", "mcpServerElicitation"],
      ["option-picker-lane", "optionPicker"],
      ["onboarding-input-lane", "userInput:onboarding"],
      ["setup-role-lane", "setupCodexStep:role"],
      ["setup-task-lane", "setupCodexStep:task"],
      ["setup-context-lane", "setupCodexStep:context"],
    ] as const;
    const projected = cases.map(([preset, expected]) => {
      const controls: ThreadStageStoryControls = { ...STORY_CONTROLS, preset };
      const scenario = buildThreadStageStoryScenario(controls);
      const request = buildThreadStageStorySurfaceModels(scenario, controls, scenario.runtime)
        .footerModel.composerShell.activeRequest?.request;
      const actual =
        request?.type === "approval"
          ? `${request.type}:${request.kind}`
          : request?.type === "userInput" && request.isOnboardingDynamicInput
            ? `${request.type}:onboarding`
            : request?.type === "setupCodexStep"
              ? `${request.type}:${request.step}`
              : request?.type;
      return `${expected}=${actual ?? "missing"}`;
    });

    expect(projected.join(",")).toBe(
      cases.map(([, expected]) => `${expected}=${expected}`).join(","),
    );

    const controls: ThreadStageStoryControls = {
      ...STORY_CONTROLS,
      preset: "background-permission-option",
    };
    const scenario = buildThreadStageStoryScenario(controls);
    const shell = buildThreadStageStorySurfaceModels(scenario, controls, scenario.runtime)
      .footerModel.composerShell;
    expect(shell.backgroundRequest?.request.type).toBe("permissionRequest");
    expect(shell.activeRequest?.request.type).toBe("optionPicker");
  });

  test("renders Codex-compatible above-composer portal targets", () => {
    const { container } = render(
      <div>
        <LocalConversationAboveComposerPortalHost conversationId="thread-portal" />
        <LocalConversationAboveComposerQueuePortalHost conversationId="thread-portal" />
      </div>,
    );

    const primary = container.querySelector<HTMLElement>("[data-above-composer-portal]");
    const queue = container.querySelector<HTMLElement>("[data-above-composer-queue-portal]");

    expect(primary?.id ?? "").toBe("above-composer-portal");
    expect(primary?.getAttribute("data-above-composer-conversation-id") ?? "").toBe(
      "thread-portal",
    );
    expect(queue?.id ?? "").toBe("above-composer-queue-portal");
    expect(queue?.getAttribute("data-above-composer-conversation-id") ?? "").toBe("thread-portal");
  });

  test("renders queue rows, background terminals, and request cards in one shell", async () => {
    installComposerShellWindowApi();
    const model = buildComposerShellModel();
    const view = renderComposerShell(model);
    await settleAsyncRender();

    const renderedText = textContent(document.body);
    expect(
      Boolean(renderedText.includes("Keep the stage stories on the real projection path.")),
    ).toBe(false);
    expect(
      Boolean(renderedText.includes("Run final validation once the stories are in place.")),
    ).toBe(true);
    expect(Boolean(renderedText.includes("Running 1 terminal"))).toBe(true);
    expect(Boolean(renderedText.includes("1 active requests"))).toBe(false);

    const backgroundReason = view.getByText(
      "Background child wants to run the isolated request-card tests.",
    );
    const activeReason = view.getByText(
      "Foreground thread wants to run lint before Storybook build.",
    );
    expect(
      view.getAllByText("Background child wants to run the isolated request-card tests.").length,
    ).toBe(1);
    expect(
      view.getAllByText("Foreground thread wants to run lint before Storybook build.").length,
    ).toBe(1);
    expect(
      Boolean(
        backgroundReason.compareDocumentPosition(activeReason) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    const lowerStatusRow = view.container.querySelector('[data-composer-lower-status-row="true"]');
    expect(lowerStatusRow === null).toBe(true);
    expect(view.queryByLabelText("Add files and more") === null).toBe(true);
    expect(view.queryByLabelText("Permission mode") === null).toBe(true);
    expect(view.queryByLabelText("Select model") === null).toBe(true);
    expect(view.queryByLabelText(/Context window/) === null).toBe(true);
    expect(view.queryByLabelText("Send prompt") === null).toBe(true);
    expect(view.queryByLabelText("Stop generating") === null).toBe(true);
  });

  test("renders interruption pause and resumes only the queued-follow-up lane", async () => {
    installComposerShellWindowApi();
    const base = buildComposerShellModel();
    const row = base.composerShell.queuedFollowUpRows[0];
    if (!row) throw new Error("Expected queue story row");
    let resumeCalls = 0;
    const view = renderComposerShell(
      {
        ...base,
        composerShell: {
          ...base.composerShell,
          hasInterruptedQueuedFollowUps: true,
          queuedFollowUpRows: [
            {
              ...row,
              pauseKind: "interrupted",
              pausedReason: "Interrupted before the steer was accepted.",
            },
          ],
        },
      },
      buildActions({
        onResumeQueuedFollowUps: async () => {
          resumeCalls += 1;
        },
      }),
    );
    await settleAsyncRender();

    expect(view.getByText("Queue paused because you interrupted")).not.toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Resume" }));
      await Promise.resolve();
    });
    expect(resumeCalls).toBe(1);
  });

  test("shows failed rows as Retry and locks every destructive action while in flight", async () => {
    installComposerShellWindowApi();
    const base = buildComposerShellModel();
    const row = base.composerShell.queuedFollowUpRows[0];
    if (!row) throw new Error("Expected queue story row");
    const view = renderComposerShell({
      ...base,
      composerShell: {
        ...base.composerShell,
        queuedFollowUpRows: [
          {
            ...row,
            pauseKind: "failed",
            pausedReason: "gateway unavailable",
            isInFlight: true,
          },
        ],
      },
    });
    await settleAsyncRender();

    expect(view.getByText("Retry")).not.toBeNull();
    expect(
      (
        view.getByRole("button", {
          name: "Try sending this queued message again",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: "Delete queued message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: "Queued message actions" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("offers the bidirectional queueing preference action", async () => {
    installComposerShellWindowApi();
    const base = buildComposerShellModel();
    const row = base.composerShell.queuedFollowUpRows[0];
    if (!row) throw new Error("Expected queue story row");
    let nextQueueingValue: boolean | null = null;
    const view = renderComposerShell(
      {
        ...base,
        isQueueingEnabled: false,
        composerShell: {
          ...base.composerShell,
          hasInterruptedQueuedFollowUps: false,
          queuedFollowUpRows: [{ ...row, pauseKind: null, pausedReason: null, isInFlight: false }],
        },
      },
      buildActions({
        onQueueingEnabledChange: (enabled) => {
          nextQueueingValue = enabled;
        },
      }),
    );
    await settleAsyncRender();
    const menuTrigger = view.getByRole("button", { name: "Queued message actions" });
    expect((menuTrigger as HTMLButtonElement).disabled).toBe(false);
    await openNodexMenu(menuTrigger);
    const item = await view.findByText("Turn on queueing");
    await act(async () => {
      fireEvent.click(item);
      await Promise.resolve();
    });
    expect(nextQueueingValue).toBe(true);
  });

  test("gives only the active implement-plan request one sibling intelligence footer", async () => {
    installComposerShellWindowApi();
    const controls: ThreadStageStoryControls = {
      ...STORY_CONTROLS,
      preset: "implement-plan",
    };
    const scenario = buildThreadStageStoryScenario(controls);
    const model = buildThreadStageStorySurfaceModels(
      scenario,
      controls,
      scenario.runtime,
    ).footerModel;
    const view = renderComposerShell(
      model,
      buildActions({
        onIntelligenceSelectionChange: async () => {},
      }),
    );
    await settleAsyncRender();

    expect(view.getByText("Implement this plan?") !== null).toBe(true);
    expect(view.getAllByLabelText("Select model")).toHaveLength(1);
    expect(
      view.container.querySelector('[data-implement-plan-intelligence-footer="true"]'),
    ).not.toBeNull();
    expect(view.queryByLabelText("Add files and more")).toBeNull();
    expect(view.queryByLabelText("Permission mode")).toBeNull();
    expect(view.queryByLabelText(/Context window/)).toBeNull();
    expect(view.queryByLabelText("Send prompt")).toBeNull();
  });

  test("gives the idle auto-review nudge exclusive ownership and restores requests after enabling it", async () => {
    installComposerShellWindowApi();
    const baseModel = buildComposerShellModel();
    if (!baseModel.threadId) throw new Error("Expected a thread-backed story model");
    const changedModes: string[] = [];
    const view = renderComposerShell(
      {
        ...baseModel,
        isThreadRunning: false,
      },
      buildActions({
        onPermissionModeChange: async (mode) => {
          changedModes.push(mode);
        },
      }),
      { activateAutoReviewNudge: true },
    );
    await settleAsyncRender();

    expect(view.getByText("Want fewer approval prompts?") !== null).toBe(true);
    expect(
      view.queryByText("Background child wants to run the isolated request-card tests.") === null,
    ).toBe(true);
    expect(
      view.queryByText("Foreground thread wants to run lint before Storybook build.") === null,
    ).toBe(true);
    expect(
      Boolean(
        textContent(document.body).includes("Run final validation once the stories are in place."),
      ),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Approve for me/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(changedModes.join(",")).toBe("guardian-approvals");
    expect(
      view.getByText("Background child wants to run the isolated request-card tests.") !== null,
    ).toBe(true);
    expect(
      view.getByText("Foreground thread wants to run lint before Storybook build.") !== null,
    ).toBe(true);
  });

  test("restores the normal composer after every request surface clears", async () => {
    installComposerShellWindowApi();
    const baseModel = buildComposerShellModel();
    const model: ThreadFooterModel = {
      ...baseModel,
      isThreadRunning: false,
      composerShell: {
        ...baseModel.composerShell,
        activeRequest: null,
        backgroundRequest: null,
        showRequestCards: false,
        showComposer: true,
      },
    };
    const view = renderComposerShell(model);
    await settleAsyncRender();

    expect(view.getByLabelText("Add files and more") !== null).toBe(true);
    expect(view.getByLabelText("Change permissions") !== null).toBe(true);
    expect(view.getByLabelText("Select model") !== null).toBe(true);
    expect(
      view.queryByText("Foreground thread wants to run lint before Storybook build.") === null,
    ).toBe(true);
  });

  test("renders paused goal resume confirmation and dismisses it", async () => {
    installComposerShellWindowApi();
    const model = buildComposerShellModelWithGoalResumeConfirmation("paused");
    const dismissCalls: string[] = [];
    const view = renderComposerShell(
      model,
      buildActions({
        onDismissThreadGoalResumeConfirmation: async (threadId) => {
          dismissCalls.push(threadId);
        },
      }),
    );
    await settleAsyncRender();

    expect(Boolean(textContent(document.body).includes("Resume paused goal?"))).toBe(true);
    expect(
      Boolean(
        textContent(document.body).includes(
          "Nodex will keep working toward this goal when the thread is idle",
        ),
      ),
    ).toBe(true);
    expect(
      Boolean(
        textContent(document.body).includes(
          "Finish goal parity with the Codex Electron resume prompt",
        ),
      ),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Keep paused" }));
      await Promise.resolve();
    });

    expect(dismissCalls.length).toBe(1);
    expect(dismissCalls[0]).toBe(model.threadId);
  });

  test("resumes non-paused goal confirmation with status-only update", async () => {
    installComposerShellWindowApi();
    const model = buildComposerShellModelWithGoalResumeConfirmation("blocked");
    const setGoalCalls: unknown[] = [];
    const view = renderComposerShell(
      model,
      buildActions({
        onDismissThreadGoalResumeConfirmation: async () => {},
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(input);
          return null;
        },
      }),
    );
    await settleAsyncRender();

    expect(Boolean(textContent(document.body).includes("Resume goal?"))).toBe(true);
    expect(view.getByRole("button", { name: "Not now" }) !== null).toBe(true);

    const resumeButtons = view.getAllByRole("button", { name: "Resume goal" });
    const resumeDialogSubmitButton = resumeButtons[resumeButtons.length - 1];
    if (!resumeDialogSubmitButton) {
      throw new Error("Expected the resume confirmation dialog to include a submit button");
    }
    await act(async () => {
      fireEvent.click(resumeDialogSubmitButton);
      await Promise.resolve();
    });

    const call = setGoalCalls[0] as
      | { threadId?: string; status?: string; objective?: unknown }
      | undefined;
    expect(setGoalCalls.length).toBe(1);
    expect(call?.threadId).toBe(model.threadId);
    expect(call?.status).toBe("active");
    expect(Object.prototype.hasOwnProperty.call(call ?? {}, "objective")).toBe(false);
  });

  test("renders active thread goal status row in the above-composer queue portal", async () => {
    installComposerShellWindowApi();
    const objective = "Keep the status row aligned with the reference app.";
    const model = buildComposerShellModelWithThreadGoal("active", {
      objective,
      tokenBudget: 2000,
      tokensUsed: 1500,
    });
    const view = renderComposerShell(
      model,
      buildActions({
        onSetThreadGoal: async () => null,
        onClearThreadGoal: async () => {},
      }),
    );
    await settleAsyncRender();

    const row = view.container.querySelector<HTMLElement>('[data-thread-goal-status-row="true"]');
    if (!row) {
      throw new Error("Expected saved goal status row to render");
    }
    expect(row.closest("[data-above-composer-queue-portal]") !== null).toBe(true);
    expect(row.closest("[data-above-composer-portal]") === null).toBe(true);
    const rowView = within(row);
    expect(rowView.getByText("Pursuing goal") !== null).toBe(true);
    expect(rowView.getAllByText(objective).length > 0).toBe(true);
    expect(rowView.getByText(/1\.5K \/ 2K/) !== null).toBe(true);
    expect(rowView.getByRole("button", { name: "Edit goal" }) !== null).toBe(true);
    expect(rowView.getByRole("button", { name: "Pause goal" }) !== null).toBe(true);
    expect(rowView.getByRole("button", { name: "Clear goal" }) !== null).toBe(true);
  });

  test("renders Codex-style elapsed goal time when no token budget is present", async () => {
    installComposerShellWindowApi();
    const model = buildComposerShellModelWithThreadGoal("paused", {
      tokenBudget: null,
      timeUsedSeconds: 120,
    });
    const view = renderComposerShell(model);
    await settleAsyncRender();

    const row = view.container.querySelector<HTMLElement>('[data-thread-goal-status-row="true"]');
    if (!row) {
      throw new Error("Expected saved goal status row to render");
    }
    const rowView = within(row);
    expect(rowView.getByText("Paused goal") !== null).toBe(true);
    expect(rowView.getByText(/2m/) !== null).toBe(true);
  });

  test("updates and clears thread goal from the status row", async () => {
    installComposerShellWindowApi();
    const setGoalCalls: Parameters<NonNullable<ThreadStageActions["onSetThreadGoal"]>>[0][] = [];
    const clearCalls: string[] = [];
    const activeModel = buildComposerShellModelWithThreadGoal("active");
    const activeView = renderComposerShell(
      activeModel,
      buildActions({
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(input);
          return null;
        },
        onClearThreadGoal: async (threadId) => {
          clearCalls.push(threadId);
        },
      }),
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(activeView.getByRole("button", { name: "Pause goal" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(activeView.getByRole("button", { name: "Clear goal" }));
      await Promise.resolve();
    });

    expect(setGoalCalls.length).toBe(1);
    expect(setGoalCalls[0]?.threadId).toBe(activeModel.threadId);
    expect(setGoalCalls[0]?.status).toBe("paused");
    expect(Object.prototype.hasOwnProperty.call(setGoalCalls[0] ?? {}, "objective")).toBe(false);
    expect(clearCalls.length).toBe(1);
    expect(clearCalls[0]).toBe(activeModel.threadId);
    activeView.unmount();

    const pausedModel = buildComposerShellModelWithThreadGoal("paused");
    const pausedView = renderComposerShell(
      pausedModel,
      buildActions({
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(input);
          return null;
        },
      }),
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(pausedView.getByRole("button", { name: "Resume goal" }));
      await Promise.resolve();
    });

    expect(setGoalCalls.length).toBe(2);
    expect(setGoalCalls[1]?.threadId).toBe(pausedModel.threadId);
    expect(setGoalCalls[1]?.status).toBe("active");
    expect(Object.prototype.hasOwnProperty.call(setGoalCalls[1] ?? {}, "objective")).toBe(false);
  });

  test("opens thread goal edit dialog and saves the changed objective", async () => {
    installComposerShellWindowApi();
    const model = buildComposerShellModelWithThreadGoal("active");
    const setGoalCalls: Parameters<NonNullable<ThreadStageActions["onSetThreadGoal"]>>[0][] = [];
    const view = renderComposerShell(
      model,
      buildActions({
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(input);
          return null;
        },
      }),
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(within(view.container).getByRole("button", { name: "Edit goal" }));
      await Promise.resolve();
    });

    const textbox = view.getByRole("textbox", { name: "Goal" });
    const nextObjective = "Keep the saved goal row editable and restart the active goal.";
    await act(async () => {
      fireEvent.input(textbox, {
        target: {
          value: nextObjective,
        },
      });
      await Promise.resolve();
    });
    expect((textbox as HTMLTextAreaElement).value).toBe(nextObjective);
    const saveButton = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.submit(textbox.closest("form") as HTMLFormElement);
      await Promise.resolve();
    });

    expect(setGoalCalls.length).toBe(1);
    expect(setGoalCalls[0]?.threadId).toBe(model.threadId);
    expect(setGoalCalls[0]?.objective).toBe(nextObjective);
    expect(setGoalCalls[0]?.status).toBe("active");
    expect(setGoalCalls[0]?.appendTranscriptItem).toBe(false);
  });

  test("does not render complete thread goal status row", async () => {
    installComposerShellWindowApi();
    const model = buildComposerShellModelWithThreadGoal("complete");
    const view = renderComposerShell(model);
    await settleAsyncRender();

    expect(view.container.querySelector('[data-thread-goal-status-row="true"]') === null).toBe(
      true,
    );
    expect(view.queryByText("Goal achieved") === null).toBe(true);
  });
});
