import { describe, expect, test } from "vite-plus/test";

import {
  buildCodexCanonicalPendingRequestBuckets,
  selectCanonicalInteractiveRequestForTurn,
} from "./codex-canonical-pending-request";
import { agentActivityV2UserInputRequest } from "./codex-conversation-state/test-fixtures/agent-activity-v2-request-family-corpus";
import type { CodexCanonicalServerRequest, CodexConversationSnapshot } from "./types";

const THREAD_ID = "thread_1";
const TURN_ID = "turn_1";

function buildConversation(
  canonicalRequests: CodexCanonicalServerRequest[],
): CodexConversationSnapshot {
  return {
    threadId: THREAD_ID,
    projectId: "project_1",
    source: null,
    threadName: "Thread",
    threadPreview: "Preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-07-12T00:00:00.000Z",
    resumeState: "resumed",
    turns: [
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        status: "inProgress",
        itemIds: [],
        items: [],
      },
    ],
    canonicalRequests,
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
}

function dynamicRequest(input: {
  id: string;
  tool: string;
  arguments: Extract<
    CodexCanonicalServerRequest,
    { method: "item/tool/call" }
  >["params"]["arguments"];
}): CodexCanonicalServerRequest {
  return {
    id: input.id,
    method: "item/tool/call",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      callId: `call-${input.id}`,
      namespace: "codex_app",
      tool: input.tool,
      arguments: input.arguments,
    },
  };
}

function directOptionPicker(id: string, label: string): CodexCanonicalServerRequest {
  return {
    id,
    method: "item/tool/requestOptionPicker",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      question: `Choose ${label}`,
      options: [{ label }],
    },
  };
}

describe("canonical pending request projection", () => {
  test("keeps the last valid direct or dynamic option picker in raw request order", () => {
    const olderDirect = directOptionPicker("direct-older", "Older");
    const newerDynamic = dynamicRequest({
      id: "dynamic-newer",
      tool: "request_option_picker",
      arguments: {
        question: "Choose newer",
        options: [{ label: "Newer", description: "Latest valid request" }],
      },
    });
    const bucket = buildCodexCanonicalPendingRequestBuckets(
      buildConversation([olderDirect, newerDynamic]),
    ).get(TURN_ID);

    expect(bucket?.latestOptionPickerRequest?.requestId).toBe("dynamic-newer");
    expect(bucket?.latestOptionPickerRequest?.allowMultiple).toBe(false);
    expect(bucket?.latestOptionPickerRequest?.submitLabel).toBe(null);
  });

  test("uses the exact per-turn interactive family priority", () => {
    const onboarding = dynamicRequest({
      id: "onboarding",
      tool: "request_onboarding_input",
      arguments: {
        questions: [
          {
            id: "task",
            question: "What should Codex do first?",
            options: [{ label: "Build" }, { label: "Review", description: "Review code" }],
          },
        ],
      },
    });
    const option = directOptionPicker("option", "Option");
    const setup = dynamicRequest({
      id: "setup",
      tool: "setup_codex_step",
      arguments: { step: "role" },
    });
    const conversation = buildConversation([
      option,
      setup,
      onboarding,
      {
        ...agentActivityV2UserInputRequest,
        params: {
          ...agentActivityV2UserInputRequest.params,
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      },
    ]);
    const bucket = buildCodexCanonicalPendingRequestBuckets(conversation).get(TURN_ID);
    const selected = selectCanonicalInteractiveRequestForTurn(bucket);

    expect(selected?.type).toBe("userInput");
    expect(selected?.requestId).toBe(agentActivityV2UserInputRequest.id);
    expect(bucket?.latestOnboardingInputRequest?.isOnboardingDynamicInput).toBe(true);
    expect(bucket?.latestOnboardingInputRequest?.questions[0]?.header).toBe(
      "What should Codex do first?",
    );
    expect(bucket?.latestOptionPickerRequest?.requestId).toBe("option");
    expect(bucket?.latestSetupCodexStepRequest?.step).toBe("role");
  });

  test("normalizes direct setup context but preserves the target selector's unreachable legacy context gap", () => {
    const directContext: CodexCanonicalServerRequest = {
      id: "direct-context",
      method: "item/tool/requestSetupCodexContextPicker",
      params: { threadId: THREAD_ID, turnId: TURN_ID },
    };
    const dynamicComplete = dynamicRequest({
      id: "complete",
      tool: "setup_codex_step",
      arguments: { step: "complete" },
    });
    const unreachableLegacyContext = dynamicRequest({
      id: "legacy-context",
      tool: "setup_codex_context_picker",
      arguments: {},
    });
    const bucket = buildCodexCanonicalPendingRequestBuckets(
      buildConversation([unreachableLegacyContext, dynamicComplete, directContext]),
    ).get(TURN_ID);

    expect(bucket?.latestSetupCodexStepRequest?.requestId).toBe("direct-context");
    expect(bucket?.latestSetupCodexStepRequest?.step).toBe("context");
  });

  test("ignores malformed dynamic input before it can replace a valid family request", () => {
    const valid = directOptionPicker("valid", "Valid");
    const malformed = dynamicRequest({
      id: "malformed",
      tool: "request_option_picker",
      arguments: {
        question: "Malformed",
        options: [{ label: 42 }],
      },
    });
    const bucket = buildCodexCanonicalPendingRequestBuckets(
      buildConversation([valid, malformed]),
    ).get(TURN_ID);

    expect(bucket?.latestOptionPickerRequest?.requestId).toBe("valid");
  });

  test("preserves numeric protocol request identity through private request projection", () => {
    const numericOption: CodexCanonicalServerRequest = {
      id: 73,
      method: "item/tool/requestOptionPicker",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        question: "Choose a slice",
        options: [{ label: "UI" }],
      },
    };
    const bucket = buildCodexCanonicalPendingRequestBuckets(buildConversation([numericOption])).get(
      TURN_ID,
    );

    expect(bucket?.latestOptionPickerRequest?.requestId).toBe(73);
  });
});
