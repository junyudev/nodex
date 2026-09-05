import { describe, expect, test } from "vite-plus/test";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { HookRunSummary } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "./codex-conversation-state";
import {
  reduceCodexConversationAutomaticApprovalReview,
  reduceCodexConversationError,
  reduceCodexConversationGuardianWarning,
  reduceCodexConversationHookRun,
  reduceCodexConversationModelRerouted,
  reduceCodexConversationSafetyBuffering,
  reduceCodexConversationTurnDiff,
  reduceCodexConversationTurnPlan,
} from "./codex-turn-metadata";

const THREAD_ID = "thread-turn-metadata";

function buildState(): CodexCanonicalConversationState {
  return createCodexCanonicalHydratedConversationState(
    {
      model: null,
      reasoningEffort: null,
      id: THREAD_ID,
      extra: null,
      sessionId: "session-turn-metadata",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/workspace",
      cliVersion: "test",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [
        {
          id: "turn-1",
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
          items: [],
        },
      ],
    },
    {
      model: "gpt-test",
      reasoningEffort: "high",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
      hasUnreadTurn: false,
    },
  );
}

function hookRun(status: HookRunSummary["status"], completedAt: bigint | null): HookRunSummary {
  return {
    id: "hook-1",
    eventName: "preToolUse",
    handlerType: "command",
    executionMode: "sync",
    scope: "turn",
    sourcePath: "/workspace/.codex/hook.json",
    source: "project",
    displayOrder: 1n,
    status,
    statusMessage: "Preparing context",
    startedAt: 10n,
    completedAt,
    durationMs: completedAt === null ? null : completedAt - 10n,
    entries: [],
  };
}

