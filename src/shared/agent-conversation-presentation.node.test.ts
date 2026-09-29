import { bucketizeTurnItems } from "../renderer/features/local-conversation/projection/bucketize-turn-items";
import {
  classifyThreadAgentActivityItem,
  isThreadClassifiableActivityItem,
} from "../renderer/features/local-conversation/projection/agent-activity-v2";
import { describe, expect, test } from "vite-plus/test";
import type { AgentBackendSessionPresentation } from "./agent-conversation";
import type { CodexThreadSummary } from "./types";
import {
  agentInteractionResponseFromAnswers,
  filterAgentConversationForTask,
  projectAgentConversation,
} from "./agent-conversation-presentation";
import { buildRendererItemStream } from "../renderer/features/local-conversation/projection/build-renderer-item-stream";
import { hasDurableCanonicalFirstSubmission } from "../renderer/features/conversation-launch/session-first-submission-owner";

const summary: CodexThreadSummary = {
  threadId: "thread",
  projectId: "project",
  source: null,
  threadName: "Task",
  threadPreview: "Hello",
  cwd: "/workspace",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-09-29T00:00:00Z",
};
const presentation = (backend: "claude" | "acp"): AgentBackendSessionPresentation => ({
  snapshot: {
    backend,
    threadId: "thread",
    sessionId: "native-session",
    status: "running",
    error: null,
    revision: 1,
    turns: [
      {
        sequence: 1,
        clientUserMessageId: "client-message",
        promptText: "Hello",
        stopReason: null,
        updates: [
          {
            kind: "message",
            key: "message-1",
            role: "agent",
            messageId: "message-1",
            text: "**Working**",
          },
          {
            kind: "tool-call",
            key: "tool-1",
            toolCallId: "tool-1",
            title: "Inspect workspace",
            name: "Task",
            toolKind: "other",
            status: "in_progress",
            detail: "Read the files",
            locations: [],
          },
        ],
      },
    ],
    requests: [
      {
        id: "question",
        toolName: "AskUserQuestion",
        title: "Target",
        detail: "",
        questions: [
          {
            id: "Which target?",
            question: "Which target?",
            multiSelect: true,
            options: [
              { label: "Desktop", description: "Application" },
              { label: "CLI", description: "Terminal" },
            ],
          },
        ],
      },
    ],
  },
  configOptions: [
    {
      id: "model",
      category: "model",
      name: "Model",
      description: null,
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet", description: null }],
    },
  ],
  modes: {
    currentModeId: "plan",
    availableModes: [{ id: "plan", name: "Plan", description: null }],
  },
  capabilities: {
    prompt: { text: true, resourceLink: true, image: false, audio: false, embeddedContext: false },
    session: {
      load: true,
      list: false,
      delete: false,
      resume: true,
      unstableFork: false,
      close: true,
      additionalDirectories: false,
    },
    authMethods: [],
  },
});

test("keeps native child content out of the parent while exposing the same shared details projection", () => {
  const source = presentation("claude");
  const snapshot = {
    ...source.snapshot,
    tasks: [
      {
        id: "child",
        bornTurnSequence: 1,
        toolUseId: "spawn",
        description: "Inspect",
        status: "completed" as const,
      },
    ],
    turns: source.snapshot.turns.map((turn) => ({
      ...turn,
      updates: [
        ...turn.updates,
        {
          kind: "message" as const,
          key: "child-message",
          messageId: "child-message",
          role: "agent" as const,
          text: "Child answer",
          actor: { parentToolUseId: "spawn" },
        },
      ],
    })),
  };
  expect(
    projectAgentConversation({ ...source, snapshot }, summary).turns[0]?.items.some(
      (item) => item.markdownText === "Child answer",
    ),
  ).toBe(false);
  const child = projectAgentConversation(
    { ...source, snapshot: filterAgentConversationForTask(snapshot, "child") },
    summary,
  );
  expect(child.turns.flatMap((turn) => turn.items).map((item) => item.markdownText)).toEqual([
    "Child answer",
  ]);
  expect(snapshot.turns[0]?.updates.at(-1)?.actor).toEqual({ parentToolUseId: "spawn" });
});

