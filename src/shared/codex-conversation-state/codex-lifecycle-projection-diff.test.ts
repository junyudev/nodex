import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexItemView, CodexTranscriptEntry } from "../types";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../codex-transcript-entry-projection";
import type {
  CodexCanonicalItem,
  CodexCanonicalTurnParams,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  applyCodexLifecycleProjectionDiff,
  collectCodexLifecycleChangedRawOwnerIds,
} from "./codex-lifecycle-projection-diff";

const THREAD_ID = "thread_projection_diff";
const TURN_ID = "turn_projection_diff";

function buildTurnParams(): CodexCanonicalTurnParams {
  return {
    threadId: THREAD_ID,
    input: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    model: "fixture-model",
    cwd: "/workspace/project",
    attachments: [],
    effort: "high",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
  };
}

function buildTurn(
  items: readonly CodexCanonicalItem[],
  status: CodexCanonicalTurnState["protocol"]["status"] = "inProgress",
): CodexCanonicalTurnState {
  return {
    protocol: {
      id: TURN_ID,
      itemsView: "full",
      status,
      error: null,
      durationMs: null,
    },
    items,
    sidecar: {
      params: buildTurnParams(),
      diff: null,
      turnStartedAtMs: 1_000,
      completedAtMs: null,
      firstTurnWorkItemStartedAtMs: 1_100,
      finalAssistantStartedAtMs: null,
    },
  };
}

function buildCommand(
  id: string,
  status: "inProgress" | "completed" = "inProgress",
  output: string | null = null,
): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id,
    command: `printf ${id}`,
    cwd: "/workspace/project",
    processId: null,
    pluginId: null,
    scriptPath: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: output,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 50 : null,
  };
}

function project(item: CodexCanonicalItem, observedAtMs = 2_000): CodexItemView {
  const projected = projectCodexCanonicalTurnItemViews({
    threadId: THREAD_ID,
    turnId: TURN_ID,
    items: [item],
    observedAtMs,
    turnStatus: "inProgress",
    isBackgroundSubagentsEnabled: true,
  })[0];
  if (!projected) throw new Error(`Fixture item ${item.id} did not project`);
  return projected;
}

function transcript(view: CodexItemView, sequence: number): CodexTranscriptEntry {
  return projectCodexItemViewToTranscriptEntry(view, "live", sequence);
}

function overlay(id: string): CodexItemView {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: id,
    type: "automaticApprovalReview",
    normalizedKind: "systemEvent",
    semanticKind: "automaticApprovalReview",
    status: "inProgress",
    markdownText: "Reviewing command",
    rawItem: { id, type: "automaticApprovalReview" },
    createdAt: 1_500,
    updatedAt: 1_500,
  };
}

