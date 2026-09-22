import { describe, expect, test } from "vite-plus/test";
import type {
  CodexConversationItem,
  CodexConversationTurn,
  CodexOptionPickerRequest,
  CodexPermissionRequest,
} from "../../../lib/types";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";
import type { VisibleConversationTurnEntry } from "../selectors";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadTurnModel,
} from "../thread-stage-types";
import { buildTurnRenderModel, createTurnRenderModelSelector } from "./build-turn-render-model";

const LIVE_DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  "-old",
  "+new",
  "+next",
].join("\n");

const PROJECTLESS_MIXED_DIFF = [
  "diff --git a/output/inside.ts b/output/inside.ts",
  "--- a/output/inside.ts",
  "+++ b/output/inside.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/outside.ts b/src/outside.ts",
  "--- a/src/outside.ts",
  "+++ b/src/outside.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function buildTurn(overrides: Partial<CodexConversationTurn> = {}): CodexConversationTurn {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "inProgress",
    itemIds: [],
    items: [],
    ...overrides,
  };
}

function buildVisibleEntry(
  turn: CodexConversationTurn,
  isMostRecentTurn = true,
): VisibleConversationTurnEntry {
  const turnKey = turn.turnId ?? "turn-index-0";
  return {
    turn,
    turnId: turn.turnId,
    turnKey,
    turnSearchKey: turnKey,
    requests: [],
    isMostRecentTurn,
  };
}