test("maps structured native tools into existing command, patch, search and MCP presentations", () => {
  const source = presentation("claude");
  const common = {
    kind: "tool-call" as const,
    title: "Tool",
    toolKind: "other" as const,
    status: "completed" as const,
    detail: "Done",
    locations: [],
  };
  const snapshot = {
    ...source.snapshot,
    turns: [
      {
        sequence: 1,
        clientUserMessageId: "user",
        promptText: null,
        stopReason: "end_turn",
        updates: [
          {
            ...common,
            key: "bash",
            toolCallId: "bash",
            name: "Bash",
            presentation: "command" as const,
            input: JSON.stringify({ command: "pwd" }),
            output: { stdout: "/workspace", stderr: "", exitCode: 0 },
          },
          {
            ...common,
            key: "edit",
            toolCallId: "edit",
            name: "Edit",
            presentation: "file-change" as const,
            changes: [
              { path: "file.ts", kind: "update" as const, diff: "@@ -1 +1 @@\n-old\n+new" },
            ],
          },
          {
            ...common,
            key: "search",
            toolCallId: "search",
            name: "WebSearch",
            presentation: "web-search" as const,
            input: JSON.stringify({ query: "SDK" }),
          },
          {
            ...common,
            key: "mcp",
            toolCallId: "mcp",
            name: "mcp__files__read",
            presentation: "mcp" as const,
            input: JSON.stringify({ path: "file" }),
            output: {
              content: [
                { type: "text", text: "Read" },
                { type: "resource_link", uri: "file:///tmp/result", name: "Result" },
              ],
              structuredContent: { success: true },
            },
          },
        ],
      },
    ],
  };
  const items = projectAgentConversation({ ...source, snapshot }, summary).turns[0]!.items;
  expect(items.map((item) => item.semanticKind)).toEqual([
    "exec",
    "patch",
    "webSearch",
    "mcpToolCall",
  ]);
  expect(items[0]).toMatchObject({ command: "pwd", aggregatedOutput: "/workspace", exitCode: 0 });
  expect(items[1]?.fileChange?.changes["file.ts"]).toMatchObject({
    type: "update",
    unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
  });
  expect(items[3]?.mcpToolCall).toMatchObject({
    invocation: { server: "files", tool: "read", arguments: { path: "file" } },
    result: {
      type: "success",
      structuredContent: { success: true },
      content: [
        { type: "text", text: "Read" },
        { type: "resource_link", uri: "file:///tmp/result", name: "Result" },
      ],
    },
  });
});

test("keeps unknown historical outcomes neutral and expands only a native tool result record", () => {
  const source = presentation("claude");
  const base = source.snapshot.turns[0]!;
  const call = base.updates.find((update) => update.kind === "tool-call")!;
  const projected = projectAgentConversation(
    {
      ...source,
      snapshot: {
        ...source.snapshot,
        status: "idle",
        requests: [],
        turns: [
          {
            ...base,
            stopReason: null,
            status: undefined,
            updates: [
              {
                ...call,
                status: "completed",
                truncated: true,
                outputRecordId: "native-result",
                recordIds: ["native-result"],
              },
            ],
          },
        ],
      },
    },
    summary,
  );
  expect(projected.turns[0]).toMatchObject({ outcomeUnknown: true });
  expect(projected.turns[0]?.completedAt).toBeNull();
  expect(projected.turns[0]?.items.at(-1)).toMatchObject({
    toolOutputReference: {
      sessionId: "native-session",
      nativeMessageId: "native-result",
      toolUseId: "tool-1",
    },
  });
  const withoutResult = projectAgentConversation(
    {
      ...source,
      snapshot: {
        ...source.snapshot,
        turns: [
          {
            ...base,
            updates: [
              { ...call, truncated: true, recordIds: ["tool-use-record", "assistant-record"] },
            ],
          },
        ],
      },
    },
    summary,
  );
  expect(withoutResult.turns[0]?.items.at(-1)?.toolOutputReference).toBeUndefined();
});

