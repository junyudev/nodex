import { describe, expect, test } from "vite-plus/test";
import type {
  CodexConversationSnapshot,
  CodexPermissionState,
  CodexScheduledAutomation,
} from "../../../shared/types";
import {
  buildHeartbeatAutomationThreadState,
  listHeartbeatAutomationTargetThreadIds,
  shouldResumeHeartbeatAutomationTarget,
} from "./heartbeat-automation-controller";

function automation(overrides: Partial<CodexScheduledAutomation> = {}): CodexScheduledAutomation {
  return {
    id: "heartbeat",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: "thread-1",
    name: "Follow up",
    prompt: "Check in.",
    rrule: "FREQ=MINUTELY;INTERVAL=5",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function conversation(
  overrides: Partial<CodexConversationSnapshot> = {},
): CodexConversationSnapshot {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    source: null,
    threadName: "Thread",
    threadPreview: "",
    cwd: "/repo/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: new Date(0).toISOString(),
    turns: [],
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
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: false,
      canCollapseTurns: false,
    },
    resumeState: "resumed",
    latestCollaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-5",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    },
    latestThreadSettings: null,
    latestTokenUsageInfo: null,
    threadGoal: null,
    completedThreadGoal: null,
    threadGoalResumeConfirmation: null,
    ...overrides,
  };
}

function permissionState(overrides: Partial<CodexPermissionState> = {}): CodexPermissionState {
  return {
    mode: "auto",
    effectivePreset: "auto",
    availableModes: ["auto"],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxMode: "workspace-write",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["/repo/project"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    autoReviewAvailable: false,
    configTarget: { source: "none", filePath: null },
    ...overrides,
  };
}

describe("heartbeat automation controller helpers", () => {
  test("selects unique active heartbeat target thread ids", () => {
    const ids = listHeartbeatAutomationTargetThreadIds([
      automation({ id: "one", targetThreadId: "thread-1" }),
      automation({ id: "two", targetThreadId: "thread-1" }),
      automation({ id: "paused", status: "PAUSED", targetThreadId: "thread-2" }),
      automation({ id: "cron", kind: "cron", targetThreadId: null, cwds: ["/repo/project"] }),
      automation({ id: "blank", targetThreadId: " " }),
    ]);

    expect(JSON.stringify(ids)).toBe(JSON.stringify(["thread-1"]));
  });

  test("builds eligible thread state with collaboration mode and permissions", () => {
    const state = buildHeartbeatAutomationThreadState({
      threadId: "thread-1",
      conversation: conversation(),
      permissionState: permissionState(),
      streamRole: "owner",
    });

    expect(state.isEligible).toBe(true);
    expect(state.reason).toBe(null);
    expect(typeof state.collaborationMode === "object" ? state.collaborationMode?.mode : null).toBe(
      "plan",
    );
    expect(state.permissions?.approvalPolicy).toBe("on-request");
    expect(state.permissions?.sandboxPolicy?.type).toBe("workspaceWrite");
  });

  test("marks missing or blocked conversations ineligible and resumable", () => {
    expect(shouldResumeHeartbeatAutomationTarget(null)).toBe(true);
    expect(
      shouldResumeHeartbeatAutomationTarget(conversation({ resumeState: "needs_resume" })),
    ).toBe(true);
    expect(shouldResumeHeartbeatAutomationTarget(conversation())).toBe(false);

    const missing = buildHeartbeatAutomationThreadState({
      threadId: "thread-1",
      conversation: null,
      permissionState: null,
      streamRole: "owner",
    });
    expect(missing.isEligible).toBe(false);
    expect(missing.reason).toBe("conversation_missing");

    const waiting = buildHeartbeatAutomationThreadState({
      threadId: "thread-1",
      conversation: conversation({ statusActiveFlags: ["waitingOnApproval"] }),
      permissionState: permissionState(),
      streamRole: "owner",
    });
    expect(waiting.isEligible).toBe(false);
    expect(waiting.reason).toBe("waiting_on_approval");

    const follower = buildHeartbeatAutomationThreadState({
      threadId: "thread-1",
      conversation: conversation(),
      permissionState: permissionState(),
      streamRole: "follower",
    });
    expect(follower.isEligible).toBe(false);
    expect(follower.reason).toBe("not_conversation_owner");
  });
});