function buildTurnDiffItem(overrides: Partial<CodexConversationItem> = {}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "turn-diff:turn_1",
    entryId: "turn-diff:turn_1",
    type: "turn_diff",
    kind: "systemEvent",
    semanticKind: "diff",
    status: "inProgress",
    rawItem: {
      type: "turn-diff",
      unifiedDiff: LIVE_DIFF,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildSubagentActivityItem(): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "subagent_activity_1",
    entryId: "subagent_activity_1",
    type: "subAgentActivity",
    kind: "systemEvent",
    semanticKind: "subAgentActivity",
    subagentActivity: {
      agentThreadId: "thread_child",
      displayName: "Scout",
      displayStatus: "active",
    },
    rawItem: {
      id: "subagent_activity_1",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "thread_child",
      agentPath: "Scout",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildBackgroundAgent(
  overrides: Partial<ThreadComposerShellBackgroundAgentRowModel> = {},
): ThreadComposerShellBackgroundAgentRowModel {
  return {
    conversationId: "thread_child",
    parentConversationId: "thread_1",
    parentTurnKey: "turn_1",
    displayName: "Scout",
    actorName: "Scout",
    agentRole: null,
    spawnModel: null,
    status: "active",
    statusSummary: null,
    lastAssistantMessage: null,
    lastAssistantMessageAtMs: null,
    recencyAtMs: 1,
    showInlineActivity: true,
    canInteract: false,
    diffStats: null,
    role: "backgroundChild",
    ...overrides,
  };
}

function readFirstSubagentActivityStatus(
  model: ReturnType<typeof buildTurnRenderModel>,
): string | null {
  for (const unit of model.agentBodyUnits) {
    const entries =
      unit.block.type === "agentActivityGroup"
        ? unit.block.entries
        : unit.block.type === "subagentActivityInlineGroup"
          ? [unit.block]
          : [];
    const subagent = entries.find((entry) => entry.type === "subagentActivityInlineGroup");
    if (subagent?.type === "subagentActivityInlineGroup") {
      return subagent.subagentActivityRows?.[0]?.activityStatus ?? null;
    }
  }
  return null;
}

function buildFileChangeItem(
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "patch_live",
    entryId: "patch_live",
    type: "file_change",
    kind: "fileChange",
    semanticKind: "patch",
    status: "inProgress",
    fileChange: {
      changes: buildCodexFileChangeMap([
        {
          type: "add",
          path: "src/app.ts",
          content: "new",
        },
      ]),
      label: "Created src/app.ts",
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildUserItem(overrides: Partial<CodexConversationItem> = {}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "user_1",
    entryId: "user_1",
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: "Run the checks",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildExecItem(overrides: Partial<CodexConversationItem> = {}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "exec_1",
    entryId: "exec_1",
    type: "command_execution",
    kind: "commandExecution",
    semanticKind: "exec",
    status: "inProgress",
    commandActions: [{ type: "unknown", command: "bun test" }],
    toolCall: {
      subtype: "command",
      toolName: "exec_command",
      args: {},
    },
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function buildDynamicToolItem(
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "dynamic_1",
    entryId: "dynamic_1",
    type: "dynamic_tool_call",
    kind: "toolCall",
    semanticKind: "dynamicToolCall",
    status: "inProgress",
    dynamicToolCall: {
      callId: "dynamic_1",
      namespace: "codex_app",
      tool: "read_thread",
      arguments: { threadId: "thread_child" },
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
      completed: false,
    },
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function buildMcpToolItem(overrides: Partial<CodexConversationItem> = {}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "mcp_1",
    entryId: "mcp_1",
    type: "mcp_tool_call",
    kind: "toolCall",
    semanticKind: "mcpToolCall",
    status: "inProgress",
    mcpToolCall: {
      callId: "mcp_1",
      functionName: "browser-use__click",
      pluginId: null,
      readOnlyHint: false,
      mcpAppResourceUri: undefined,
      source: null,
      invocation: { server: "browser-use", tool: "click", arguments: {} },
      result: null,
      durationMs: null,
      completed: false,
    },
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function buildReasoningItem(overrides: Partial<CodexConversationItem> = {}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "reasoning_1",
    entryId: "reasoning_1",
    type: "reasoning",
    kind: "reasoning",
    semanticKind: "reasoning",
    markdownText: "Inspecting the renderer",
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function findRenderedActivityEntry(
  model: ThreadTurnModel,
  itemId: string,
): CodexConversationItem | null {
  for (const unit of model.agentBodyUnits) {
    if (unit.block.type === "agentActivityGroup") {
      const entry = unit.block.entries.find((candidate) => candidate.entry.itemId === itemId);
      if (entry) return entry.entry;
      continue;
    }
    if ("entry" in unit.block && unit.block.entry.itemId === itemId) {
      return unit.block.entry;
    }
  }
  return null;
}

function buildAssistantItem(overrides: Partial<CodexConversationItem> = {}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "assistant_1",
    entryId: "assistant_1",
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    assistantPhase: "final_answer",
    role: "assistant",
    markdownText: "Done",
    status: "completed",
    createdAt: 5,
    updatedAt: 5,
    ...overrides,
  };
}

function buildModelChangedItem(
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "model_changed_1",
    entryId: "model_changed_1",
    type: "model_changed",
    kind: "systemEvent",
    semanticKind: "modelChanged",
    markdownText: "Model changed",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function buildPermissionRequest(completed = false): CodexPermissionRequest {
  return {
    type: "permissionRequest",
    requestId: "permission-1",
    projectId: "project-1",
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "permission-item-1",
    cwd: "/workspace/nodex",
    reason: "Allow the test runner to access the network",
    permissions: {
      network: { enabled: true },
      fileSystem: null,
    },
    response: null,
    completed,
    createdAt: 3,
  };
}

function buildOptionPickerRequest(): CodexOptionPickerRequest {
  return {
    type: "optionPicker",
    requestId: "option-1",
    projectId: "project-1",
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "option-item-1",
    question: "Choose the next slice",
    options: [{ label: "Composer", description: "Wire the request lane" }],
    allowMultiple: false,
    submitLabel: null,
    skipLabel: null,
    createdAt: 3,
  };
}

describe("buildTurnRenderModel", () => {
  test("refreshes subagent activity from the background-agent catalog for the parent turn", () => {
    const turn = buildTurn({
      itemIds: ["subagent_activity_1"],
      items: [buildSubagentActivityItem()],
    });
    const entry = buildVisibleEntry(turn);
    const selectModel = createTurnRenderModelSelector();
    const active = selectModel({
      entry,
      backgroundAgents: [buildBackgroundAgent()],
    });
    const done = selectModel({
      entry,
      backgroundAgents: [buildBackgroundAgent({ status: "done" })],
    });

    expect(readFirstSubagentActivityStatus(active)).toBe("started");
    expect(readFirstSubagentActivityStatus(done)).toBe("done");
    expect(done).not.toBe(active);
  });

  test("uses no-anchor subagent state for auto-collapse without creating an inline leaf", () => {
    const turn = buildTurn({
      status: "completed",
      itemIds: ["exec_1", "assistant_1"],
      items: [buildExecItem({ status: "completed" }), buildAssistantItem()],
    });
    const active = buildTurnRenderModel({
      turn,
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
      backgroundAgents: [buildBackgroundAgent()],
    });
    const done = buildTurnRenderModel({
      turn,
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
      backgroundAgents: [buildBackgroundAgent({ status: "done" })],
    });

    expect(active.hasRenderableAgentBodyUnits).toBe(true);
    expect(active.defaultAgentBodyCollapsed).toBe(false);
    expect(done.defaultAgentBodyCollapsed).toBe(true);
    expect(active.blocks.some((block) => block.type === "subagentActivityInlineGroup")).toBe(false);
  });

  test("lets a no-anchor subagent move commentary into activity while live Thinking stays standalone", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        itemIds: ["assistant_1"],
        items: [
          buildAssistantItem({
            assistantPhase: "commentary",
            markdownText: "I delegated the audit and will keep working.",
          }),
        ],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
      backgroundAgents: [buildBackgroundAgent()],
    });

    expect(model.agentBodyUnits.map((unit) => unit.block.type)).toEqual(["assistantMessage"]);
    expect(model.trailingBlocks).toEqual([]);
    expect(model.liveActivity).toMatchObject({
      global: {
        state: { type: "thinking", isVisible: true },
        reason: "between-activities",
      },
      fallback: { owner: "standalone", reason: "global-thinking" },
    });
    expect(model.blocks.some((block) => block.type === "subagentActivityInlineGroup")).toBe(false);
  });

  test("projects one main-surface model per stable entry and action policy", () => {
    let projectionCount = 0;
    const selectModel = createTurnRenderModelSelector((input) => {
      projectionCount += 1;
      return buildTurnRenderModel(input);
    });
    const entry = buildVisibleEntry(buildTurn());

    const bodyRead = selectModel({ entry });
    const fixedOwnerRead = selectModel({ entry });
    const virtualRowRead = selectModel({ entry });
    const navigationRead = selectModel({ entry });

    expect(bodyRead).toBe(fixedOwnerRead);
    expect(bodyRead).toBe(virtualRowRead);
    expect(bodyRead).toBe(navigationRead);
    expect(bodyRead.isLatestTurn).toBe(true);
    expect(bodyRead.isStreamingTurn).toBe(true);
    expect(projectionCount).toBe(1);

    const previewRead = selectModel({ entry, surface: "preview" });
    expect(previewRead === bodyRead).toBe(false);
    expect(projectionCount).toBe(2);

    const interactiveRead = selectModel({ entry, canEditTurnUserPrefix: true });
    expect(interactiveRead === bodyRead).toBe(false);
    expect(projectionCount).toBe(3);
  });

  test("refreshes identity-stable live items once per canonical turn revision", () => {
    let projectionCount = 0;
    const selectModel = createTurnRenderModelSelector((input) => {
      projectionCount += 1;
      return buildTurnRenderModel(input);
    });
    const reasoning = buildReasoningItem();
    const patch = buildFileChangeItem();
    const command = buildExecItem();
    const mcp = buildMcpToolItem();
    const turn = buildTurn({
      itemIds: [reasoning.itemId, patch.itemId, command.itemId, mcp.itemId],
      items: [reasoning, patch, command, mcp],
    });
    const entry = buildVisibleEntry(turn);

    const initial = selectModel({ entry });
    expect(selectModel({ entry })).toBe(initial);
    expect(projectionCount).toBe(1);

    reasoning.markdownText = "Preparing the large patch";
    reasoning.updatedAt = 3;
    const afterReasoningDelta = selectModel({ entry });
    expect(afterReasoningDelta).not.toBe(initial);
    expect(afterReasoningDelta.liveActivity.reasoningSummary?.text).toBe(
      "Preparing the large patch",
    );
    expect(selectModel({ entry })).toBe(afterReasoningDelta);
    expect(projectionCount).toBe(2);

    patch.fileChange = {
      changes: buildCodexFileChangeMap([
        {
          type: "add",
          path: "src/fresh.ts",
          content: "fresh",
        },
      ]),
      label: "Created src/fresh.ts",
    };
    patch.updatedAt = 4;
    const afterPatchUpdate = selectModel({ entry });
    expect(findRenderedActivityEntry(afterPatchUpdate, patch.itemId)).toBe(patch);
    expect(findRenderedActivityEntry(afterPatchUpdate, patch.itemId)?.fileChange?.label).toBe(
      "Created src/fresh.ts",
    );
    expect(selectModel({ entry })).toBe(afterPatchUpdate);
    expect(projectionCount).toBe(3);

    command.aggregatedOutput = "streamed command output";
    command.updatedAt = 5;
    const afterCommandOutput = selectModel({ entry });
    expect(findRenderedActivityEntry(afterCommandOutput, command.itemId)).toBe(command);
    expect(findRenderedActivityEntry(afterCommandOutput, command.itemId)?.aggregatedOutput).toBe(
      "streamed command output",
    );
    expect(selectModel({ entry })).toBe(afterCommandOutput);
    expect(projectionCount).toBe(4);

    mcp.status = "completed";
    mcp.mcpToolCall = {
      ...mcp.mcpToolCall!,
      result: {
        type: "success",
        content: [{ type: "text", text: "Clicked the target" }],
        structuredContent: null,
        raw: {
          content: [{ type: "text", text: "Clicked the target" }],
          structuredContent: null,
          _meta: null,
        },
      },
      durationMs: 12,
      completed: true,
    };
    mcp.updatedAt = 6;
    const afterMcpCompletion = selectModel({ entry });
    const renderedMcp = findRenderedActivityEntry(afterMcpCompletion, mcp.itemId);
    expect(renderedMcp).toBe(mcp);
    expect(renderedMcp?.status).toBe("completed");
    expect(renderedMcp?.mcpToolCall?.completed).toBe(true);
    expect(renderedMcp?.mcpToolCall?.result?.type).toBe("success");
    expect(selectModel({ entry })).toBe(afterMcpCompletion);
    expect(projectionCount).toBe(5);
  });

  test("starts the preview surface after the turn intro", () => {
    const turn = buildTurn({
      status: "completed",
      itemIds: ["user_1", "assistant_1"],
      items: [buildUserItem(), buildAssistantItem()],
    });
    const entry = buildVisibleEntry(turn);
    const selectModel = createTurnRenderModelSelector();

    const main = selectModel({ entry });
    const preview = selectModel({ entry, surface: "preview" });

    expect(main.leadingBlocks.map((block) => block.type)).toEqual(["userMessage"]);
    expect(main.blocks.map((block) => block.type)).toEqual(["userMessage", "assistantMessage"]);
    expect(preview.leadingBlocks).toEqual([]);
    expect(preview.blocks.map((block) => block.type)).toEqual(["assistantMessage"]);
  });

  test("keeps a non-user item that precedes the user intro in the preview", () => {
    const turn = buildTurn({
      status: "completed",
      itemIds: ["model_changed_1", "user_1", "assistant_1"],
      items: [buildModelChangedItem(), buildUserItem(), buildAssistantItem()],
    });

    const preview = createTurnRenderModelSelector()({
      entry: buildVisibleEntry(turn),
      surface: "preview",
    });

    expect(preview.blocks.map((block) => block.type)).toEqual([
      "modelChanged",
      "userMessage",
      "assistantMessage",
    ]);
  });

  test("starts an active preview after its worked-for boundary", () => {
    const turn = buildTurn({
      itemIds: ["user_1", "exec_1"],
      items: [buildUserItem(), buildExecItem()],
      firstTurnWorkItemStartedAtMs: 1,
    });

    const preview = createTurnRenderModelSelector()({
      entry: buildVisibleEntry(turn),
      surface: "preview",
    });

    expect(preview.workedForItem?.type).toBe("workedFor");
    expect(preview.blocks.some((block) => block.type === "userMessage")).toBe(false);
    expect(preview.blocks.some((block) => block.type === "workedFor")).toBe(false);
    expect(preview.blocks.some((block) => block.type === "agentActivityGroup")).toBe(true);
  });

  test("reprojects when canonical entry identity or recency changes", () => {
    let projectionCount = 0;
    const selectModel = createTurnRenderModelSelector((input) => {
      projectionCount += 1;
      return buildTurnRenderModel(input);
    });
    const turn = buildTurn({ status: "completed" });
    const latestEntry = buildVisibleEntry(turn, true);
    const historicalEntry = buildVisibleEntry(turn, false);

    const latest = selectModel({ entry: latestEntry });
    const historical = selectModel({ entry: historicalEntry });

    expect(latest.isLatestTurn).toBe(true);
    expect(historical.isLatestTurn).toBe(false);
    expect(latest.isStreamingTurn).toBe(false);
    expect(projectionCount).toBe(2);
  });

  test("does not reuse a model after entry recency changes in place", () => {
    let projectionCount = 0;
    const selectModel = createTurnRenderModelSelector((input) => {
      projectionCount += 1;
      return buildTurnRenderModel(input);
    });
    const entry = buildVisibleEntry(buildTurn({ status: "completed" }), true);

    const latest = selectModel({ entry });
    entry.isMostRecentTurn = false;
    const historical = selectModel({ entry });

    expect(latest.isLatestTurn).toBe(true);
    expect(historical.isLatestTurn).toBe(false);
    expect(historical).not.toBe(latest);
    expect(projectionCount).toBe(2);
  });

  test("treats only unresolved permission requests as first-class turn blockers", () => {
    const unresolved = buildTurnRenderModel({
      turn: buildTurn(),
      requests: [buildPermissionRequest()],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    const completed = buildTurnRenderModel({
      turn: buildTurn(),
      requests: [buildPermissionRequest(true)],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(unresolved.buckets.permissionRequestItems.length).toBe(1);
    expect(unresolved.isBlocked).toBe(true);
    expect(unresolved.liveActivity.global.state.type).toBe("none");
    expect(completed.buckets.permissionRequestItems.length).toBe(0);
    expect(completed.isBlocked).toBe(false);
    expect(completed.liveActivity).toMatchObject({
      global: { state: { type: "thinking", isVisible: true } },
      fallback: { owner: "standalone" },
    });
  });

  test("blocks the active turn on private picker requests without rendering them inline", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn(),
      requests: [buildOptionPickerRequest()],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(model.buckets.interactiveRequestItem?.request.type).toBe("optionPicker");
    expect(model.isBlocked).toBe(true);
    expect(model.liveActivity.global.state.type).toBe("none");
  });

  test("derives live turn-diff from turn.diff before any fileChange item exists", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({ diff: LIVE_DIFF, itemIds: [], items: [] }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(model.aboveComposerBlocks?.map((block) => block.type).join(",") ?? "").toBe("turnDiff");
    expect(model.blocks).toEqual([]);
    expect(model.liveActivity).toMatchObject({
      global: { state: { type: "thinking", isVisible: true } },
      fallback: { owner: "standalone" },
    });
    expect(model.searchableText.includes("+next")).toBe(false);
    const rawItem =
      model.aboveComposerBlocks?.[0]?.type === "turnDiff"
        ? (model.aboveComposerBlocks[0].entry.rawItem as { unifiedDiff?: unknown } | undefined)
        : null;
    expect(String(rawItem?.unifiedDiff ?? "").includes("+next")).toBe(true);
  });

  test("filters projectless turn diffs before they reach transcript blocks", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({ diff: PROJECTLESS_MIXED_DIFF, itemIds: [], items: [] }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
      cwd: "/workspace",
      projectlessOutputDirectory: "/workspace/output",
    });

    const diffBlock = model.aboveComposerBlocks?.find((block) => block.type === "turnDiff");
    const rawItem =
      diffBlock?.type === "turnDiff"
        ? (diffBlock.entry.rawItem as { unifiedDiff?: unknown })
        : null;
    expect(String(rawItem?.unifiedDiff ?? "")).toContain("output/inside.ts");
    expect(String(rawItem?.unifiedDiff ?? "")).not.toContain("src/outside.ts");
  });

  test("hides a projectless turn diff when scope filtering removes every file", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({ diff: LIVE_DIFF, itemIds: [], items: [] }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
      cwd: "/workspace",
      projectlessOutputDirectory: "/workspace/output",
    });

    expect(model.aboveComposerBlocks ?? []).toHaveLength(0);
    expect(model.blocks.some((block) => block.type === "turnDiff")).toBe(false);
  });

  test("never lets a non-latest historical turn own fixed above-composer content", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({ diff: LIVE_DIFF, itemIds: [], items: [] }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: true,
    });

    expect(model.aboveComposerBlocks?.length ?? 0).toBe(0);
  });

  test("does not create a fixed or completed turn-diff surface without actual changes", () => {
    const headerOnlyDiff =
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts";
    const active = buildTurnRenderModel({
      turn: buildTurn({ diff: headerOnlyDiff, itemIds: [], items: [] }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    const completed = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        diff: headerOnlyDiff,
        itemIds: [],
        items: [],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
    });

    expect(active.aboveComposerBlocks?.length ?? 0).toBe(0);
    expect(active.blocks.some((block) => block.type === "turnDiff")).toBe(false);
    expect(completed.blocks.some((block) => block.type === "turnDiff")).toBe(false);
  });

  test("drops an explicit transcript turn-diff without actual changes", () => {
    const headerOnlyDiff =
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts";
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        itemIds: ["turn-diff:turn_1"],
        items: [
          buildTurnDiffItem({
            rawItem: {
              type: "turn-diff",
              unifiedDiff: headerOnlyDiff,
            },
          }),
        ],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
    });

    expect(model.blocks.some((block) => block.type === "turnDiff")).toBe(false);
  });

  test("keeps an addressable search unit for empty user messages", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        itemIds: ["user_empty", "assistant_1"],
        items: [
          buildUserItem({ markdownText: "", itemId: "user_empty", entryId: "user_empty" }),
          buildAssistantItem(),
        ],
      }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: false,
    });

    expect(
      model.searchUnits.map((unit) => `${unit.blockType}:${unit.key}:${unit.text}`).join(","),
    ).toBe("userMessage:turn_1:user:0:,assistantMessage:turn_1:assistant:Done");
    expect(
      model.searchUnits.filter((unit) => unit.text.toLowerCase().includes("missing")).length,
    ).toBe(0);
  });

  test("does not index tool-call body text in conversation search units", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        itemIds: ["user_1", "exec_1", "patch_live", "mcp_1", "dynamic_1", "assistant_1"],
        items: [
          buildUserItem({ markdownText: "Refactor the renderer" }),
          buildExecItem({
            status: "completed",
            command: "bun test",
            aggregatedOutput: "HIDDEN_EXEC_OUTPUT",
            markdownText: "HIDDEN_EXEC_MARKDOWN",
          }),
          buildFileChangeItem({
            status: "completed",
            fileChange: {
              changes: buildCodexFileChangeMap([
                {
                  type: "add",
                  path: "src/hidden-file.ts",
                  content: "HIDDEN_PATCH_BODY",
                },
              ]),
              label: "HIDDEN_PATCH_LABEL",
            },
          }),
          buildMcpToolItem({
            status: "completed",
            mcpToolCall: {
              callId: "mcp_1",
              functionName: "docs__search",
              pluginId: null,
              readOnlyHint: true,
              mcpAppResourceUri: undefined,
              source: null,
              invocation: {
                server: "docs",
                tool: "search",
                arguments: { query: "HIDDEN_MCP_QUERY" },
              },
              result: {
                type: "success",
                content: [{ type: "text", text: "HIDDEN_MCP_RESULT" }],
                structuredContent: null,
                raw: {
                  content: [{ type: "text", text: "HIDDEN_MCP_RESULT" }],
                  structuredContent: null,
                  _meta: null,
                },
              },
              durationMs: 100,
              completed: true,
            },
          }),
          buildDynamicToolItem({
            status: "completed",
            dynamicToolCall: {
              callId: "dynamic_1",
              namespace: "codex_app",
              tool: "read_thread",
              arguments: { threadId: "HIDDEN_DYNAMIC_THREAD" },
              status: "completed",
              contentItems: [{ type: "inputText", text: "HIDDEN_DYNAMIC_RESULT" }],
              success: true,
              durationMs: 100,
              completed: true,
            },
          }),
          buildAssistantItem({ markdownText: "Done" }),
        ],
      }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: false,
    });

    const indexedText = model.searchUnits.map((unit) => unit.text).join("\n");
    expect(model.searchUnits.map((unit) => `${unit.blockType}:${unit.key}`).join(",")).toBe(
      "userMessage:turn_1:user:0,assistantMessage:turn_1:assistant",
    );
    expect(indexedText.includes("Refactor the renderer")).toBe(true);
    expect(indexedText.includes("Done")).toBe(true);
    expect(indexedText.includes("HIDDEN_")).toBe(false);
  });

  test("does not duplicate a transcript turn-diff when turn.diff is also present", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        diff: LIVE_DIFF,
        itemIds: ["turn-diff:turn_1"],
        items: [buildTurnDiffItem()],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(model.aboveComposerBlocks?.map((block) => block.id).join(",") ?? "").toBe(
      "turn-diff:turn_1",
    );
  });

  test("keeps the live turn-diff banner when a live fileChange row represents the draft edit", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        diff: LIVE_DIFF,
        itemIds: ["patch_live"],
        items: [buildFileChangeItem()],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(model.aboveComposerBlocks?.map((block) => block.type).join(",") ?? "").toBe("turnDiff");
    expect(model.aboveComposerBlocks?.map((block) => block.id).join(",") ?? "").toBe(
      "turn-diff:turn_1",
    );
    expect(model.blocks.map((block) => block.type).join(",")).toBe("agentActivityGroup");
  });

  test("keeps the live turn-diff portal stable across fileChange streaming updates", () => {
    const beforeFileChange = buildTurnRenderModel({
      turn: buildTurn({ diff: LIVE_DIFF, itemIds: [], items: [] }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    const withFileChange = buildTurnRenderModel({
      turn: buildTurn({
        diff: LIVE_DIFF,
        itemIds: ["patch_live"],
        items: [buildFileChangeItem()],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    const withUpdatedFileChange = buildTurnRenderModel({
      turn: buildTurn({
        diff: LIVE_DIFF,
        itemIds: ["patch_live"],
        items: [
          buildFileChangeItem({
            fileChange: {
              changes: buildCodexFileChangeMap([
                {
                  type: "update",
                  path: "src/app.ts",
                  unifiedDiff: LIVE_DIFF,
                  movePath: null,
                },
              ]),
              label: "Edited src/app.ts",
            },
          }),
        ],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(beforeFileChange.aboveComposerBlocks?.map((block) => block.id).join(",") ?? "").toBe(
      "turn-diff:turn_1",
    );
    expect(withFileChange.aboveComposerBlocks?.map((block) => block.id).join(",") ?? "").toBe(
      "turn-diff:turn_1",
    );
    expect(
      withUpdatedFileChange.aboveComposerBlocks?.map((block) => block.id).join(",") ?? "",
    ).toBe("turn-diff:turn_1");
    expect(withFileChange.blocks.map((block) => block.type).join(",")).toBe("agentActivityGroup");
    expect(withUpdatedFileChange.blocks.map((block) => block.type).join(",")).toBe(
      "agentActivityGroup",
    );
  });

  test("keeps latest live single dynamic and MCP activity grouped until assistant content starts", () => {
    const liveDynamic = buildTurnRenderModel({
      turn: buildTurn({
        itemIds: ["dynamic_1"],
        items: [buildDynamicToolItem()],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    const liveMcp = buildTurnRenderModel({
      turn: buildTurn({
        itemIds: ["mcp_1"],
        items: [buildMcpToolItem()],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });
    const afterAssistantStarts = buildTurnRenderModel({
      turn: buildTurn({
        itemIds: ["dynamic_1", "assistant_1"],
        items: [
          buildDynamicToolItem(),
          buildAssistantItem({
            status: "inProgress",
            markdownText: "Working through the result",
          }),
        ],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(liveDynamic.agentBodyUnits.map((unit) => unit.block.type).join(",")).toBe(
      "agentActivityGroup",
    );
    expect(liveDynamic.blocks.map((block) => block.type).join(",")).toBe("agentActivityGroup");
    expect(liveMcp.agentBodyUnits.map((unit) => unit.block.type).join(",")).toBe(
      "agentActivityGroup",
    );
    expect(afterAssistantStarts.agentBodyUnits.map((unit) => unit.block.type).join(",")).toBe(
      "agentActivityGroup",
    );
    expect(afterAssistantStarts.blocks.map((block) => block.type).join(",")).toBe(
      "agentActivityGroup,assistantMessage",
    );
  });

  test("suppresses empty live fileChange activity and keeps Thinking fallback", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        diff: LIVE_DIFF,
        itemIds: ["patch_live"],
        items: [
          buildFileChangeItem({
            fileChange: {
              changes: buildCodexFileChangeMap([]),
            },
          }),
        ],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(model.aboveComposerBlocks?.map((block) => block.type).join(",") ?? "").toBe("turnDiff");
    expect(model.blocks).toEqual([]);
    expect(model.liveActivity).toMatchObject({
      global: { state: { type: "thinking", isVisible: true } },
      fallback: { owner: "standalone" },
    });
  });

  test("keeps completed derived turn-diff in the trailing body", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        diff: LIVE_DIFF,
        itemIds: [],
        items: [],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
    });

    expect(model.aboveComposerBlocks?.length ?? 0).toBe(0);
    expect(model.blocks.map((block) => block.type).join(",")).toBe("turnDiff");
  });

  test("does not duplicate a completed turn diff already represented by an end resource", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        diff: PROJECTLESS_MIXED_DIFF,
        items: [buildAssistantItem({ markdownText: "See [output](output/inside.ts)" })],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: false,
      cwd: "/workspace",
      projectlessOutputDirectory: "/workspace/output",
    });

    expect(model.blocks.some((block) => block.type === "turnDiff")).toBe(false);
  });

  test("inserts active working-for before the first non-user item without suppressing live activity", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        firstTurnWorkItemStartedAtMs: 1_000,
        itemIds: ["user_1", "exec_1"],
        items: [buildUserItem(), buildExecItem()],
      }),
      requests: [],
      isLatestTurn: true,
      isStreamingTurn: true,
    });

    expect(model.agentBodyUnits.map((unit) => unit.block.type).join(",")).toBe(
      "workedFor,agentActivityGroup",
    );
    expect(model.blocks.map((block) => block.type).join(",")).toBe(
      "userMessage,workedFor,agentActivityGroup",
    );
    expect(model.liveActivity).toMatchObject({
      global: { state: { type: "none" } },
      fallback: { owner: "none" },
    });
    const activityGroup = model.agentBodyUnits[1]?.block;
    expect(activityGroup?.type === "agentActivityGroup" ? activityGroup.header.kind : null).toBe(
      "active",
    );
    expect(model.searchableText.includes("Working")).toBe(false);
  });

  test("consumes completed worked-for rows into the collapsed label source", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        firstTurnWorkItemStartedAtMs: 1_000,
        finalAssistantStartedAtMs: 8_000,
        itemIds: ["user_1", "exec_1", "assistant_1"],
        items: [buildUserItem(), buildExecItem({ status: "completed" }), buildAssistantItem()],
      }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: false,
    });

    expect(model.workedForItem?.status ?? "").toBe("worked");
    expect(model.workedForItem?.startedAtMs ?? 0).toBe(1_000);
    expect(model.workedForItem?.completedAtMs ?? 0).toBe(8_000);
    expect(model.agentBodyUnits.some((unit) => unit.block.type === "workedFor")).toBe(false);
    expect(model.hasRenderableAgentBodyUnits).toBe(true);
  });

  test("falls back to completed duration when no explicit worked-for row exists", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        durationMs: 125_000,
        itemIds: ["user_1", "exec_1", "assistant_1"],
        items: [buildUserItem(), buildExecItem({ status: "completed" }), buildAssistantItem()],
      }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: false,
    });

    expect(model.workedForItem).toBe(null);
    expect(model.workedDurationMs).toBe(125_000);
    expect(model.hasRenderableAgentBodyUnits).toBe(true);
  });

  test("does not keep completed worked-for timing without a renderable final assistant boundary", () => {
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        firstTurnWorkItemStartedAtMs: 1_000,
        finalAssistantStartedAtMs: 8_000,
        itemIds: ["user_1", "exec_1"],
        items: [buildUserItem(), buildExecItem({ status: "completed" })],
      }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: false,
    });

    expect(model.workedForItem).toBe(null);
    expect(model.agentBodyUnits.some((unit) => unit.block.type === "workedFor")).toBe(false);
    expect(model.collapsedMessageCount).toBe(1);
  });

  test("routes the production turn through exact maximal v2 units and identity keys", () => {
    const handoff = buildDynamicToolItem({
      itemId: "handoff_1",
      entryId: "handoff_1",
      status: "completed",
      dynamicToolCall: {
        callId: "handoff_1",
        namespace: "codex_app",
        tool: "handoff_thread",
        arguments: { threadId: "thread_child" },
        status: "completed",
        contentItems: null,
        success: true,
        durationMs: 10,
        completed: true,
      },
    });
    const model = buildTurnRenderModel({
      turn: buildTurn({
        status: "completed",
        itemIds: ["exec_1", "handoff_1", "patch_live"],
        items: [
          buildExecItem({ status: "completed" }),
          handoff,
          buildFileChangeItem({ status: "completed" }),
        ],
      }),
      requests: [],
      isLatestTurn: false,
      isStreamingTurn: false,
    });

    expect(model.agentBodyUnits.map((unit) => unit.kind).join(",")).toBe("entry,entry,entry");
    expect(model.agentBodyUnits.map((unit) => unit.block.type).join(",")).toBe(
      "exec,dynamicToolCall,fileChange",
    );
    expect(model.agentBodyUnits.map((unit) => unit.block.renderKey).join(",")).toBe(
      "agent-activity-group:exec:0,agent-activity-standalone:handoff_1,agent-activity-group:patch_live",
    );
    expect(
      model.agentBodyUnits
        .map((unit) => unit.targetAttributes?.["data-local-conversation-item-target-ids"] ?? "none")
        .join(","),
    ).toBe("none,handoff_1,patch_live");
  });
});
