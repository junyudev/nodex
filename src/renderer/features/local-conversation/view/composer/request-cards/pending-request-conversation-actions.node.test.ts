import { describe, expect, test } from "vite-plus/test";
import type { ThreadStageActions } from "../../../thread-stage-types";
import { bindPendingRequestConversationActions } from "./pending-request-conversation-actions";

function createActions(log: string[]): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},

    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSendCapturedFollowUp: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async (requestId, _answers, context) => {
      log.push(`user-input:${requestId}:${context?.conversationId}`);
    },
    onRespondMcpElicitation: async (requestId, _action, context) => {
      log.push(`mcp:${requestId}:${context?.conversationId}`);
    },
    onRespondOptionPicker: async (requestId, _response, context) => {
      log.push(`option:${requestId}:${context?.conversationId}`);
    },
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
  };
}

describe("bindPendingRequestConversationActions", () => {
  test("binds every direct response to the owning conversation", async () => {
    const log: string[] = [];
    const bound = bindPendingRequestConversationActions({
      actions: createActions(log),
      conversationId: "thread_1",
    });

    await bound.respondUserInput("input_1", {});
    await bound.respondMcpElicitation("mcp_1", "decline");

    await bound.respondOptionPicker("option_1", {
      action: "dismiss",
      selectedOptions: [],
      freeformAnswer: null,
    });

    expect(log).toEqual([
      "user-input:input_1:thread_1",
      "mcp:mcp_1:thread_1",
      "option:option_1:thread_1",
    ]);
  });
});
