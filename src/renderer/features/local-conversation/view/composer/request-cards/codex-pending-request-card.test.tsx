import { describe, expect, vi, test } from "vite-plus/test";
import { createElement } from "react";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type {
  CodexOptionPickerRequest,
  CodexPlanImplementationRequest,
  CodexSetupCodexStepRequest,
} from "@/lib/types";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import { settleAsyncRender } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import type {
  ThreadComposerShellPendingRequestModel,
  ThreadStageActions,
} from "../../../thread-stage-types";
import type { ComposerIntelligenceController } from "../use-composer-intelligence-controller";

vi.mock("./codex-implement-plan-request-card", () => ({
  CodexImplementPlanRequestCard: ({
    onRespond,
  }: {
    onRespond: (
      response: { type: "dismiss" } | { type: "implement" } | { type: "followUp"; prompt: string },
    ) => Promise<void>;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            void onRespond({ type: "implement" });
          },
        },
        "implement",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            void onRespond({ type: "followUp", prompt: "Revise step 2 and retry." });
          },
        },
        "follow-up",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            void onRespond({ type: "dismiss" });
          },
        },
        "dismiss",
      ),
    ),
}));

const PLAN_REQUEST: CodexPlanImplementationRequest = {
  type: "implementPlan",
  requestId: "implement-plan:turn_plan",
  projectId: "project_1",
  threadId: "thread_1",
  turnId: "turn_plan",
  itemId: "plan_item",
  planContent: "1. Review\n2. Ship",
  createdAt: Date.now(),
};

function createActions(log: string[]): ThreadStageActions {
  return {
    onCollaborationModeChange: (mode) => {
      log.push(`mode:${mode}`);
    },
    onModelChange: () => {},
    onReasoningEffortChange: () => {},

    onQueueingEnabledChange: () => {},
    onSendPrompt: async (prompt, opts) => {
      log.push(`send:${prompt}:${opts?.collaborationMode ?? "none"}`);
    },
    onSteerPrompt: async () => {},
    onSendCapturedFollowUp: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async (requestId, answers, context) => {
      log.push(
        `userInput:${requestId}:${answers.q1?.[0] ?? "none"}:${context?.conversationId ?? "none"}`,
      );
    },
    onRespondMcpElicitation: async (requestId, action, context) => {
      log.push(
        `mcp:${requestId}:${typeof action === "string" ? action : action.action}:${context?.conversationId ?? "none"}`,
      );
    },
    onRespondOptionPicker: async (requestId, response, context) => {
      log.push(
        `option:${requestId}:${response.action}:${response.selectedOptions.join(",")}:${context?.conversationId ?? "none"}`,
      );
    },
    onRespondSetupCodexStep: async (requestId, response, context) => {
      const value = response.step === "role" ? response.selectedRoles.join(",") : response.action;
      log.push(`setup:${requestId}:${response.step}:${value}:${context?.conversationId ?? "none"}`);
    },
    onResolvePlanImplementationRequest: async (threadId, turnId) => {
      log.push(`resolve:${threadId}:${turnId}`);
    },
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
  };
}

