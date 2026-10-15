import { describe, expect, test } from "vite-plus/test";
import { createCodexCanonicalHydratedConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import type { CodexQueuedMessage } from "../../../shared/codex-queued-message";
import { canEnqueueNativeCodexQueue } from "./codex-native-queue-policy";
const nativeSandbox = { type: "dangerFullAccess" as const };
const conversation = {
  ...createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread([]), {
    hostId: "durable",
    model: "model",
    reasoningEffort: null,
    cwd: "/workspace",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: nativeSandbox,
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace"],
  }),
  resumeState: "resumed" as const,
  latestThreadSettings: {
    model: "model",
    effort: null,
    collaborationMode: {
      mode: "default" as const,
      settings: { model: "model", reasoning_effort: null, developer_instructions: null },
    },
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: nativeSandbox,
    serviceTier: null,
  },
};
const message: CodexQueuedMessage = {
  id: "client",
  cwd: "/workspace",
  context: {
    prompt: "Request",
    fileAttachments: [],
    addedFiles: [],
    commentAttachments: [],
    imageAttachments: [],
  },
  submissionOptions: {
    executionHostId: "durable",

    serviceTier: null,
  },
};
const admitted = (message: CodexQueuedMessage, hostId = "durable", settingsPending = false) =>
  canEnqueueNativeCodexQueue({ hostId, conversation, message, settingsPending });
describe("native queue host admission", () => {
  test("ordinary hosts prepare intelligence overrides directly while durable queues capture accepted settings", () => {
    const overridden = {
      ...message,
      submissionOptions: { ...message.submissionOptions, serviceTier: "fast" },
    };
    expect(admitted(overridden, "local", true)).toBe(true);
    expect(admitted(overridden, "ssh:work", true)).toBe(true);
    expect(admitted(overridden)).toBe(false);
  });
  test("durable queues require settled settings, the exact host and no deferred local preparation", () => {
    expect(admitted(message)).toBe(true);
    expect(admitted(message, "durable", true)).toBe(false);
    expect(
      admitted({
        ...message,
        submissionOptions: { ...message.submissionOptions, executionHostId: "local" },
      }),
    ).toBe(false);
    expect(
      admitted({
        ...message,
        submissionOptions: { ...message.submissionOptions, serviceTier: "fast" },
      }),
    ).toBe(false);
    expect(
      admitted({ ...message, context: { ...message.context, turnTrigger: "automation" } }),
    ).toBe(false);
    expect(
      admitted({ ...message, context: { ...message.context, requiresLocalPreparation: true } }),
    ).toBe(false);
  });
});
