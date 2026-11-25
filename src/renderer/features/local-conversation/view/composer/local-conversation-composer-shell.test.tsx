import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import { openNodexMenu, render, settleAsyncRender, textContent } from "../../../../test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { buildComposerShellFixture } from "@/test/composer-shell-fixture";
import {
  LocalConversationAboveComposerPortalHost,
  LocalConversationAboveComposerQueuePortalHost,
} from "../local-conversation-above-composer-portal";
import { LocalConversationComposerShell } from "./local-conversation-composer-shell";
import { RendererStateProvider } from "@/app-providers";
import { TestThreadRouteScopePath } from "@/test/maitai-scope-harness";
import { TestQueryProvider } from "@/test/query";

const buildComposerShellModel = () => buildComposerShellFixture();

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
    throw new Error("Expected composer fixture model to include a thread conversation");
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
    throw new Error("Expected composer fixture model to include a thread goal");
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

    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSendCapturedFollowUp: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onOpenThread: () => {},
    onStopBackgroundTerminals: async () => {},
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
) {
  return render(
    <TestQueryProvider>
      <RendererStateProvider>
        <TestThreadRouteScopePath>
          <TooltipProvider>
            <div className="z-10 mx-auto flex w-full max-w-(--thread-content-max-width) flex-col px-toolbar pb-4">
              <LocalConversationAboveComposerPortalHost conversationId={model.threadId} />
              <LocalConversationAboveComposerQueuePortalHost conversationId={model.threadId} />
              <LocalConversationComposerShell model={model} actions={actions} />
            </div>
          </TooltipProvider>
        </TestThreadRouteScopePath>
      </RendererStateProvider>
    </TestQueryProvider>,
  );
}

describe("LocalConversationComposerShell", () => {
  beforeEach(() => {
    clearPersistedAtomStoreForTests();
  });

  test("keeps every request family on the production stage projection path", () => {
    const cases = [
      ["mcp-elicitation-lane", "mcpServerElicitation"],
      ["option-picker-lane", "optionPicker"],
    ] as const;
    const projected = cases.map(([preset, expected]) => {
      const request = buildComposerShellFixture(preset).composerShell.activeRequest?.request;
      const actual = request?.type;
      return `${expected}=${actual ?? "missing"}`;
    });

    expect(projected.join(",")).toBe(
      cases.map(([, expected]) => `${expected}=${expected}`).join(","),
    );

    const shell = buildComposerShellFixture("background-permission-option").composerShell;
    expect(shell.backgroundRequest?.request.type).toBe("userInput");
    expect(shell.activeRequest?.request.type).toBe("optionPicker");
  });

  test("pages a thirty-message queue and edits the exact message beyond the initial transcript window", async () => {
    installComposerShellWindowApi();
    const base = buildComposerShellModel();
    const edit = vi.fn(async () => {});
    const rows = Array.from({ length: 30 }, (_, index) => ({
      followUpId: `run:${index}`,
      threadId: base.threadId!,
      prompt: `Queued prompt ${index}`,
      promptInput: { text: `Queued prompt ${index}` },
      displayText: `Queued prompt ${index}`,
      canSendNow: true,
      ledgerRevision: 3,
    }));
    function PagedQueue() {
      const [page, setPage] = useState(0);
      const model = {
        ...base,
        composerShell: {
          ...base.composerShell,
          pendingSteerRows: [],
          queuedFollowUpRows: rows.slice(page * 25, page * 25 + 25),
          queuedFollowUpHasPreviousPage: page > 0,
          queuedFollowUpHasNextPage: page === 0,
        },
      };
      return (
        <LocalConversationComposerShell
          model={model}
          actions={buildActions({
            onNextQueuedFollowUpPage: async () => {
              setPage(1);
            },
            onPreviousQueuedFollowUpPage: async () => {
              setPage(0);
            },
            onEditQueuedFollowUp: edit,
          })}
        />
      );
    }
    const view = render(
      <TestQueryProvider>
        <RendererStateProvider>
          <TestThreadRouteScopePath>
            <TooltipProvider>
              <LocalConversationAboveComposerQueuePortalHost conversationId={base.threadId} />
              <LocalConversationAboveComposerPortalHost conversationId={base.threadId} />
              <PagedQueue />
            </TooltipProvider>
          </TestThreadRouteScopePath>
        </RendererStateProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();
    expect(view.getByText("Queued prompt 24")).toBeTruthy();
    expect(view.queryByText("Queued prompt 25")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /^Next$/ }));
    });
    await waitFor(() => expect(view.getByText("Queued prompt 29")).toBeTruthy());
    const row = view
      .getByText("Queued prompt 25")
      .closest("[data-queued-follow-up-row]") as HTMLElement;
    await openNodexMenu(within(row).getByRole("button", { name: "Queued message actions" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Edit message" }));
    });
    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith(
        expect.objectContaining({ followUpId: "run:25", prompt: "Queued prompt 25" }),
      ),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /^Previous$/ }));
    });
    await waitFor(() => expect(view.getByText("Queued prompt 0")).toBeTruthy());
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
    expect(view.queryByLabelText("Change permissions")).toBeNull();
    expect(view.getByLabelText("Select model") !== null).toBe(true);
    expect(view.queryByText("Foreground thread wants to run the semantic checks.") === null).toBe(
      true,
    );
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
});