describe("Codex 30751 turn metadata", () => {
  test("stores diff and safety metadata on the canonical turn", () => {
    const diffed = reduceCodexConversationTurnDiff(
      buildState(),
      THREAD_ID,
      "turn-1",
      "diff --git a/file.ts b/file.ts",
      10,
    );
    const buffered = reduceCodexConversationSafetyBuffering(
      diffed.state,
      THREAD_ID,
      "turn-1",
      {
        useCases: ["latency"],
        reasons: ["warming"],
        showBufferingUi: true,
        fasterModel: "gpt-fast",
      },
      11,
    );

    expect(diffed.state.turns[0]?.sidecar.diff).toBe("diff --git a/file.ts b/file.ts");
    expect(buffered.state.turns[0]?.sidecar.safetyBuffering?.showBufferingUi).toBe(true);
    expect(buffered.state.turns[0]?.sidecar.safetyBuffering?.fasterModel).toBe("gpt-fast");
  });

  test("preserves a hook occurrence identity and suffixes repeated completed runs", () => {
    const started = reduceCodexConversationHookRun(
      buildState(),
      THREAD_ID,
      "turn-1",
      "hook/started",
      hookRun("running", null),
      20,
    );
    const completed = reduceCodexConversationHookRun(
      started.state,
      THREAD_ID,
      "turn-1",
      "hook/completed",
      hookRun("completed", 20n),
      21,
    );
    const repeated = reduceCodexConversationHookRun(
      completed.state,
      THREAD_ID,
      "turn-1",
      "hook/completed",
      hookRun("completed", 30n),
      31,
    );

    expect(started.effects[0]?.type).toBe("markConversationStreaming");
    expect(completed.state.turns[0]?.sidecar.hookRuns?.[0]?.id).toBe("hook-1");
    expect(completed.state.turns[0]?.sidecar.hookRuns?.[0]?.run.status).toBe("completed");
    expect(repeated.state.turns[0]?.sidecar.hookRuns?.[1]?.id).toBe("hook-1:1");
  });

  test("synthesizes a missing started turn and routes null hook turn ids to latest", () => {
    const empty = { ...buildState(), turns: [] };
    const synthesized = reduceCodexConversationHookRun(
      empty,
      THREAD_ID,
      "turn-synthesized",
      "hook/started",
      hookRun("running", null),
      40,
    );
    const completed = reduceCodexConversationHookRun(
      synthesized.state,
      THREAD_ID,
      null,
      "hook/completed",
      hookRun("completed", 50n),
      50,
    );

    expect(synthesized.state.turns[0]?.protocol.id).toBe("turn-synthesized");
    expect(synthesized.state.turns[0]?.sidecar.turnStartedAtMs).toBe(40);
    expect(completed.state.turns[0]?.sidecar.hookRuns?.[0]?.run.completedAt).toBe(50n);
  });

  test("appends opaque plan, reroute, and error occurrences instead of upserting fixed IDs", () => {
    const plan = {
      method: "turn/plan/updated",
      params: {
        threadId: THREAD_ID,
        turnId: "turn-1",
        explanation: "Inspect first",
        plan: [{ step: "Inspect bundle", status: "inProgress" }],
      },
    } satisfies ServerNotification;
    const firstPlan = reduceCodexConversationTurnPlan(buildState(), plan, "todo-1", 10);
    const secondPlan = reduceCodexConversationTurnPlan(firstPlan.state, plan, "todo-2", 11);
    const rerouted = reduceCodexConversationModelRerouted(
      secondPlan.state,
      {
        method: "model/rerouted",
        params: {
          threadId: THREAD_ID,
          turnId: "turn-1",
          fromModel: "gpt-a",
          toModel: "gpt-b",
          reason: "highRiskCyberActivity",
        },
      },
      "reroute-1",
      12,
    );
    const errored = reduceCodexConversationError(
      rerouted.state,
      {
        method: "error",
        params: {
          threadId: THREAD_ID,
          turnId: "turn-1",
          error: {
            message: "Tool failed",
            codexErrorInfo: null,
            additionalDetails: "exit 1",
            misalignment: null,
          },
          willRetry: false,
        },
      },
      "error-1",
      13,
    );

    expect(errored.state.turns[0]?.items.map((item) => item.id).join(",")).toBe(
      "todo-1,todo-2,reroute-1,error-1",
    );
    expect(errored.state.turns[0]?.items[2]?.type).toBe("modelRerouted");
    expect(errored.state.turns[0]?.items[3]?.type).toBe("error");
  });

  test("upserts one review occurrence, preserves its start, and appends guardian warning", () => {
    const started = reduceCodexConversationAutomaticApprovalReview(
      buildState(),
      {
        method: "item/autoApprovalReview/started",
        params: {
          threadId: THREAD_ID,
          turnId: "turn-1",
          startedAtMs: 1,
          reviewId: "review-1",
          targetItemId: "command-1",
          review: {
            status: "inProgress",
            riskLevel: "medium",
            userAuthorization: "unknown",
            rationale: null,
          },
          action: {
            type: "command",
            source: "unifiedExec",
            command: "pnpm test",
            cwd: "/workspace",
          },
        },
      },
      100,
    );
    const completed = reduceCodexConversationAutomaticApprovalReview(
      started.state,
      {
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: THREAD_ID,
          turnId: "turn-1",
          startedAtMs: 1,
          completedAtMs: 2,
          reviewId: "review-1",
          targetItemId: "command-1",
          decisionSource: "agent",
          review: {
            status: "denied",
            riskLevel: "high",
            userAuthorization: "low",
            rationale: "Too risky",
          },
          action: {
            type: "command",
            source: "unifiedExec",
            command: "pnpm test",
            cwd: "/workspace",
          },
        },
      },
      200,
    );
    const warned = reduceCodexConversationGuardianWarning(completed.state, THREAD_ID, "warning-1");
    const review = warned.state.turns[0]?.items[0];
    const event =
      review?.type === "automaticApprovalReview"
        ? (review.event as { status?: string; action?: { source?: string } })
        : null;

    expect(warned.state.turns[0]?.items.length).toBe(2);
    expect(review?.type).toBe("automaticApprovalReview");
    expect(review?.type === "automaticApprovalReview" ? review.startedAtMs : null).toBe(100);
    expect(event?.status).toBe("denied");
    expect(event?.action?.source).toBe("unified_exec");
    expect(completed.effects[0]?.type).toBe("touchConversationUpdatedAt");
    expect(warned.state.turns[0]?.items[1]?.type).toBe("autoReviewInterruptionWarning");
  });

  test("preserves stdin approval identity in automatic-review metadata", () => {
    const completed = reduceCodexConversationAutomaticApprovalReview(
      buildState(),
      {
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: THREAD_ID,
          turnId: "turn-1",
          startedAtMs: 1,
          completedAtMs: 2,
          reviewId: "review-stdin",
          targetItemId: "command-1",
          decisionSource: "agent",
          review: {
            status: "denied",
            riskLevel: "high",
            userAuthorization: "low",
            rationale: "Interactive input requires approval",
          },
          action: {
            type: "writeStdin",
            approvalId: "approval-stdin",
            processId: "process-1",
            stdin: "yes\n",
            cwd: "/workspace",
          },
        },
      },
      200,
    );
    const review = completed.state.turns[0]?.items[0];
    const action =
      review?.type === "automaticApprovalReview"
        ? (review.event as { action?: Record<string, unknown> }).action
        : null;

    expect(action).toEqual({
      type: "write_stdin",
      approval_id: "approval-stdin",
      process_id: "process-1",
      stdin: "yes\n",
      cwd: "/workspace",
    });
  });
});
