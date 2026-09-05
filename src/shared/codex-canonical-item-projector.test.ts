import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { parseCodexProtocolThreadItem } from "./codex-protocol-thread-item";
import { createCodexQueuedFollowUp } from "./codex-queued-follow-up-state";
import {
  agentActivityV2DynamicGenericActiveItem,
  agentActivityV2DynamicGenericFailedItem,
  agentActivityV2McpAppContextPrecedenceItem,
  agentActivityV2MultiActionCommandItem,
  agentActivityV2WebSearchItem,
} from "./codex-conversation-state/test-fixtures/agent-activity-v2-item-family-corpus";
import {
  isCodexCanonicalProtocolItem,
  materializeCodexCanonicalProtocolItem,
  type CodexCanonicalItem,
  type CodexCanonicalTurnParams,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state/codex-conversation-state";
import {
  projectCodexCanonicalTurnItemViews,
  projectCodexCanonicalTurnViews,
} from "./codex-canonical-item-projector";

const THREAD_ID = "thread-projector";
const TURN_ID = "turn-projector";

function project(
  items: readonly CodexCanonicalItem[],
  options: {
    turnStatus?: "inProgress" | "completed" | "interrupted" | "failed";
    lifecycleStatusByItemId?: Readonly<
      Record<string, "inProgress" | "completed" | "failed" | "declined" | "interrupted">
    >;
    isBackgroundSubagentsEnabled?: boolean;
  } = {},
) {
  return projectCodexCanonicalTurnItemViews({
    threadId: THREAD_ID,
    turnId: TURN_ID,
    items,
    observedAtMs: 1_000,
    turnStatus: options.turnStatus ?? "inProgress",
    lifecycleStatusByItemId: options.lifecycleStatusByItemId,
    isBackgroundSubagentsEnabled: options.isBackgroundSubagentsEnabled,
    commandExecutionStartedAtMsById: { "command-multi": 900 },
    interruptedCommandExecutionItemIds: [],
  });
}

function generatedItems(): readonly CodexCanonicalItem[] {
  const rawItems: ThreadItem[] = [
    {
      type: "userMessage",
      id: "user",
      clientId: null,
      content: [{ type: "text", text: "Hello", text_elements: [] }],
    },
    {
      type: "hookPrompt",
      id: "hook-prompt",
      fragments: [{ text: "Hook feedback", hookRunId: "hook-run" }],
    },
    {
      questions: null,
      type: "agentMessage",
      id: "assistant",
      text: "Answer",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    },
    {
      type: "functionCallOutput",
      id: "injected-tool-output",
      name: "external_lookup",
      namespace: null,
      output: "opaque model-context result",
    },
    { type: "plan", id: "plan", text: "- [x] still a proposed plan" },
    { type: "reasoning", id: "reasoning", summary: ["Summary"], content: [] },
    agentActivityV2MultiActionCommandItem,
    {
      type: "fileChange",
      id: "visualization-only",
      status: "completed",
      changes: [
        {
          path: ".codex/visualizations/2026/07/13/projector/chart.html",
          kind: { type: "add" },
          diff: "<html></html>",
        },
      ],
    },
    agentActivityV2McpAppContextPrecedenceItem,
    agentActivityV2DynamicGenericActiveItem,
    {
      type: "collabAgentToolCall",
      id: "collab",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: THREAD_ID,
      receiverThreadIds: [],
      prompt: "Inspect",
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    },
    {
      type: "subAgentActivity",
      id: "subagent",
      kind: "interacted",
      agentThreadId: "agent-thread",
      agentPath: "/root/code_review-agent",
    },
    agentActivityV2WebSearchItem,
    { type: "imageView", id: "image-view", path: "/tmp/one.png" },
    { type: "sleep", id: "sleep", durationMs: 10 },
    {
      type: "imageGeneration",
      id: "generated-image",
      status: "completed",
      revisedPrompt: null,
      result: "aW1hZ2U=",
      failure: null,
    },
    { type: "enteredReviewMode", id: "review-enter", review: "Review" },
    { type: "exitedReviewMode", id: "review-exit", review: "Review" },
    { type: "contextCompaction", id: "compaction" },
  ];

  return rawItems.map((item) => materializeCodexCanonicalProtocolItem(item));
}

function buildTurnParams(
  overrides: Partial<CodexCanonicalTurnParams> = {},
): CodexCanonicalTurnParams {
  return {
    threadId: THREAD_ID,
    clientUserMessageId: "client-prompt",
    input: [{ type: "text", text: "Prompt", text_elements: [] }],
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
    ...overrides,
  } as CodexCanonicalTurnParams;
}

function buildCanonicalTurn(
  input: {
    items?: readonly CodexCanonicalItem[];
    params?: CodexCanonicalTurnParams;
    blocked?: boolean;
  } = {},
): CodexCanonicalTurnState {
  return {
    protocol: {
      id: TURN_ID,
      itemsView: "full",
      status: "inProgress",
      error: null,
      durationMs: null,
    },
    items: input.items ?? [],
    sidecar: {
      params: input.params ?? buildTurnParams(),
      diff: null,
      turnStartedAtMs: 900,
      completedAtMs: null,
      finalAssistantStartedAtMs: null,
      ...(input.blocked
        ? {
            hookRuns: [
              {
                id: "blocked-hook",
                run: {
                  id: "blocked-hook",
                  eventName: "userPromptSubmit",
                  handlerType: "command",
                  executionMode: "sync",
                  scope: "turn",
                  sourcePath: "/workspace/project/.codex/hooks.json",
                  source: "project",
                  displayOrder: 0n,
                  status: "blocked",
                  statusMessage: "Prompt rejected",
                  startedAt: 1n,
                  completedAt: 2n,
                  durationMs: 1n,
                  entries: [],
                },
              },
            ],
          }
        : {}),
    },
  };
}

describe("projectCodexCanonicalTurnItemViews", () => {
  test("preserves structured async questions and renders their replyable message during a turn", () => {
    const message = {
      type: "agentMessage",
      id: "async-question",
      text: "Which scope?\n- Project\n- Library",
      phase: "final_answer",
      memoryCitation: null,
      delivery: "async",
      questions: [{ title: "Which scope?", options: ["Project", "Library"] }],
    } satisfies ThreadItem;
    const parsed = parseCodexProtocolThreadItem(message);
    expect(parsed).toEqual(message);
    if (!parsed) throw new Error("Async question must cross the protocol boundary");

    const views = project([materializeCodexCanonicalProtocolItem(parsed)], {
      turnStatus: "inProgress",
      lifecycleStatusByItemId: { "async-question": "completed" },
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      normalizedKind: "assistantMessage",
      markdownText: "Which scope?",
      assistantPhase: "commentary",
      asyncQuestion: { title: "Which scope?", options: ["Project", "Library"] },
      status: "completed",
    });
  });

  test("uses explicit lifecycle status for statusless items regardless of sibling order", () => {
    const assistant = materializeCodexCanonicalProtocolItem({
      questions: null,
      type: "agentMessage",
      id: "assistant-live",
      text: "partial",
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
    });
    const plan = materializeCodexCanonicalProtocolItem({
      type: "plan",
      id: "plan-completed",
      text: "- [x] done",
    });
    const reasoning = materializeCodexCanonicalProtocolItem({
      type: "reasoning",
      id: "reasoning-live",
      summary: ["Checking the patch stream."],
      content: [],
    });

    const views = project([assistant, plan, reasoning], {
      lifecycleStatusByItemId: {
        "assistant-live": "inProgress",
        "plan-completed": "completed",
        "reasoning-live": "inProgress",
      },
    });
    const byId = new Map(views.map((view) => [view.itemId, view]));

    expect(byId.get("assistant-live")?.status).toBe("inProgress");
    expect(byId.get("plan-completed")?.status).toBe("completed");
    expect(byId.get("reasoning-live")?.status).toBe("inProgress");
  });

  test("suppresses an empty in-progress fileChange semantic view", () => {
    const item = materializeCodexCanonicalProtocolItem({
      type: "fileChange",
      id: "empty-live-patch",
      status: "inProgress",
      changes: [],
    });

    expect(project([item])).toEqual([]);
  });

  test("exhaustively projects every generated discriminant with typed 0/1/N policy", () => {
    const items = generatedItems();
    const views = project(items);
    const viewCount = (id: string) =>
      views.filter((view) => {
        const rawItem = view.rawItem as { id?: string } | undefined;
        return rawItem?.id === id;
      }).length;

    expect(viewCount("user")).toBe(1);
    expect(viewCount("hook-prompt")).toBe(1);
    expect(viewCount("assistant")).toBe(1);
    expect(viewCount("injected-tool-output")).toBe(0);
    expect(viewCount("plan")).toBe(1);
    expect(viewCount("reasoning")).toBe(1);
    expect(viewCount("command-multi")).toBe(4);
    expect(viewCount("visualization-only")).toBe(1);
    expect(viewCount("mcp-app-context")).toBe(1);
    expect(viewCount("dynamic-generic-active")).toBe(1);
    expect(viewCount("collab")).toBe(1);
    expect(viewCount("subagent")).toBe(1);
    expect(viewCount("web-search-full")).toBe(1);
    expect(viewCount("image-view")).toBe(1);
    expect(viewCount("sleep")).toBe(0);
    expect(viewCount("generated-image")).toBe(1);
    expect(viewCount("review-enter")).toBe(0);
    expect(viewCount("review-exit")).toBe(0);
    expect(viewCount("compaction")).toBe(1);
  });

  test("retains injected function output in canonical state without creating transcript UI", () => {
    const item = materializeCodexCanonicalProtocolItem({
      type: "functionCallOutput",
      id: "injected-tool-output",
      name: "external_lookup",
      namespace: "tools",
      output: [{ type: "input_text", text: "opaque model-context result" }],
    });

    expect(item.type).toBe("functionCallOutput");
    expect(project([item])).toEqual([]);
  });

  test("uses exact hook, plan, visualization, generated-image, and subagent projections", () => {
    const views = project(generatedItems());
    const hook = views.find((view) => view.itemId === "hook-prompt");
    const plan = views.find((view) => view.itemId === "plan");
    const patch = views.find((view) => view.itemId === "visualization-only");
    const generatedImage = views.find((view) => view.itemId === "generated-image");
    const subagent = views.find((view) => view.itemId === "subagent");

    expect(hook?.hookFeedback).toBe(true);
    expect(hook?.semanticKind).toBe("userMessage");
    expect(plan?.semanticKind).toBe("proposedPlan");
    expect(patch?.fileChange?.visualizationActivities?.[0]?.kind).toBe("create");
    expect(generatedImage?.generatedImage?.src).toBe("data:image/png;base64,aW1hZ2U=");
    expect(subagent?.subagentActivity?.displayName).toBe("Code review agent");
    expect(subagent?.subagentActivity?.displayStatus).toBe("updated");
  });

  test("preserves ordinary dynamic-tool output, outcome, duration, and exact raw item", () => {
    const canonical = materializeCodexCanonicalProtocolItem(
      agentActivityV2DynamicGenericFailedItem,
    );
    const view = project([canonical])[0];

    expect(view?.dynamicToolCall?.contentItems).toEqual([
      {
        type: "inputText",
        text: "sanitized dynamic output",
      },
    ]);
    expect(view?.dynamicToolCall?.success).toBe(false);
    expect(view?.dynamicToolCall?.durationMs).toBe(12);
    expect(view?.rawItem).toBe(canonical);
  });

  test("folds only consecutive image views and resets across hidden raw items", () => {
    const first = { type: "imageView", id: "image-1", path: "/tmp/1.png" } satisfies ThreadItem;
    const second = { type: "imageView", id: "image-2", path: "/tmp/2.png" } satisfies ThreadItem;
    const sleep = { type: "sleep", id: "between", durationMs: 10 } satisfies ThreadItem;
    const third = { type: "imageView", id: "image-3", path: "/tmp/3.png" } satisfies ThreadItem;

    const views = project([first, second, sleep, third]);

    expect(views.length).toBe(2);
    expect(views[0]?.imageViewPaths?.join(",")).toBe("/tmp/1.png,/tmp/2.png");
    expect(views[1]?.imageViewPaths?.join(",")).toBe("/tmp/3.png");
  });

  test("applies background-agent and hidden-item policies before creating fallback views", () => {
    const items = generatedItems();
    const views = project(items, { isBackgroundSubagentsEnabled: false });

    expect(views.some((view) => view.itemId === "collab")).toBe(false);
    expect(views.some((view) => view.itemId === "subagent")).toBe(false);
    expect(views.some((view) => view.itemId === "sleep")).toBe(false);
    expect(views.some((view) => view.itemId === "review-enter")).toBe(false);
    expect(views.some((view) => view.itemId === "review-exit")).toBe(false);
  });

  test("projects app-local and request synthetic discriminants without generic fallback", () => {
    const items: readonly CodexCanonicalItem[] = [
      {
        type: "steeringUserMessage",
        id: "steering",
        targetTurnId: TURN_ID,
        targetTurnStartedAtMs: 900,
        status: "pending",
        clientUserMessageId: null,
        input: [{ type: "text", text: "Steer", text_elements: [] }],
        attachments: [],
        restoreMessage: {
          queueRow: createCodexQueuedFollowUp({
            followUpId: "follow-up-steering",
            clientUserMessageId: "client-steering",
            threadId: THREAD_ID,
            prompt: "Steer",
            createdAtMs: 900,
          }),
          context: { commentAttachments: [] },
        },
        compareKey: { rawText: "Steer", imageCount: 0 },
      },
      { type: "steered", id: "steered" },
      {
        type: "forkedFromConversation",
        id: "forked",
        sourceConversationId: "source-thread",
        sourceConversationTitle: null,
      },
      {
        type: "worktreeInit",
        id: "worktree",
        worktreeOutputText: "Ready",
        setup: null,
      },
      {
        type: "error",
        id: "error",
        message: "Failure",
        willRetry: false,
        errorInfo: null,
        additionalDetails: null,
      },
      { type: "todo-list", id: "todo", explanation: null, plan: [] },
      {
        type: "modelRerouted",
        id: "rerouted",
        fromModel: "a",
        toModel: "b",
        reason: "highRiskCyberActivity",
      },
      {
        type: "automaticApprovalReview",
        id: "review",
        targetItemId: null,
        action: { type: "applyPatch", cwd: "/tmp", files: [] },
        startedAtMs: 1,
        completedAtMs: null,
        event: null,
        status: "inProgress",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
      },
      { type: "autoReviewInterruptionWarning", id: "warning" },
      { type: "remoteTaskCreated", id: "remote", taskId: "task" },
      { type: "personalityChanged", id: "personality", personality: "friendly" },
      { type: "modelChanged", id: "model", fromModel: "a", toModel: "b" },
      {
        type: "planImplementation",
        id: "implementation",
        turnId: TURN_ID,
        planContent: "Implement",
        isCompleted: false,
      },
      {
        type: "userInputResponse",
        id: "user-input-response-1",
        requestId: 1,
        turnId: TURN_ID,
        questions: [{ id: "q", header: "Question", question: "Continue?", options: [] }],
        answers: { q: ["Yes"] },
        completed: true,
      },
      {
        type: "permissionRequest",
        id: "permission-request-1",
        requestId: 2,
        turnId: TURN_ID,
        reason: "Network",
        permissions: { network: { enabled: true }, fileSystem: null },
        completed: false,
        response: null,
      },
      {
        type: "mcpServerElicitation",
        id: "mcp-server-elicitation-3",
        requestId: 3,
        turnId: TURN_ID,
        elicitation: {
          kind: "urlAction",
          message: "Authorize",
          serverName: "server",
          url: "https://example.invalid",
        },
        completed: false,
        action: null,
      },
    ];

    const views = project(items, { turnStatus: "interrupted" });
    expect(views.length).toBe(items.length);
    expect(views.find((view) => view.itemId === "forked")?.semanticKind).toBe(
      "forkedFromConversation",
    );
    expect(views.find((view) => view.itemId === "remote")?.semanticKind).toBe("remoteTaskCreated");
    expect(views.find((view) => view.itemId === "personality")?.semanticKind).toBe(
      "personalityChanged",
    );
    expect(views.find((view) => view.itemId === "model")?.semanticKind).toBe("modelChanged");
    expect(views.find((view) => view.itemId === "review")?.status).toBe("completed");
  });

  test("protocol guard excludes every app-local discriminant", () => {
    const localItems: readonly CodexCanonicalItem[] = [
      { type: "todo-list", id: "todo", explanation: null, plan: [] },
      {
        type: "modelRerouted",
        id: "rerouted",
        fromModel: "a",
        toModel: "b",
        reason: "highRiskCyberActivity",
      },
      { type: "autoReviewInterruptionWarning", id: "warning" },
      { type: "remoteTaskCreated", id: "remote", taskId: "task" },
      { type: "personalityChanged", id: "personality", personality: "pragmatic" },
      { type: "modelChanged", id: "model", fromModel: "a", toModel: "b" },
      {
        type: "planImplementation",
        id: "implementation",
        turnId: TURN_ID,
        planContent: "Implement",
        isCompleted: false,
      },
    ];

    expect(localItems.some(isCodexCanonicalProtocolItem)).toBe(false);
    expect(isCodexCanonicalProtocolItem(generatedItems()[0]!)).toBe(true);
  });

  test("protocol guard fails closed before malformed lifecycle items reach typed projection", () => {
    expect(
      isCodexCanonicalProtocolItem({
        type: "userMessage",
        id: "missing-required-content",
      }),
    ).toBe(false);
    expect(
      isCodexCanonicalProtocolItem({
        type: "agentMessage",
        id: "missing-required-text",
      }),
    ).toBe(false);
    expect(
      isCodexCanonicalProtocolItem({
        type: "commandExecution",
        id: "missing-command-actions",
        command: "pwd",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }),
    ).toBe(false);
    expect(
      isCodexCanonicalProtocolItem({
        type: "fileChange",
        id: "invalid-file-change",
        status: "completed",
        changes: [{ path: "src/app.ts", kind: { type: "rename" }, diff: "" }],
      }),
    ).toBe(false);
    expect(
      isCodexCanonicalProtocolItem({
        type: "mcpToolCall",
        id: "incomplete-mcp",
        server: "docs",
        tool: "search",
        status: "completed",
        result: null,
        error: null,
        durationMs: null,
      }),
    ).toBe(false);
    expect(
      isCodexCanonicalProtocolItem({
        type: "futureItem",
        id: "unknown-discriminant",
      }),
    ).toBe(false);
  });
});

describe("projectCodexCanonicalTurnViews", () => {
  test("projects params input first with sidecar attachments, comments, and blocked delivery", () => {
    const commentAttachments = [
      {
        id: "comment-1",
        type: "comment" as const,
        content: [{ content_type: "text" as const, text: "Review this line" }],
        position: { side: "right" as const, path: "src/index.ts", line: 1 },
        createdAt: 900,
      },
    ];
    const params = buildTurnParams({
      input: [
        { type: "text", text: "Prompt", text_elements: [] },
        { type: "mention", name: "src", path: "/workspace/project/src" },
        { type: "localImage", path: "/workspace/project/screenshot.png" },
      ],
      attachments: [
        {
          label: "requirements.md",
          path: "/workspace/project/requirements.md",
          fsPath: "/workspace/project/requirements.md",
        },
        {
          label: "screenshot.png",
          path: "screenshot.png",
          fsPath: "/workspace/project/screenshot.png",
        },
      ],
      commentAttachments,
    });

    const views = projectCodexCanonicalTurnViews({
      threadId: THREAD_ID,
      turn: buildCanonicalTurn({ params, blocked: true }),
      observedAtMs: 1_000,
    });

    expect(views.length).toBe(1);
    expect(views[0]).toMatchObject({
      itemId: `${TURN_ID}:input`,
      normalizedKind: "userMessage",
      semanticKind: "userMessage",
      markdownText: "Prompt",
      deliveryStatus: "not-sent",
      commentAttachments,
    });
    expect(views[0]?.userAttachments).toEqual([
      {
        type: "file",
        id: `${TURN_ID}:input:attachment:file:0`,
        label: "requirements.md",
        path: "/workspace/project/requirements.md",
        sourceKind: "mention",
      },
      {
        type: "file",
        id: `${TURN_ID}:input:attachment:mention:1`,
        label: "src",
        path: "/workspace/project/src",
        sourceKind: "mention",
      },
      {
        type: "image",
        id: `${TURN_ID}:input:attachment:local-image:2`,
        source: "/workspace/project/screenshot.png",
        sourceKind: "local-image",
      },
    ]);
  });

  test("suppresses the matching server user message only across allowed metadata", () => {
    const promptInput = [{ type: "text" as const, text: "Prompt", text_elements: [] }];
    const allowedMetadata: readonly CodexCanonicalItem[] = [
      {
        type: "automaticApprovalReview",
        id: "review",
        targetItemId: null,
        action: { type: "applyPatch", cwd: "/workspace/project", files: [] },
        startedAtMs: 1,
        completedAtMs: 2,
        event: null,
        status: "approved",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
      },
      {
        type: "forkedFromConversation",
        id: "forked",
        sourceConversationId: "source",
        sourceConversationTitle: null,
      },
      { type: "modelChanged", id: "model", fromModel: "a", toModel: "b" },
      {
        type: "modelRerouted",
        id: "rerouted",
        fromModel: "a",
        toModel: "b",
        reason: "highRiskCyberActivity",
      },
      { type: "personalityChanged", id: "personality", personality: "friendly" },
      { type: "remoteTaskCreated", id: "remote", taskId: "task" },
      { type: "worktreeInit", id: "worktree", worktreeOutputText: "Ready", setup: null },
    ];
    const duplicate = materializeCodexCanonicalProtocolItem({
      type: "userMessage",
      id: "server-user",
      clientId: "client-prompt",
      content: [{ type: "text", text: "Server-normalized prompt", text_elements: [] }],
    });
    const assistant = materializeCodexCanonicalProtocolItem({
      questions: null,
      type: "agentMessage",
      id: "assistant",
      text: "Answer",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    });

    const views = projectCodexCanonicalTurnViews({
      threadId: THREAD_ID,
      turn: buildCanonicalTurn({
        params: buildTurnParams({ input: [...promptInput] }),
        items: [...allowedMetadata, duplicate, assistant],
      }),
      observedAtMs: 1_000,
    });

    expect(views[0]?.itemId).toBe(`${TURN_ID}:input`);
    expect(views.some((view) => view.itemId === "server-user")).toBe(false);
    expect(views.at(-1)?.itemId).toBe("assistant");
  });

  test("requires the duplicate prelude for client and structural user-message matches", () => {
    const structurallyEqual = materializeCodexCanonicalProtocolItem({
      type: "userMessage",
      id: "equal-user",
      clientId: null,
      content: [{ text_elements: [], text: "Prompt", type: "text" }],
    });
    const hook = materializeCodexCanonicalProtocolItem({
      type: "hookPrompt",
      id: "hook",
      fragments: [{ text: "Feedback", hookRunId: "hook-run" }],
    });
    const laterMatch = materializeCodexCanonicalProtocolItem({
      type: "userMessage",
      id: "later-user",
      clientId: "client-prompt",
      content: [{ type: "text", text: "Prompt", text_elements: [] }],
    });
    const laterStructuralMatch = materializeCodexCanonicalProtocolItem({
      type: "userMessage",
      id: "later-structural-user",
      clientId: null,
      content: [{ type: "text", text: "Prompt", text_elements: [] }],
    });

    const equalViews = projectCodexCanonicalTurnViews({
      threadId: THREAD_ID,
      turn: buildCanonicalTurn({
        params: buildTurnParams({ clientUserMessageId: null }),
        items: [structurallyEqual],
      }),
      observedAtMs: 1_000,
    });
    const activityViews = projectCodexCanonicalTurnViews({
      threadId: THREAD_ID,
      turn: buildCanonicalTurn({ items: [hook, laterMatch] }),
      observedAtMs: 1_000,
    });
    const structuralActivityViews = projectCodexCanonicalTurnViews({
      threadId: THREAD_ID,
      turn: buildCanonicalTurn({ items: [hook, laterStructuralMatch] }),
      observedAtMs: 1_000,
    });

    expect(equalViews.map((view) => view.itemId)).toEqual([`${TURN_ID}:input`]);
    expect(activityViews.map((view) => view.itemId)).toEqual([
      `${TURN_ID}:input`,
      "hook",
      "later-user",
    ]);
    expect(activityViews.map((view) => view.semanticKind)).toEqual([
      "userMessage",
      "userMessage",
      "steered",
    ]);
    expect(structuralActivityViews.map((view) => view.itemId)).toEqual([
      `${TURN_ID}:input`,
      "hook",
      "later-structural-user",
    ]);
    expect(structuralActivityViews.map((view) => view.semanticKind)).toEqual([
      "userMessage",
      "userMessage",
      "steered",
    ]);
  });

  test("keeps the server user message when no params-owned user row is visible", () => {
    const serverMessage = materializeCodexCanonicalProtocolItem({
      type: "userMessage",
      id: "server-only-user",
      clientId: "client-prompt",
      content: [{ type: "text", text: "Server-owned prompt", text_elements: [] }],
    });
    const views = projectCodexCanonicalTurnViews({
      threadId: THREAD_ID,
      turn: buildCanonicalTurn({
        params: buildTurnParams({ input: [] }),
        items: [serverMessage],
      }),
      observedAtMs: 1_000,
    });

    expect(views.map((view) => view.itemId)).toEqual(["server-only-user"]);
    expect(views[0]?.semanticKind).toBe("userMessage");
  });
});