describe("CodexPendingRequestCard", () => {
  test("answers and dismisses Session questions without interrupting an unrelated foreground Turn", async () => {
    const { CodexPendingRequestCard } = await import("./codex-pending-request-card");
    vi.useFakeTimers();
    try {
      let revision = 0;
      const invoke = vi.fn(async (channel: string, input: unknown) => {
        if (channel === "persisted-atom:sync-request") return { revision, values: {} };
        if (channel === "persisted-atom:update")
          return { ...(input as object), revision: ++revision, originRendererId: "test" };
        if (channel === "codex:user-input:auto-resolution:snapshot") return [];
        if (channel.startsWith("codex:user-input:auto-resolution:")) return false;
        throw new Error("Legacy request control is unavailable");
      });
      const subscribe = vi.fn(() => () => {});
      installWindowApi({ invoke, on: subscribe });
      const actions = createActions([]);
      const answers = vi.fn().mockResolvedValue(undefined);
      const interrupt = vi.fn().mockResolvedValue(undefined);
      actions.onRespondUserInput = answers;
      actions.onInterruptTurn = interrupt;
      const entry: ThreadComposerShellPendingRequestModel = {
        conversationId: "native-session-question",
        surface: "activeThread",
        request: {
          type: "userInput",
          executionOwner: "agent-runtime",
          requestId: "native-question",
          projectId: "project_1",
          threadId: "native-session-question",
          turnId: null,
          itemId: "native-question-item",
          createdAt: 1,
          isBlocking: true,
          questions: [
            {
              id: "q1",
              header: "Choice",
              question: "Continue?",
              isOther: false,
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        },
      };
      const view = render(
        <TooltipProvider>
          <CodexPendingRequestCard entry={entry} actions={actions} />
        </TooltipProvider>,
      );
      await act(async () => {
        fireEvent.click(view.getByRole("radio", { name: "Yes" }));
        await vi.advanceTimersByTimeAsync(200);
        await Promise.resolve();
      });
      expect(answers).toHaveBeenCalledWith(
        "native-question",
        { q1: ["Yes"] },
        { conversationId: "native-session-question" },
      );
      expect(interrupt).not.toHaveBeenCalled();

      view.unmount();
      const dismissed = render(
        <TooltipProvider>
          <CodexPendingRequestCard
            entry={{ ...entry, request: { ...entry.request, requestId: "native-dismiss" } }}
            actions={actions}
          />
        </TooltipProvider>,
      );
      await act(async () => {
        fireEvent.click(dismissed.getByRole("button", { name: "Dismiss" }));
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
      });
      expect(answers).toHaveBeenCalledWith(
        "native-dismiss",
        {},
        { conversationId: "native-session-question" },
      );
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  test("implementing a plan preserves the request while starting the Default-mode turn", async () => {
    const { CodexPendingRequestCard } = await import("./codex-pending-request-card");
    const log: string[] = [];
    const entry: ThreadComposerShellPendingRequestModel = {
      request: PLAN_REQUEST,
      conversationId: "thread_1",
      surface: "activeThread",
    };

    const { getByText } = render(
      <CodexPendingRequestCard entry={entry} actions={createActions(log)} />,
    );

    await act(async () => {
      fireEvent.click(getByText("implement"));
      await settleAsyncRender();
    });

    expect(log).toEqual([
      "mode:default",
      "send:PLEASE IMPLEMENT THIS PLAN:\n1. Review\n2. Ship:default",
    ]);
  });

  test("flushes the displayed selection before using the same values for the implementation turn", async () => {
    const { CodexPendingRequestCard } = await import("./codex-pending-request-card");
    const log: string[] = [];
    const selection = {
      kind: "codex" as const,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh" as const,
      serviceTier: "fast" as const,
    };
    const controller: ComposerIntelligenceController = {
      selection,
      isOpen: false,
      isPending: true,
      select: () => {},
      setOpen: () => {},
      open: () => {},
      flush: async () => {
        log.push("flush");
      },
      getSelection: () => selection,
      turnOverrides: {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        serviceTier: selection.serviceTier,
      },
      triggerRef: () => {},
    };
    const actions = createActions(log);
    actions.onIntelligenceSelectionChange = async (next, options) => {
      if (next.kind !== "codex") throw new Error("Expected Codex selection");
      log.push(
        `selection:${next.model}:${next.reasoningEffort}:${next.serviceTier}:${options?.collaborationMode}`,
      );
    };
    actions.onSendPrompt = async (prompt, options) => {
      log.push(
        `send:${prompt}:${options?.collaborationMode}:${options?.model}:${options?.reasoningEffort}:${options?.serviceTier}`,
      );
    };

    const view = render(
      <CodexPendingRequestCard
        entry={{ request: PLAN_REQUEST, conversationId: "thread_1", surface: "activeThread" }}
        actions={actions}
        intelligenceController={controller}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByText("implement"));
      await settleAsyncRender();
    });

    expect(log).toEqual([
      "flush",
      "selection:gpt-5.6-sol:xhigh:fast:default",
      "send:PLEASE IMPLEMENT THIS PLAN:\n1. Review\n2. Ship:default:gpt-5.6-sol:xhigh:fast",
    ]);
  });

  test("routes canonical option and setup cards through their owning conversation", async () => {
    const { CodexPendingRequestCard } = await import("./codex-pending-request-card");
    const log: string[] = [];
    const actions = createActions(log);
    const optionEntry: ThreadComposerShellPendingRequestModel = {
      conversationId: "thread-option",
      surface: "activeThread",
      request: {
        type: "optionPicker",
        requestId: 73,
        projectId: "project_1",
        threadId: "thread-option",
        turnId: "turn-option",
        itemId: "option-item",
        question: "Choose a slice",
        options: [{ label: "Composer", description: "Wire it" }],
        allowMultiple: false,
        submitLabel: null,
        skipLabel: null,
        createdAt: 1,
      } satisfies CodexOptionPickerRequest,
    };
    const optionView = render(<CodexPendingRequestCard entry={optionEntry} actions={actions} />);
    await act(async () => {
      fireEvent.click(optionView.getByRole("radio", { name: "Composer" }));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(optionView.getByText("Submit"));
      await settleAsyncRender();
    });
    optionView.unmount();

    const setupEntry: ThreadComposerShellPendingRequestModel = {
      conversationId: "thread-setup",
      surface: "activeThread",
      request: {
        type: "setupCodexStep",
        requestId: "setup-1",
        projectId: "project_1",
        threadId: "thread-setup",
        turnId: "turn-setup",
        itemId: "setup-item",
        step: "role",
        createdAt: 1,
      } satisfies CodexSetupCodexStepRequest,
    };
    const setupView = render(<CodexPendingRequestCard entry={setupEntry} actions={actions} />);
    await act(async () => {
      fireEvent.click(setupView.getByRole("checkbox", { name: "Engineering" }));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(setupView.getByText("Continue"));
      await settleAsyncRender();
    });

    expect(JSON.stringify(log)).toBe(
      JSON.stringify([
        "option:73:submit:Composer:thread-option",
        "setup:setup-1:role:engineering:thread-setup",
      ]),
    );
  });

  test("freeform implement-plan follow-ups do not force default mode", async () => {
    const { CodexPendingRequestCard } = await import("./codex-pending-request-card");
    const log: string[] = [];
    const entry: ThreadComposerShellPendingRequestModel = {
      request: PLAN_REQUEST,
      conversationId: "thread_1",
      surface: "activeThread",
    };

    const { getByText } = render(
      <CodexPendingRequestCard entry={entry} actions={createActions(log)} />,
    );

    await act(async () => {
      fireEvent.click(getByText("follow-up"));
      await settleAsyncRender();
    });

    expect(log).toEqual(["send:Revise step 2 and retry.:none"]);
  });

  test("dismissing a plan implementation request resolves without sending a follow-up", async () => {
    const { CodexPendingRequestCard } = await import("./codex-pending-request-card");
    const log: string[] = [];
    const entry: ThreadComposerShellPendingRequestModel = {
      request: PLAN_REQUEST,
      conversationId: "thread_1",
      surface: "activeThread",
    };

    const { getByText } = render(
      <CodexPendingRequestCard entry={entry} actions={createActions(log)} />,
    );

    await act(async () => {
      fireEvent.click(getByText("dismiss"));
      await settleAsyncRender();
    });

    expect(log).toEqual(["mode:default", "resolve:thread_1:turn_plan"]);
  });
});