test("preserves failure, compaction source and independent token accounting", () => {
  const source = presentation("claude");
  const snapshot = {
    ...source.snapshot,
    status: "idle" as const,
    error: "Failed",
    turns: [
      {
        sequence: 1,
        clientUserMessageId: "user",
        promptText: "Prompt",
        stopReason: "error",
        status: "failed" as const,
        error: "Failed",
        updates: [
          {
            kind: "compaction" as const,
            key: "compact",
            compactionId: "compact",
            status: "completed",
            summary: "Context compacted",
            error: null,
            trigger: "manual" as const,
          },
          {
            kind: "usage" as const,
            key: "usage" as const,
            used: 3,
            size: 200000,
            cost: { amount: 1, currency: "USD" },
            tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
            cumulativeTokens: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
          },
        ],
      },
    ],
  };
  const projected = projectAgentConversation({ ...source, snapshot }, summary);
  expect(projected.turns[0]).toMatchObject({ status: "failed", errorMessage: "Failed" });
  expect(projected.turns[0]?.items[1]?.contextCompaction).toEqual({
    completed: true,
    source: "manual",
  });
  expect(projected.latestTokenUsageInfo).toMatchObject({
    last: { totalTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 40, outputTokens: 20 },
    total: { totalTokens: 1000 },
    modelContextWindow: 200000,
  });
});

test("carries native question headers and approval constraints through the shared request plane", () => {
  const source = presentation("claude");
  const questions = source.snapshot.requests![0]!;
  const snapshot = {
    ...source.snapshot,
    requests: [
      {
        ...questions,
        questions: questions.questions.map((question) => ({ ...question, header: "Targets" })),
      },
      {
        id: "approval",
        title: "Bash",
        toolName: "Bash",
        toolUseId: "tool-1",
        detail: "pwd",
        questions: [],
        constraints: { defaultToNo: true, allowForSession: true, suppressAlwaysAllowRule: true },
      },
    ],
  };
  expect(projectAgentConversation({ ...source, snapshot }, summary).requests).toEqual([
    expect.objectContaining({
      type: "userInput",
      questions: [expect.objectContaining({ header: "Targets" })],
    }),
    expect.objectContaining({
      type: "approval",
      itemId: "tool:tool-1",
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
      availableDecisions: ["accept", "decline"],
    }),
  ]);
});

test("uses native effective metadata and maps resume dialog answers to the exact SDK action", () => {
  const source = presentation("claude");
  const request = {
    id: "resume",
    title: "Resume conversation",
    toolName: "Claude",
    detail: "",
    questions: [],
    kind: "dialog" as const,
    dialog: { kind: "resume_return", payload: {} },
  };
  const snapshot = {
    ...source.snapshot,
    requests: [request],
    metadata: {
      revision: 1,
      configOptions: [],
      modes: source.modes,
      capabilities: { ...source.capabilities, controls: { rollback: true, fork: true } },
      effectiveSelection: { model: "claude-opus", effort: "xhigh" },
    },
  };
  const projected = projectAgentConversation({ ...source, snapshot }, summary);
  expect(projected.latestThreadSettings).toMatchObject({
    model: "claude-opus",
    reasoningEffort: "xhigh",
  });
  expect(projected.requests[0]).toMatchObject({
    type: "userInput",
    questions: [{ id: "resume-action", isOther: false }],
  });
  expect(
    agentInteractionResponseFromAnswers(request, { "resume-action": ["Never ask again"] }),
  ).toEqual({ decision: "dialog", result: "never" });
  expect(agentInteractionResponseFromAnswers(request, {})).toEqual({ decision: "deny" });
  expect(projected.capabilityFlags).toMatchObject({
    canEditLastUserTurn: true,
    canForkFromTurn: true,
  });
});