describe("scoped canonical lifecycle projection diff", () => {
  test("rebuilds a complete turn from params before raw items and suppresses the server echo", () => {
    const content: Extract<ThreadItem, { type: "userMessage" }>["content"] = [
      { type: "text", text: "Inspect the exact projection", text_elements: [] },
    ];
    const serverEcho = {
      type: "userMessage",
      id: "server-user-echo",
      content,
      clientId: "client-user-input",
    } satisfies Extract<ThreadItem, { type: "userMessage" }>;
    const command = buildCommand("command-after-input");
    const existingCommand = {
      ...project(command),
      approvalRequestId: "approval-command",
      createdAt: 1_250,
    } satisfies CodexItemView;
    const reviewOverlay = overlay("review-overlay");
    const baseTurn = buildTurn([serverEcho, command]);
    const afterTurn = {
      ...baseTurn,
      sidecar: {
        ...baseTurn.sidecar,
        params: {
          ...baseTurn.sidecar.params,
          clientUserMessageId: "client-user-input",
          input: content,
        },
      },
    } satisfies CodexCanonicalTurnState;

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: null,
      afterTurn,
      currentViews: [project(serverEcho), reviewOverlay, existingCommand],
      currentTranscript: [
        transcript(project(serverEcho), 0),
        transcript(reviewOverlay, 1),
        transcript(existingCommand, 2),
      ],
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => view.itemId)).toEqual([
      `${TURN_ID}:input`,
      "review-overlay",
      "command-after-input",
    ]);
    expect(result.views[0]?.markdownText).toBe("Inspect the exact projection");
    expect(result.views[2]?.approvalRequestId).toBe("approval-command");
    expect(result.views[2]?.createdAt).toBe(1_250);
    expect(result.transcript.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(result.itemIds).toEqual(["server-user-echo", "command-after-input"]);
  });

  test("projects a nullable local occurrence through the same params-first typed boundary", () => {
    const afterTurn = {
      ...buildTurn([
        {
          id: "pending-worktree:1",
          type: "worktreeInit",
          worktreeOutputText: "Worktree created",
          setup: null,
        },
      ]),
      protocol: {
        ...buildTurn([]).protocol,
        id: null,
      },
      sidecar: {
        ...buildTurn([]).sidecar,
        params: {
          ...buildTurnParams(),
          clientUserMessageId: "client-local",
          input: [{ type: "text", text: "Implement locally", text_elements: [] }],
        },
      },
    } satisfies CodexCanonicalTurnState;

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      turnKey: "turn-index-4",
      beforeTurn: null,
      afterTurn,
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => [view.itemId, view.turnId])).toStrictEqual([
      ["turn-index-4:input", null],
      ["pending-worktree:1", null],
    ]);
    expect(result.transcript.map((entry) => entry.semanticKind)).toStrictEqual([
      "userMessage",
      "worktreeInit",
    ]);
  });

  test("rebinds the optimistic params row by client id without duplicating it", () => {
    const content: Extract<ThreadItem, { type: "userMessage" }>["content"] = [
      { type: "text", text: "Keep optimistic identity", text_elements: [] },
    ];
    const serverEcho = {
      type: "userMessage",
      id: "server-user-echo",
      content,
      clientId: "client-optimistic",
    } satisfies Extract<ThreadItem, { type: "userMessage" }>;
    const baseTurn = buildTurn([serverEcho]);
    const afterTurn = {
      ...baseTurn,
      sidecar: {
        ...baseTurn.sidecar,
        params: {
          ...baseTurn.sidecar.params,
          clientUserMessageId: "client-optimistic",
          input: content,
        },
      },
    } satisfies CodexCanonicalTurnState;
    const optimisticView = {
      threadId: THREAD_ID,
      turnId: "replay:owner-turn:client-optimistic",
      itemId: "replay:owner-user:client-optimistic",
      type: "userMessage",
      normalizedKind: "userMessage",
      semanticKind: "userMessage",
      role: "user",
      status: "completed",
      markdownText: "Keep optimistic identity",
      rawItem: {
        id: "replay:owner-user:client-optimistic",
        type: "userMessage",
        clientUserMessageId: "client-optimistic",
        content,
      },
      createdAt: 1_234,
      updatedAt: 1_234,
    } satisfies CodexItemView;
    const optimisticTranscript = {
      ...transcript(optimisticView, 0),
      source: "bootstrap" as const,
    };

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: null,
      afterTurn,
      currentViews: [optimisticView],
      currentTranscript: [optimisticTranscript],
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => view.itemId)).toEqual([`${TURN_ID}:input`]);
    expect(result.views[0]?.turnId).toBe(TURN_ID);
    expect(result.views[0]?.createdAt).toBe(1_234);
    expect(result.transcript[0]?.source).toBe("bootstrap");
    expect(result.transcript[0]?.sequence).toBe(0);
  });

  test("suppresses a matching user-message echo that arrives after optimistic rebind", () => {
    const content: Extract<ThreadItem, { type: "userMessage" }>["content"] = [
      { type: "text", text: "Edited prompt", text_elements: [] },
    ];
    const baseTurn = buildTurn([]);
    const reboundTurn = {
      ...baseTurn,
      sidecar: {
        ...baseTurn.sidecar,
        params: {
          ...baseTurn.sidecar.params,
          clientUserMessageId: "client-edited-prompt",
          input: content,
        },
      },
    } satisfies CodexCanonicalTurnState;
    const optimistic = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: null,
      afterTurn: reboundTurn,
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 2_000,
    });
    const updatedContent: Extract<ThreadItem, { type: "userMessage" }>["content"] = [
      { type: "text", text: "Updated edited prompt", text_elements: [] },
    ];
    const afterParamsChange = {
      ...reboundTurn,
      sidecar: {
        ...reboundTurn.sidecar,
        params: {
          ...reboundTurn.sidecar.params,
          input: updatedContent,
        },
      },
    } satisfies CodexCanonicalTurnState;
    const paramsChanged = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: reboundTurn,
      afterTurn: afterParamsChange,
      currentViews: optimistic.views,
      currentTranscript: optimistic.transcript,
      observedAtMs: 2_500,
    });
    expect(paramsChanged.views.map((view) => view.markdownText)).toEqual(["Updated edited prompt"]);

    const serverEcho = {
      type: "userMessage",
      id: "server-user-echo",
      clientId: "client-edited-prompt",
      content,
    } satisfies Extract<ThreadItem, { type: "userMessage" }>;
    const afterEcho = {
      ...reboundTurn,
      items: [serverEcho],
    } satisfies CodexCanonicalTurnState;

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: reboundTurn,
      afterTurn: afterEcho,
      currentViews: optimistic.views,
      currentTranscript: optimistic.transcript,
      observedAtMs: 3_000,
      lifecycleStatus: "inProgress",
    });

    expect(result.views.map((view) => view.itemId)).toEqual([`${TURN_ID}:input`]);
    expect(result.transcript.map((entry) => entry.itemId)).toEqual([`${TURN_ID}:input`]);
    expect(result.views[0]?.createdAt).toBe(optimistic.views[0]?.createdAt);
    expect(result.transcript[0]?.source).toBe(optimistic.transcript[0]?.source);
    expect(result.transcript[0]?.createdAt).toBe(optimistic.transcript[0]?.createdAt);
    expect(result.itemIds).toEqual(["server-user-echo"]);

    const command = buildCommand("command-before-echo");
    const afterActivity = {
      ...afterEcho,
      items: [command, serverEcho],
    } satisfies CodexCanonicalTurnState;
    const visibleAfterActivity = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: afterEcho,
      afterTurn: afterActivity,
      currentViews: result.views,
      currentTranscript: result.transcript,
      observedAtMs: 4_000,
      lifecycleStatus: "inProgress",
    });

    expect(visibleAfterActivity.views.map((view) => view.itemId)).toEqual([
      `${TURN_ID}:input`,
      "command-before-echo",
      "server-user-echo",
    ]);
    expect(visibleAfterActivity.views.map((view) => view.semanticKind)).toEqual([
      "userMessage",
      "exec",
      "steered",
    ]);
    expect(visibleAfterActivity.transcript.map((entry) => entry.itemId)).toEqual([
      `${TURN_ID}:input`,
      "command-before-echo",
      "server-user-echo",
    ]);
  });

  test("replaces only the changed raw owner and preserves unrelated streamed state and overlays", () => {
    const startedA = buildCommand("command-a");
    const startedB = buildCommand("command-b");
    const completedA = buildCommand("command-a", "completed", "final-a\n");
    const streamedB = {
      ...project(startedB, 1_200),
      aggregatedOutput: "streamed-b\n",
      rawItem: { ...startedB, aggregatedOutput: "streamed-b\n" },
    } satisfies CodexItemView;
    const review = overlay("review-overlay");
    const currentA = {
      ...project(startedA, 1_100),
      approvalRequestId: "approval-a",
      createdAt: 1_100,
    } satisfies CodexItemView;
    const currentTranscript = [
      transcript(currentA, 0),
      transcript(streamedB, 1),
      transcript(review, 2),
    ];

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([startedA, startedB]),
      afterTurn: buildTurn([completedA, startedB]),
      currentViews: [currentA, streamedB, review],
      currentTranscript,
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual(["command-a"]);
    expect(result.itemIds).toEqual(["command-a", "command-b"]);
    expect(result.views.map((view) => view.itemId)).toEqual([
      "command-a",
      "command-b",
      "review-overlay",
    ]);
    expect(result.views[0]?.aggregatedOutput).toBe("final-a\n");
    expect(result.views[0]?.approvalRequestId).toBe("approval-a");
    expect(result.views[0]?.createdAt).toBe(1_100);
    expect(result.views[1]).toBe(streamedB);
    expect(result.views[1]?.aggregatedOutput).toBe("streamed-b\n");
    expect(result.views[2]).toBe(review);
    expect(result.transcript[1]).toBe(currentTranscript[1]);
    expect(result.transcript[2]).toBe(currentTranscript[2]);
  });

  test("can preserve the existing view timestamp for non-lifecycle raw mutations", () => {
    const started = buildCommand("command-output");
    const withOutput = { ...started, aggregatedOutput: "streamed output\n" };
    const current = {
      ...project(started, 1_200),
      createdAt: 1_100,
      updatedAt: 1_250,
    } satisfies CodexItemView;

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([started]),
      afterTurn: buildTurn([withOutput]),
      currentViews: [current],
      currentTranscript: [transcript(current, 0)],
      observedAtMs: 3_000,
      preserveExistingUpdatedAt: true,
    });

    expect(result.views[0]?.aggregatedOutput).toBe("streamed output\n");
    expect(result.views[0]?.createdAt).toBe(1_100);
    expect(result.views[0]?.updatedAt).toBe(1_250);
  });

  test("reprojects statusless items when only the lifecycle sidecar changes", () => {
    const reasoning = {
      type: "reasoning",
      id: "reasoning-only-status",
      summary: ["Checking the patch stream."],
      content: [],
    } satisfies Extract<ThreadItem, { type: "reasoning" }>;
    const base = buildTurn([reasoning]);
    const beforeTurn = {
      ...base,
      sidecar: {
        ...base.sidecar,
        lifecycleStatusByItemId: { [reasoning.id]: "inProgress" as const },
      },
    } satisfies CodexCanonicalTurnState;
    const afterTurn = {
      ...beforeTurn,
      sidecar: {
        ...beforeTurn.sidecar,
        lifecycleStatusByItemId: { [reasoning.id]: "completed" as const },
      },
    } satisfies CodexCanonicalTurnState;
    const currentViews = projectCodexCanonicalTurnItemViews({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      items: beforeTurn.items,
      observedAtMs: 2_000,
      turnStatus: beforeTurn.protocol.status,
      lifecycleStatusByItemId: beforeTurn.sidecar.lifecycleStatusByItemId,
      isBackgroundSubagentsEnabled: true,
    });

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn,
      afterTurn,
      currentViews,
      currentTranscript: currentViews.map(transcript),
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual([]);
    expect(result.views[0]?.status).toBe("completed");
    expect(result.transcript[0]?.status).toBe("completed");
  });

  test("stabilizes a display alias by explicit canonical raw owner type and id", () => {
    const started = {
      type: "agentMessage",
      id: "assistant-alias",
      text: "",
      phase: null,
      memoryCitation: null,
      delivery: null,
    } satisfies Extract<ThreadItem, { type: "agentMessage" }>;
    const streamed = { ...started, text: "partial" };
    const current = {
      ...project(started, 1_200),
      type: "message",
      status: "inProgress",
      createdAt: 1_100,
      updatedAt: 1_250,
    } satisfies CodexItemView;

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([started]),
      afterTurn: buildTurn([streamed]),
      currentViews: [current],
      currentTranscript: [transcript(current, 0)],
      observedAtMs: 3_000,
      preserveExistingUpdatedAt: true,
    });

    expect(result.views[0]?.markdownText).toBe("partial");
    expect(result.views[0]?.status).toBe("inProgress");
    expect(result.views[0]?.createdAt).toBe(1_100);
    expect(result.views[0]?.updatedAt).toBe(1_250);
  });

  test("retains hidden raw identities and exact raw order while removing their former visible row", () => {
    const before = buildCommand("before");
    const visibleTarget = buildCommand("target");
    const after = buildCommand("after");
    const hiddenTarget = {
      type: "enteredReviewMode",
      id: "target",
      review: "Review target",
    } satisfies Extract<ThreadItem, { type: "enteredReviewMode" }>;
    const currentViews = [project(before), project(visibleTarget), project(after)];

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([before, visibleTarget, after]),
      afterTurn: buildTurn([before, hiddenTarget, after]),
      currentViews,
      currentTranscript: currentViews.map(transcript),
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual(["target"]);
    expect(result.itemIds).toEqual(["before", "target", "after"]);
    expect(result.views.map((view) => view.itemId)).toEqual(["before", "after"]);
    expect(result.views[0]).toBe(currentViews[0]);
    expect(result.views[1]).toBe(currentViews[2]);
  });

  test("removes a pending compaction owner without rolling back an unchanged assistant delta", () => {
    const pendingCompaction = {
      type: "contextCompaction",
      id: "pending-manual-context-compaction",
      completed: false,
      source: "manual",
    } satisfies CodexCanonicalItem;
    const startedCompaction = {
      type: "contextCompaction",
      id: "context-compaction-1",
      completed: false,
      source: "manual",
    } satisfies CodexCanonicalItem;
    const assistant = {
      type: "agentMessage",
      id: "assistant-1",
      text: "",
      phase: null,
      memoryCitation: null,
      delivery: null,
    } satisfies Extract<ThreadItem, { type: "agentMessage" }>;
    const streamedAssistant = {
      ...project(assistant),
      markdownText: "streamed assistant text",
      rawItem: { ...assistant, text: "streamed assistant text" },
    } satisfies CodexItemView;
    const currentPending = project(pendingCompaction);

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([pendingCompaction, assistant]),
      afterTurn: buildTurn([startedCompaction, assistant]),
      currentViews: [currentPending, streamedAssistant],
      currentTranscript: [transcript(currentPending, 0), transcript(streamedAssistant, 1)],
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual([
      "pending-manual-context-compaction",
      "context-compaction-1",
    ]);
    expect(result.itemIds).toEqual(["context-compaction-1", "assistant-1"]);
    expect(result.views.map((view) => view.itemId)).toEqual([
      "context-compaction-1",
      "assistant-1",
    ]);
    expect(result.views[1]).toBe(streamedAssistant);
    expect(result.views[1]?.markdownText).toBe("streamed assistant text");
  });

  test("projects every changed duplicate raw slot in canonical order", () => {
    const firstStarted = buildCommand("duplicate");
    const secondStarted = buildCommand("duplicate");
    const firstCompleted = buildCommand("duplicate", "completed", "first final\n");
    const current = project(firstStarted);

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([firstStarted, secondStarted]),
      afterTurn: buildTurn([firstCompleted, secondStarted]),
      currentViews: [current],
      currentTranscript: [transcript(current, 0)],
      observedAtMs: 3_000,
    });

    expect(
      collectCodexLifecycleChangedRawOwnerIds(
        [firstStarted, secondStarted],
        [firstCompleted, secondStarted],
      ),
    ).toEqual(["duplicate"]);
    expect(result.itemIds).toEqual(["duplicate", "duplicate"]);
    expect(result.views).toHaveLength(2);
    expect(result.views[0]?.rawItem).toBe(firstCompleted);
    expect(result.views[1]?.rawItem).toBe(secondStarted);
    expect(result.views[0]?.aggregatedOutput).toBe("first final\n");
    expect(result.views[1]?.aggregatedOutput).toBeNull();
  });

  test("reorders unchanged same-type raw references instead of preserving stale view order", () => {
    const first = buildCommand("first");
    const second = buildCommand("second");
    const review = overlay("review-overlay");
    const currentViews = [project(first), review, project(second)];

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([first, second]),
      afterTurn: buildTurn([second, first]),
      currentViews,
      currentTranscript: currentViews.map(transcript),
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual(["first", "second"]);
    expect(result.views.map((view) => view.itemId)).toEqual(["second", "first", "review-overlay"]);
    expect(result.views[2]).toBe(review);
    expect(result.transcript.map((entry) => entry.itemId)).toEqual([
      "second",
      "first",
      "review-overlay",
    ]);
  });

  test("reprojects every non-positional owner affected by a terminal turn status", () => {
    const command = buildCommand("running-command");
    const mcp = {
      type: "mcpToolCall",
      id: "running-mcp",
      server: "fixture",
      tool: "lookup",
      status: "inProgress",
      arguments: {},
      appContext: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    } satisfies Extract<ThreadItem, { type: "mcpToolCall" }>;
    const compaction = {
      type: "contextCompaction",
      id: "running-compaction",
      completed: false,
      source: "automatic",
    } satisfies CodexCanonicalItem;
    const review = {
      type: "automaticApprovalReview",
      id: "running-review",
      targetItemId: command.id,
      action: { type: "applyPatch", cwd: "/workspace/project", files: [] },
      startedAtMs: 1_200,
      completedAtMs: null,
      event: null,
      status: "inProgress",
      riskLevel: null,
      userAuthorization: null,
      rationale: null,
    } satisfies CodexCanonicalItem;
    const assistant = {
      type: "agentMessage",
      id: "last-assistant",
      text: "Done",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    } satisfies Extract<ThreadItem, { type: "agentMessage" }>;
    const items = [command, mcp, compaction, review, assistant] as const;
    const currentViews = projectCodexCanonicalTurnItemViews({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      items,
      observedAtMs: 2_000,
      turnStatus: "inProgress",
      isBackgroundSubagentsEnabled: true,
    });

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn(items),
      afterTurn: buildTurn(items, "interrupted"),
      currentViews,
      currentTranscript: currentViews.map(transcript),
      observedAtMs: 3_000,
    });
    const byId = new Map(result.views.map((view) => [view.itemId, view]));

    expect(result.changedRawOwnerIds).toEqual([]);
    expect(byId.get(command.id)?.status).toBe("interrupted");
    expect(byId.get(mcp.id)?.mcpToolCall?.completed).toBe(true);
    expect(byId.get(compaction.id)?.contextCompaction?.completed).toBe(true);
    expect(byId.get(review.id)?.status).toBe("completed");
    expect(byId.get(review.id)?.markdownText).not.toBe(
      currentViews.find((view) => view.itemId === review.id)?.markdownText,
    );
    expect(byId.get(assistant.id)?.status).toBe("completed");
  });

  test("keeps an overlay anchored after the raw owner it followed", () => {
    const startedA = buildCommand("command-a");
    const completedA = buildCommand("command-a", "completed", "final-a\n");
    const commandB = buildCommand("command-b");
    const review = overlay("review-overlay");
    const currentA = project(startedA);
    const currentB = project(commandB);

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([startedA, commandB]),
      afterTurn: buildTurn([completedA, commandB]),
      currentViews: [currentA, review, currentB],
      currentTranscript: [transcript(currentA, 0), transcript(review, 1), transcript(currentB, 2)],
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => view.itemId)).toEqual([
      "command-a",
      "review-overlay",
      "command-b",
    ]);
    expect(result.views[1]).toBe(review);
  });

  test("rebuilds params identity while rebinding unchanged rows and overlays", () => {
    const command = buildCommand("command-a");
    const review = overlay("review-overlay");
    const content: Extract<ThreadItem, { type: "userMessage" }>["content"] = [
      { type: "text", text: "Bind this occurrence", text_elements: [] },
    ];
    const base = buildTurn([command]);
    const before = {
      ...base,
      protocol: { ...base.protocol, id: null },
      sidecar: {
        ...base.sidecar,
        params: {
          ...base.sidecar.params,
          clientUserMessageId: "client-rebind",
          input: content,
        },
      },
    } satisfies CodexCanonicalTurnState;
    const after = {
      ...before,
      protocol: { ...before.protocol, id: TURN_ID },
    } satisfies CodexCanonicalTurnState;
    const optimistic = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      turnKey: "turn-index-2",
      beforeTurn: null,
      afterTurn: before,
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 2_000,
    });
    const currentReview = { ...review, turnId: null };
    const currentViews = [...optimistic.views, currentReview];
    const currentTranscript = [
      ...optimistic.transcript,
      transcript(currentReview, optimistic.transcript.length),
    ];

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: before,
      afterTurn: after,
      currentViews,
      currentTranscript,
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => view.itemId)).toStrictEqual([
      `${TURN_ID}:input`,
      "command-a",
      "review-overlay",
    ]);
    expect(result.views.filter((view) => view.semanticKind === "userMessage")).toHaveLength(1);
    expect(result.views[0]?.turnId).toBe(TURN_ID);
    expect(result.views[1]?.turnId).toBe(TURN_ID);
    expect(result.transcript[0]?.turnId).toBe(TURN_ID);
    expect(result.transcript[1]?.turnId).toBe(TURN_ID);
    expect(result.transcript[0]?.source).toBe(optimistic.transcript[0]?.source);
    expect(result.transcript[0]?.createdAt).toBe(optimistic.transcript[0]?.createdAt);
  });

  test("publishes hook feedback and generated images from the typed canonical path", () => {
    const hookPrompt = {
      type: "hookPrompt",
      id: "hook-feedback",
      fragments: [{ text: "Please adjust", hookRunId: "hook-run" }],
    } satisfies Extract<ThreadItem, { type: "hookPrompt" }>;
    const generatedImage = {
      type: "imageGeneration",
      id: "generated-image",
      status: "completed",
      revisedPrompt: null,
      result: "aW1hZ2U=",
      failure: null,
      src: "data:image/png;base64,aW1hZ2U=",
    } satisfies CodexCanonicalItem;

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([]),
      afterTurn: buildTurn([hookPrompt, generatedImage]),
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => view.itemId)).toEqual(["hook-feedback", "generated-image"]);
    expect(result.views[0]?.hookFeedback).toBe(true);
    expect(result.views[1]?.generatedImage?.src).toBe("data:image/png;base64,aW1hZ2U=");
  });

  test("reprojects image-run neighbors when a hidden raw item splits the run", () => {
    const first = {
      type: "imageView",
      id: "image-1",
      path: "/tmp/1.png",
    } satisfies Extract<ThreadItem, { type: "imageView" }>;
    const second = {
      type: "imageView",
      id: "image-2",
      path: "/tmp/2.png",
    } satisfies Extract<ThreadItem, { type: "imageView" }>;
    const hidden = {
      type: "sleep",
      id: "sleep-between-images",
      durationMs: 1,
    } satisfies Extract<ThreadItem, { type: "sleep" }>;
    const currentViews = projectCodexCanonicalTurnItemViews({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      items: [first, second],
      observedAtMs: 2_000,
      turnStatus: "inProgress",
    });

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([first, second]),
      afterTurn: buildTurn([first, hidden, second]),
      currentViews,
      currentTranscript: currentViews.map(transcript),
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual(["sleep-between-images"]);
    expect(result.views).toHaveLength(2);
    expect(result.views[0]?.imageViewPaths?.join(",")).toBe("/tmp/1.png");
    expect(result.views[1]?.imageViewPaths?.join(",")).toBe("/tmp/2.png");
  });

  test("reprojects the unchanged former last-work row when a new work item is appended", () => {
    const webSearch = {
      type: "webSearch",
      id: "web-last",
      query: "projection dependency",
      action: null,
      results: null,
    } satisfies Extract<ThreadItem, { type: "webSearch" }>;
    const command = buildCommand("new-last-work");
    const currentWeb = project(webSearch);

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([webSearch]),
      afterTurn: buildTurn([webSearch, command]),
      currentViews: [currentWeb],
      currentTranscript: [transcript(currentWeb, 0)],
      observedAtMs: 3_000,
    });

    expect(result.changedRawOwnerIds).toEqual(["new-last-work"]);
    expect(result.views[0]?.webSearch?.completed).toBe(true);
    expect(result.views[1]?.itemId).toBe("new-last-work");
  });

  test("stabilizes each split command action by projected identity", () => {
    const started = {
      ...buildCommand("split-command"),
      commandActions: [
        { type: "unknown", command: "first" },
        { type: "unknown", command: "second" },
      ],
    } satisfies Extract<ThreadItem, { type: "commandExecution" }>;
    const completed = {
      ...started,
      status: "completed",
      aggregatedOutput: "done\n",
      exitCode: 0,
      durationMs: 5,
    } satisfies Extract<ThreadItem, { type: "commandExecution" }>;
    const currentViews = projectCodexCanonicalTurnItemViews({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      items: [started],
      observedAtMs: 1_000,
      turnStatus: "inProgress",
    }).map((view, index) => ({
      ...view,
      createdAt: 1_100 + index,
    }));

    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: buildTurn([started]),
      afterTurn: buildTurn([completed]),
      currentViews,
      currentTranscript: currentViews.map(transcript),
      observedAtMs: 3_000,
    });

    expect(result.views.map((view) => view.createdAt)).toEqual([1_100, 1_101]);
    expect(result.views.map((view) => view.itemId)).toEqual(["split-command:0", "split-command:1"]);
  });
});
