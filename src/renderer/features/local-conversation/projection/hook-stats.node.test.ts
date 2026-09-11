import type { ThreadTranscriptBlockModel } from "../thread-stage-types";
import type { CodexConversationTurn } from "../../../lib/types";
import { bucketizeTurnItems } from "./bucketize-turn-items";
import { buildTurnViewModel } from "./build-turn-view-model";
import { describe, expect, test } from "vite-plus/test";
import type { CodexCanonicalHookRun } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { buildHookStats } from "./hook-stats";

function hook(
  id: string,
  overrides: Partial<CodexCanonicalHookRun["run"]> = {},
): CodexCanonicalHookRun {
  return {
    id,
    run: {
      id,
      eventName: "sessionStart",
      source: "user",
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: "",
      displayOrder: 0n,
      status: "completed",
      statusMessage: null,
      startedAt: 1n,
      completedAt: 2n,
      durationMs: 1n,
      entries: [],
      ...overrides,
    },
  };
}

describe("hook statistics", () => {
  test("omits empty sidecars and excludes context from visible output without losing run counts", () => {
    expect(buildHookStats(undefined)).toBeNull();
    expect(buildHookStats([])).toBeNull();
    const stats = buildHookStats([
      hook("context", { entries: [{ kind: "context", text: "Private injected context" }] }),
      hook("blocked", {
        status: "blocked",
        entries: [
          { kind: "feedback", text: "Try again" },
          { kind: "stop", text: "Stopped" },
        ],
      }),
      hook("failed", {
        status: "failed",
        entries: [
          { kind: "error", text: "Could not run" },
          { kind: "warning", text: "Check config" },
        ],
      }),
      hook("stopped", { status: "stopped" }),
    ]);
    expect(stats).toMatchObject({
      count: 4,
      blockedCount: 1,
      errorCount: 1,
      entries: [
        { kind: "feedback", text: "Try again" },
        { kind: "stop", text: "Stopped" },
        { kind: "error", text: "Could not run" },
        { kind: "warning", text: "Check config" },
      ],
    });
    expect(stats?.runs[0]?.entries).toEqual([]);
    expect(stats?.runs[2]?.entries).toEqual([
      { tone: "error", text: "Could not run" },
      { tone: "warning", text: "Check config" },
    ]);
  });

  test("coalesces only adjacent equivalent presentations, independently of status, context, and timing", () => {
    const stats = buildHookStats([
      hook("a", { statusMessage: "  Ready  ", entries: [{ kind: "error", text: "Same" }] }),
      hook("b", {
        status: "failed",
        statusMessage: "Ready",
        startedAt: 20n,
        entries: [
          { kind: "feedback", text: "Same" },
          { kind: "context", text: "Hidden" },
        ],
      }),
      hook("c", {
        source: "project",
        statusMessage: "Ready",
        entries: [{ kind: "error", text: "Same" }],
      }),
      hook("d", { statusMessage: "Ready", entries: [{ kind: "error", text: "Same" }] }),
      hook("e", { statusMessage: "Ready", entries: [{ kind: "warning", text: "Same" }] }),
      hook("f", {
        eventName: "stop",
        statusMessage: "Ready",
        entries: [{ kind: "warning", text: "Same" }],
      }),
    ]);
    expect(stats?.runs.map(({ id, count }) => ({ id, count }))).toEqual([
      { id: "a", count: 2 },
      { id: "c", count: 1 },
      { id: "d", count: 1 },
      { id: "e", count: 1 },
      { id: "f", count: 1 },
    ]);
    expect(stats?.count).toBe(6);
    expect(stats?.errorCount).toBe(1);
  });
});