describe.each(["claude", "acp"] as const)("%s shared conversation presentation", (backend) => {
  test("uses the normal timeline and acknowledges the accepted first message without raw Codex records", () => {
    const conversation = projectAgentConversation(presentation(backend), summary);
    expect(hasDurableCanonicalFirstSubmission(conversation.turns, "client-message")).toBe(true);
    expect(conversation.turns[0]?.items.every((item) => item.rawItem === undefined)).toBe(true);
    const items = buildRendererItemStream({
      entries: conversation.turns[0]!.items,
      requests: [],
      turnStatus: "inProgress",
    });
    expect(items.map((item) => item.type)).toEqual(["userMessage", "assistantMessage", "toolCall"]);
    const tools = bucketizeTurnItems({ items }).agentItems.filter(
      (item) => item.type === "toolCall",
    );
    expect(tools).toHaveLength(1);
    expect(
      tools
        .filter(isThreadClassifiableActivityItem)
        .map((item) => classifyThreadAgentActivityItem(item)?.grouping),
    ).toEqual(["standalone"]);
    expect(conversation.requests[0]).toMatchObject({
      type: "userInput",
      questions: [{ id: "Which target?", multiSelect: true }],
    });
    expect(conversation.latestThreadSettings).toMatchObject({
      model: "sonnet",
      collaborationMode: { mode: "plan" },
    });
  });

  test("keeps item identity through completion and exposes only supported history actions", () => {
    const before = presentation(backend);
    const after: AgentBackendSessionPresentation = {
      ...before,
      snapshot: {
        ...before.snapshot,
        status: "idle",
        requests: [],
        revision: 2,
        turns: before.snapshot.turns.map((turn) => ({
          ...turn,
          stopReason: "end_turn",
          updates: turn.updates.map((update) =>
            update.kind === "tool-call"
              ? { ...update, status: "completed", detail: "Done" }
              : update,
          ),
        })),
      },
    };
    const live = projectAgentConversation(before, summary);
    const completed = projectAgentConversation(after, summary);
    expect(completed.turns[0]?.itemIds).toEqual(live.turns[0]?.itemIds);
    expect(completed.turns[0]?.status).toBe("completed");
    expect(completed.requests).toEqual([]);
    expect(completed.capabilityFlags).toEqual({
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    });
  });
});

test("uses authoritative background roster liveness and supplies details for tasks without child text", () => {
  const source = presentation("claude");
  const task = {
    id: "watch",
    description: "Watch",
    bornTurnSequence: 1,
    backgrounded: true,
    status: "running" as const,
    summary: "Watching builds",
  };
  const snapshot = { ...source.snapshot, tasks: [task], liveBackgroundTaskIds: [] };
  const filtered = filterAgentConversationForTask(snapshot, "watch");
  expect(filtered.status).toBe("idle");
  expect(filtered.turns[0]?.updates).toEqual([
    {
      kind: "message",
      key: "task-summary:watch",
      messageId: "watch",
      role: "agent",
      text: "Watching builds",
    },
  ]);
  expect(snapshot.tasks[0]?.status).toBe("running");
  expect(
    filterAgentConversationForTask({ ...snapshot, liveBackgroundTaskIds: ["watch"] }, "watch")
      .status,
  ).toBe("running");
});

test("plan approval displays actual plan markdown from the tool payload", () => {
  const source = presentation("claude");
  const conversation = projectAgentConversation(
    {
      ...source,
      snapshot: {
        ...source.snapshot,
        requests: [
          {
            id: "plan",
            toolName: "ExitPlanMode",
            title: "Implement plan",
            detail: JSON.stringify({ plan: "## Plan\nImplement the feature" }),
            questions: [],
          },
        ],
      },
    },
    summary,
  );
  expect(conversation.requests[0]).toMatchObject({
    type: "implementPlan",
    planContent: "## Plan\nImplement the feature",
  });
});

test("projects native image descriptors into opaque shared attachments while retaining editable prompt text", () => {
  const source = presentation("claude");
  const snapshot = {
    ...source.snapshot,
    turns: source.snapshot.turns.map((turn) => ({
      ...turn,
      promptImages: [{ nativeMessageId: "native-image", index: 1, mediaType: "image/png" }],
    })),
  };
  const user = projectAgentConversation({ ...source, snapshot }, summary).turns[0]?.items[0];
  expect(user?.markdownText).toBe("Hello");
  expect(user?.userAttachments).toEqual([
    {
      type: "image",
      id: "native-session:client-message:image:1",
      source: "nodex-native-image:native-session/native-image/1",
      sourceKind: "remote-pointer",
      caption: "image/png",
    },
  ]);
});

test("keeps rendered turn identity stable when the native user UUID arrives", () => {
  const source = presentation("claude");
  const before = projectAgentConversation(source, summary);
  const acknowledged = {
    ...source,
    snapshot: {
      ...source.snapshot,
      turns: source.snapshot.turns.map((turn) => ({
        ...turn,
        nativeUserMessageId: "native-user-uuid",
      })),
    },
  };
  const after = projectAgentConversation(acknowledged, summary);
  expect(after.turns[0]?.turnId).toBe(before.turns[0]?.turnId);
  expect(after.turns[0]?.items[0]?.itemId).toBe(before.turns[0]?.items[0]?.itemId);
});
