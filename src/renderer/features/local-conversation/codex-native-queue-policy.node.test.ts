import { describe, expect, test } from "vite-plus/test";
import { createCodexCanonicalHydratedConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import type { CodexQueuedMessage } from "../../../shared/codex-queued-message";
import { canEnqueueNativeCodexQueue } from "./codex-native-queue-policy";
const policy = {
  type: "workspaceWrite" as const,
  writableRoots: ["/workspace", "/extra"],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};
const conversation = {
  ...createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread([]), {
    hostId: "durable",
    model: "model",
    reasoningEffort: null,
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: policy,
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
    permissions: "profile",
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: policy,
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
    permissionProfileId: "profile",
    serviceTier: null,
  },
};
const admitted = (message: CodexQueuedMessage, hostId = "durable", settingsPending = false) =>
  canEnqueueNativeCodexQueue({ hostId, conversation, message, settingsPending });
describe("native queue host admission", () => {
  test("ordinary local and SSH do not acquire durable-only captured settings restrictions", () => {
    const overridden = {
      ...message,
      submissionOptions: { ...message.submissionOptions, shouldSendPermissionOverrides: true },
    };
    expect(admitted(overridden, "local", true)).toBe(true);
    expect(admitted(overridden, "ssh:work", true)).toBe(true);
    expect(admitted(overridden)).toBe(false);
  });
  test("durable queue uses proven profile/settings and rejects work requiring local execution", () => {
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
    const workPermissions = {
      mode: "auto",
      resolvedPermissions: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        activePermissionProfile: { id: "profile" },
        runtimeWorkspaceRoots: ["/workspace"],
        sandboxPolicy: policy,
      },
    };
    expect(admitted({ ...message, context: { ...message.context, workPermissions } })).toBe(true);
    expect(
      admitted({
        ...message,
        context: {
          ...message.context,
          workPermissions: { ...workPermissions, mode: "custom", overridden: true },
        },
      }),
    ).toBe(false);
    expect(
      admitted({
        ...message,
        context: {
          ...message.context,
          workPermissions: {
            ...workPermissions,
            resolvedPermissions: {
              ...workPermissions.resolvedPermissions,
              runtimeWorkspaceRoots: ["/different"],
            },
          },
        },
      }),
    ).toBe(false);
  });
});