function block(
  id: string,
  type: "userMessage" | "assistantMessage",
  text = "Reply",
): ThreadTranscriptBlockModel {
  return {
    id,
    turnId: "turn",
    createdAt: 1,
    updatedAt: 1,
    searchableText: text,
    type,
    status: "completed",
    entry: {
      threadId: "thread",
      turnId: "turn",
      itemId: id,
      type,
      kind: type,
      createdAt: 1,
      updatedAt: 1,
      markdownText: text,
      ...(type === "assistantMessage" ? { assistantPhase: "final_answer" as const } : {}),
    },
  };
}

function project(items: ThreadTranscriptBlockModel[], streaming = false) {
  const turn: CodexConversationTurn = {
    threadId: "thread",
    turnId: "turn",
    status: streaming ? "inProgress" : "completed",
    itemIds: items.map((item) => item.id),
    items: items.map((item) => item.entry),
    hookRuns: [hook("session")],
    finalAssistantStartedAtMs: 10,
  };
  return buildTurnViewModel({
    turnId: "turn",
    turn,
    buckets: bucketizeTurnItems({ items, turnStatus: turn.status }),
    isLatestTurn: true,
    isStreamingTurn: streaming,
    isBlocked: false,
  });
}

test("completed replies own hook statistics even without copyable content; active turns do not", () => {
  const items = [block("user", "userMessage"), block("answer", "assistantMessage", "")];
  expect(project(items).buckets.assistantItem?.assistantMessageActions).toMatchObject({
    hookStats: { count: 1 },
    copyText: null,
    sentAtMs: 10,
  });
  expect(project(items, true).buckets.assistantItem?.assistantMessageActions).toBeUndefined();
});

test("blocked input owns fallback hooks only without an assistant, while feedback keeps its own entry", () => {
  const user = block("user", "userMessage");
  user.entry.deliveryStatus = "not-sent";
  expect(project([user]).buckets.userItems[0]?.userMessageActions).toMatchObject({
    hookStats: { count: 1 },
    sentAtMs: null,
  });
  expect(
    project([user, block("answer", "assistantMessage")]).buckets.userItems[0]?.userMessageActions
      ?.hookStats,
  ).toBeNull();
  const feedback = block("feedback", "userMessage");
  feedback.entry.hookFeedback = true;
  expect(
    project([feedback, block("answer", "assistantMessage")]).buckets.userItems[0]
      ?.userMessageActions,
  ).toMatchObject({ hookStats: { count: 1 }, canEdit: false });
});

test("image-only replies place hook statistics after the gallery rather than on blocked input", () => {
  const user = block("user", "userMessage");
  user.entry.deliveryStatus = "not-sent";
  const image: ThreadTranscriptBlockModel = {
    ...block("image", "assistantMessage"),
    type: "generatedImage",
    entry: {
      ...block("image", "assistantMessage").entry,
      type: "imageGeneration",
      semanticKind: "generatedImage",
      generatedImage: { src: "data:image/png;base64,aW1hZ2U=", status: "completed" },
    },
  };
  const model = project([user, image]);
  expect(model.trailingBlocks.map((item) => item.type)).toEqual([
    "generatedImageGallery",
    "assistantActions",
  ]);
  const actions = model.trailingBlocks[1];
  expect(actions?.type === "assistantActions" && actions.actions.hookStats?.count).toBe(1);
  expect(model.buckets.userItems[0]?.userMessageActions?.hookStats).toBeNull();
});

test("inline hook feedback receives statistics without borrowing the opening prompt timestamp", () => {
  const feedback = block("feedback", "userMessage");
  feedback.entry.hookFeedback = true;
  const activity: ThreadTranscriptBlockModel = {
    ...block("exec", "assistantMessage"),
    type: "exec",
  };
  const model = project([
    block("prompt", "userMessage"),
    activity,
    feedback,
    block("answer", "assistantMessage"),
  ]);
  const inline = model.buckets.agentItems.find((item) => item.id === "feedback");
  expect(inline?.type === "userMessage" && inline.userMessageActions).toMatchObject({
    hookStats: { count: 1 },
    sentAtMs: null,
    canEdit: false,
  });
});
