import { describe, expect, test } from "vite-plus/test";
import type { ThreadStageActions } from "../../../thread-stage-types";
import { bindPendingRequestConversationActions } from "./pending-request-conversation-actions";

function createActions(log: string[]): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
    onPermissionModeChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSendCapturedFollowUp: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondApproval: async (requestId, response, context) => {
      log.push(`approval:${requestId}:${response.decision}:${context?.conversationId}`);
    },
    onRespondUserInput: async (requestId, _answers, context) => {
      log.push(`user-input:${requestId}:${context?.conversationId}`);
    },
    onRespondMcpElicitation: async (requestId, _action, context) => {
      log.push(`mcp:${requestId}:${context?.conversationId}`);
    },
    onRespondPermissionRequest: async (requestId, _response, context) => {
      log.push(`permission:${requestId}:${context?.conversationId}`);
    },
    onRespondNodexAgentAuthorization: async (requestId, _response, context) => {
      log.push(`nodex:${requestId}:${context?.conversationId}`);
    },
    onRespondOptionPicker: async (requestId, _response, context) => {
      log.push(`option:${requestId}:${context?.conversationId}`);
    },
    onRespondSetupCodexStep: async (requestId, _response, context) => {
      log.push(`setup:${requestId}:${context?.conversationId}`);
    },
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
  };
}

describe("bindPendingRequestConversationActions", () => {
  test("binds every direct response to the owning conversation", async () => {
    const log: string[] = [];
    const bound = bindPendingRequestConversationActions({
      actions: createActions(log),
      conversationId: "thread_1",
    });

    await bound.respondApproval("approval_1", { kind: "file", decision: "decline" });
    await bound.respondUserInput("input_1", {});
    await bound.respondMcpElicitation("mcp_1", "decline");
    await bound.respondPermissionRequest("permission_1", { permissions: {}, scope: "turn" });
    await bound.respondNodexAgentAuthorization("nodex_1", { decision: "deny" });
    await bound.respondOptionPicker("option_1", {
      action: "dismiss",
      selectedOptions: [],
      freeformAnswer: null,
    });
    await bound.respondSetupCodexStep("setup_1", {
      step: "context",
      action: "dismiss",
      selectedSources: [],
    });

    expect(log).toEqual([
      "approval:approval_1:decline:thread_1",
      "user-input:input_1:thread_1",
      "mcp:mcp_1:thread_1",
      "permission:permission_1:thread_1",
      "nodex:nodex_1:thread_1",
      "option:option_1:thread_1",
      "setup:setup_1:thread_1",
    ]);
  });

  test("reports only accepted approval paths as manual approvals", async () => {
    const log: string[] = [];
    const bound = bindPendingRequestConversationActions({
      actions: createActions(log),
      conversationId: "thread_1",
      onManualApproval: (conversationId) => {
        log.push(`manual:${conversationId}`);
      },
    });

    await bound.respondApproval("declined", { kind: "file", decision: "decline" });
    await bound.respondApproval("accepted", { kind: "file", decision: "accept" });
    await bound.respondPermissionRequest("permission", { permissions: {}, scope: "turn" });

    expect(log).toEqual([
      "approval:declined:decline:thread_1",
      "approval:accepted:accept:thread_1",
      "manual:thread_1",
      "permission:permission:thread_1",
      "manual:thread_1",
    ]);
  });
});
