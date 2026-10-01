import { expect, it } from "vite-plus/test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  beginAgentConversationTurn,
  diffAgentConversationSnapshots,
  emptyAgentConversationSnapshot,
  completeAgentConversationTurn,
  applyAgentHistoryFacts,
  agentHistoryFactFromTurn,
  updateAgentSessionMetadata,
} from "../AgentConversationProjection";
import {
  createClaudeMessageProjection,
  beginClaudeAcceptedInputTurn,
  projectClaudeAcceptedInput,
  prependAgentHistory,
  projectClaudeHistory,
} from "./ClaudeConversationProjection";
import { deriveClaudeTurnOutcome } from "./ClaudeEventHelpers";
import type { AgentConversationSnapshot } from "../../../shared/agent-conversation";
import { applyAgentConversationDelta } from "../../../shared/agent-conversation";

const initial = () =>
  beginAgentConversationTurn(
    emptyAgentConversationSnapshot({ backend: "claude", threadId: "thread", sessionId: "session" }),
    1,
    "Inspect",
    "user-1",
  );
const event = (value: unknown) => value as SDKMessage;
const assistant = (uuid: string, content: unknown[], parent: string | null = null, id = "api-1") =>
  event({
    type: "assistant",
    uuid,
    parent_tool_use_id: parent,
    message: { id, model: "claude-sonnet", content, usage: { input_tokens: 10, output_tokens: 5 } },
  });
const stream = (value: unknown, parent: string | null = null) =>
  event({ type: "stream_event", parent_tool_use_id: parent, event: value });
const toolResult = (id: string, content: unknown, output?: unknown) =>
  event({
    type: "user",
    uuid: `result-${id}`,
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    tool_use_result: output,
  });

it("moves each queued steering record into its consumed Turn without merging or duplicating inputs", () => {
  const inputs = [
    { messageId: "steer-a", text: "First steering" },
    {
      messageId: "steer-b",
      text: "Second steering",
      images: [{ nativeMessageId: "steer-b", index: 0, mediaType: "image/png" }],
    },
  ];
  const accepted = inputs.reduce(
    (snapshot, input) => projectClaudeAcceptedInput(snapshot, 1, input),
    initial(),
  );
  const continued = beginClaudeAcceptedInputTurn(accepted, 2, inputs);
  expect(continued.turns[0]?.updates).toEqual([]);
  expect(continued.turns[1]).toMatchObject({
    clientUserMessageId: "steer-a",
    promptText: "First steering",
    updates: [
      {
        role: "user",
        messageId: "steer-b",
        text: "Second steering",
      },
    ],
  });
});

it("retains an already acknowledged steering image when its queued input becomes a Turn", () => {
  const input = {
    messageId: "image-steer",
    text: "",
    images: [{ nativeMessageId: "image-steer", index: 0, mediaType: "image/png" }],
  };
  const accepted = projectClaudeAcceptedInput(initial(), 1, input);
  const echoed = createClaudeMessageProjection()(
    accepted,
    event({
      type: "user",
      uuid: input.messageId,
      isReplay: true,
      parent_tool_use_id: null,
      message: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }],
      },
    }),
    1,
  );
  const continued = beginClaudeAcceptedInputTurn(echoed, 2, [input]);
  expect(continued.turns[0]?.updates).toEqual([]);
  expect(continued.turns[1]).toMatchObject({
    clientUserMessageId: input.messageId,
    nativeUserMessageId: input.messageId,
    promptImages: input.images,
  });
});

it("reconciles a later replay echo in its steering record's owning Turn", () => {
  const accepted = projectClaudeAcceptedInput(initial(), 1, {
    messageId: "steer",
    text: "Follow up",
    images: [{ nativeMessageId: "steer", index: 0, mediaType: "image/png" }],
  });
  const later = beginAgentConversationTurn(accepted, 2, "Later prompt", "later");
  const project = createClaudeMessageProjection();
  const echoed = project(
    later,
    event({
      type: "user",
      uuid: "steer",
      isReplay: true,
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png" } },
          { type: "text", text: "Follow up" },
        ],
      },
    }),
    2,
  );
  expect(echoed.turns[0]?.updates).toEqual([
    expect.objectContaining({
      key: "input:steer",
      role: "user",
      text: "Follow up",
      recordIds: ["steer"],
      promptImages: [{ nativeMessageId: "steer", index: 0, mediaType: "image/png" }],
    }),
  ]);
  expect(echoed.turns[1]).toEqual(later.turns[1]);
});

it("joins per-block final records to their stream indexes without overwriting thinking or duplicating text", () => {
  const project = createClaudeMessageProjection();
  let snapshot = initial();
  for (const message of [
    stream({ type: "message_start", message: { id: "api-1", model: "claude-sonnet", usage: {} } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Think" },
    }),
    assistant("thinking-record", [{ type: "thinking", thinking: "Think" }]),
    stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Answer" },
    }),
    assistant("answer-record", [{ type: "text", text: "Answer" }]),
  ])
    snapshot = project(snapshot, message, 1);
  expect(snapshot.turns[0]?.updates.filter((value) => value.kind === "message")).toEqual([
    expect.objectContaining({
      key: "message:api-1:0",
      role: "thought",
      text: "Think",
      recordIds: ["thinking-record"],
    }),
    expect.objectContaining({
      key: "message:api-1:1",
      role: "agent",
      text: "Answer",
      recordIds: ["answer-record"],
    }),
  ]);
  expect(project(snapshot, assistant("answer-record", [{ type: "text", text: "Answer" }]), 1)).toBe(
    snapshot,
  );
});

it("keeps no-stream block snapshots distinct and scopes simultaneous child tool indexes by parent", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("think", [{ type: "thinking", thinking: "Think" }]),
    1,
  );
  snapshot = project(snapshot, assistant("answer", [{ type: "text", text: "Answer" }]), 1);
  for (const parent of ["parent-a", "parent-b"]) {
    snapshot = project(
      snapshot,
      stream({ type: "message_start", message: { id: "shared-api", usage: {} } }, parent),
      1,
    );
    snapshot = project(
      snapshot,
      stream(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `tool-${parent}`, name: "Bash", input: {} },
        },
        parent,
      ),
      1,
    );
    snapshot = project(
      snapshot,
      stream(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: parent }) },
        },
        parent,
      ),
      1,
    );
  }
  expect(
    snapshot.turns[0]?.updates
      .filter((value) => value.kind === "message")
      .map((value) => value.text),
  ).toEqual(["Think", "Answer"]);
  expect(snapshot.toolCalls).toEqual(
    expect.arrayContaining(
      ["parent-a", "parent-b"].map((parent) =>
        expect.objectContaining({
          update: expect.objectContaining({
            toolCallId: `tool-${parent}`,
            input: JSON.stringify({ command: parent }),
            actor: { parentToolUseId: parent },
          }),
        }),
      ),
    ),
  );
});

it("updates one session task and its originating tool across turns, preserving paused/cancelled and ambient semantics", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("spawn", [
      { type: "tool_use", id: "spawn-1", name: "Agent", input: { model: "haiku", effort: "low" } },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_started",
      uuid: "start",
      task_id: "task-1",
      tool_use_id: "spawn-1",
      description: "Inspect",
      task_type: "local_agent",
      subagent_type: "code-reviewer",
      spawn_depth: 2,
      is_backgrounded: true,
      ambient: true,
      skip_transcript: true,
    }),
    1,
  );
  snapshot = beginAgentConversationTurn(snapshot, 2, "Next");
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_updated",
      uuid: "pause",
      task_id: "task-1",
      patch: { status: "paused" },
    }),
    2,
  );
  expect(snapshot.tasks?.[0]).toMatchObject({
    bornTurnSequence: 1,
    status: "paused",
    ambient: true,
    hidden: true,
    model: "haiku",
    effort: "low",
    taskType: "local_agent",
    role: "code-reviewer",
    spawnDepth: 2,
  });
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_updated",
      uuid: "resume",
      task_id: "task-1",
      patch: { status: "running" },
    }),
    2,
  );
  expect(snapshot.tasks?.[0]).toMatchObject({ bornTurnSequence: 1, status: "running" });
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_notification",
      uuid: "done",
      task_id: "task-1",
      tool_use_id: "spawn-1",
      status: "stopped",
      summary: "Stopped",
      output_file: "/tmp/task",
      resource_links: [{ uri: "file:///tmp/result", name: "result" }],
    }),
    2,
  );
  expect(snapshot.tasks).toHaveLength(1);
  expect(snapshot.tasks?.[0]).toMatchObject({
    status: "cancelled",
    summary: "Stopped",
    outputFile: "/tmp/task",
  });
  expect(snapshot.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ toolCallId: "spawn-1", status: "cancelled" }),
    ]),
  );
  expect(snapshot.turns[1]?.updates).toEqual([]);
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_progress",
      uuid: "late",
      task_id: "task-1",
      description: "Late",
      usage: {},
    }),
    2,
  );
  expect(snapshot.tasks?.[0]?.status).toBe("cancelled");
  expect(snapshot.tasks?.[0]).toMatchObject({
    taskType: "local_agent",
    role: "code-reviewer",
    spawnDepth: 2,
  });
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_started",
      uuid: "workflow-start",
      task_id: "workflow",
      task_type: "local_workflow",
      description: "Specification",
      workflow_name: "w".repeat(1024),
      spawn_depth: Infinity,
    }),
    2,
  );
  const workflow = snapshot.tasks?.find((task) => task.id === "workflow");
  expect(workflow?.taskType).toBe("local_workflow");
  expect(workflow?.workflowName).toHaveLength(256);
  expect(workflow?.spawnDepth).toBeUndefined();
});

it("keeps Query-owned background workers after a conversation reset without attaching their terminal update to a new turn", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    event({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "roster",
      tasks: [{ task_id: "watch", description: "Watch", ambient: true, skip_transcript: true }],
    }),
    1,
  );
  snapshot = project(
    snapshot,
    event({ type: "conversation_reset", new_conversation_id: "reset" }),
    1,
  );
  expect(snapshot).toMatchObject({
    sessionId: "reset",
    turns: [],
    toolCalls: [],
    requests: [],
    liveBackgroundTaskIds: ["watch"],
  });
  expect(snapshot.tasks).toEqual([
    expect.objectContaining({
      id: "watch",
      bornTurnSequence: null,
      status: "running",
      ambient: true,
    }),
  ]);
  snapshot = beginAgentConversationTurn(snapshot, 2, "New conversation");
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_notification",
      uuid: "watch-done",
      task_id: "watch",
      status: "completed",
      summary: "Done",
    }),
    2,
  );
  expect(snapshot.tasks?.[0]?.status).toBe("completed");
  expect(snapshot.turns[0]?.updates).toEqual([]);
  snapshot = project(
    snapshot,
    event({ type: "system", subtype: "background_tasks_changed", uuid: "empty-roster", tasks: [] }),
    2,
  );
  expect(snapshot.liveBackgroundTaskIds).toEqual([]);
});

it("settles foreground tools at a terminal outcome and keeps the failed turn immutable under background updates", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("tools", [{ type: "tool_use", id: "read", name: "Read", input: {} }]),
    1,
  );
  snapshot = completeAgentConversationTurn(snapshot, 1, {
    status: "failed",
    stopReason: "error",
    error: "API unavailable",
  });
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "task_progress",
      uuid: "progress",
      task_id: "task",
      description: "Work",
      usage: {},
    }),
    1,
  );
  expect(snapshot.error).toBe("API unavailable");
  expect(snapshot.turns[0]).toMatchObject({
    status: "failed",
    error: "API unavailable",
    stopReason: "error",
    updates: [expect.objectContaining({ status: "failed" })],
  });
  const cancelled = completeAgentConversationTurn(initial(), 1, {
    status: "cancelled",
    stopReason: "cancelled",
    error: null,
  });
  expect(cancelled.turns[0]?.status).toBe("cancelled");
});

it("retains typed tool output and only publishes successful plan mutations", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("todo", [
      {
        type: "tool_use",
        id: "todos",
        name: "TodoWrite",
        input: { todos: [{ content: "Inspect", status: "in_progress" }] },
      },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    toolResult("todos", [{ type: "text", text: "Updated" }], { success: true }),
    1,
  );
  snapshot = project(
    snapshot,
    assistant(
      "bash",
      [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "pwd" } }],
      null,
      "api-2",
    ),
    1,
  );
  snapshot = project(
    snapshot,
    toolResult("bash", [{ type: "text", text: "/workspace" }], {
      stdout: "/workspace",
      stderr: "",
      exitCode: 0,
    }),
    1,
  );
  expect(snapshot.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "plan",
        entries: [{ content: "Inspect", status: "in_progress", priority: "medium" }],
      }),
      expect.objectContaining({
        toolCallId: "bash",
        detail: "/workspace",
        output: { stdout: "/workspace", stderr: "", exitCode: 0 },
        presentation: "command",
      }),
    ]),
  );
  snapshot = project(
    snapshot,
    assistant("task-get", [
      { type: "tool_use", id: "task-get", name: "TaskGet", input: { taskId: "1" } },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    toolResult("task-get", "Loaded", {
      task: { id: "1", subject: "Inspect task", status: "completed" },
    }),
    1,
  );
  expect(
    snapshot.turns[0]?.updates.find(
      (update) => update.kind === "plan" && update.planId === "tasks",
    ),
  ).toMatchObject({
    entries: [{ content: "[1] Inspect task", priority: "medium", status: "completed" }],
  });
});

it("uses the main model context window, keeps token accounting separate, and applies compaction post-token measurements", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(initial(), assistant("root", [{ type: "text", text: "Root" }]), 1);
  snapshot = project(
    snapshot,
    event({
      type: "result",
      uuid: "outcome",
      subtype: "success",
      result: "Root",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      modelUsage: {
        "claude-sonnet": {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 400,
          contextWindow: 200000,
        },
        "claude-opus": { inputTokens: 500, outputTokens: 50, contextWindow: 1000000 },
      },
      total_cost_usd: 2,
    }),
    1,
  );
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "compact_boundary",
      uuid: "compact",
      compact_metadata: { trigger: "manual", pre_tokens: 10, post_tokens: 3, duration_ms: 20 },
    }),
    1,
  );
  expect(snapshot.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "usage",
        used: 3,
        size: 200000,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40 },
        cumulativeTokens: { input: 1500, output: 250, cacheRead: 300, cacheWrite: 400 },
      }),
      expect.objectContaining({
        kind: "compaction",
        trigger: "manual",
        preTokens: 10,
        postTokens: 3,
        durationMs: 20,
      }),
    ]),
  );
});

it("replaces rate-limit state on recovery and retracts records idempotently on fallback", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("refused-record", [{ type: "text", text: "Refused" }]),
    1,
  );
  for (const status of ["rejected", "allowed"])
    snapshot = project(
      snapshot,
      event({
        type: "rate_limit_event",
        uuid: status,
        rate_limit_info: {
          status,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          isUsingOverage: false,
        },
      }),
      1,
    );
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "model_refusal_fallback",
      uuid: "fallback",
      retracted_message_uuids: ["refused-record"],
      scope: "local",
      original_model: "sonnet",
      fallback_model: "opus",
      content: "Retrying",
    }),
    1,
  );
  expect(snapshot.turns[0]?.updates.some((value) => value.kind === "message")).toBe(false);
  expect(snapshot.turns[0]?.updates.filter((value) => value.kind === "rate-limit")).toEqual([
    expect.objectContaining({ status: "allowed", usingOverage: false }),
  ]);
});

it("rejoins outcome facts and prepends history by UUID without changing existing turn IDs", () => {
  const history = (id: string, prompt: string) =>
    projectClaudeHistory(
      emptyAgentConversationSnapshot({
        backend: "claude",
        threadId: "thread",
        sessionId: "session",
      }),
      [
        { type: "user", uuid: id, parent_tool_use_id: null, message: { content: prompt } },
        {
          type: "assistant",
          uuid: `answer-${id}`,
          parent_tool_use_id: null,
          message: { id: `api-${id}`, content: [{ type: "text", text: "Answer" }] },
        },
      ] as unknown as Parameters<typeof projectClaudeHistory>[1],
    );
  const unknown = history("unknown", "Imported");
  expect(unknown.turns[0]).toMatchObject({ stopReason: null, status: undefined });
  expect(unknown.turns[0]?.completedAt).toBeUndefined();
  const latest = applyAgentHistoryFacts(history("latest", "Latest"), [
    {
      clientUserMessageId: "client-latest",
      nativeUserMessageId: "latest",
      stopReason: "error",
      error: "Failed",
      completedAt: "2026-09-30T00:00:00Z",
      usage: {
        used: 100,
        size: 200000,
        cost: { amount: 0.125, currency: "USD" },
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
      compactions: [
        {
          compactionId: "compacted",
          status: "failed",
          summary: "Summary retained",
          error: "Interrupted",
          trigger: "auto",
          preTokens: 90,
          postTokens: 10,
        },
      ],
      artifacts: [
        { filename: "report.txt", fileId: "file-1" },
        { filename: "failed.txt", error: "No space" },
      ],
    },
  ]);
  expect(latest.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "usage",
        cost: { amount: 0.125, currency: "USD" },
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      }),
      expect.objectContaining({
        kind: "compaction",
        summary: "Summary retained",
        error: "Interrupted",
        trigger: "auto",
      }),
      expect.objectContaining({
        kind: "diagnostic",
        severity: "error",
        details: {
          artifacts: [
            { filename: "report.txt", fileId: "file-1" },
            { filename: "failed.txt", error: "No space" },
          ],
        },
      }),
    ]),
  );
  const restoredFact = agentHistoryFactFromTurn(latest.turns[0]!);
  expect(restoredFact).toMatchObject({
    nativeUserMessageId: "latest",
    usage: { used: 100 },
    compactions: [{ compactionId: "compacted", summary: "Summary retained" }],
    artifacts: [
      { filename: "report.txt", fileId: "file-1" },
      { filename: "failed.txt", error: "No space" },
    ],
  });
  expect(applyAgentHistoryFacts(latest, [restoredFact!])).toEqual(latest);
  expect(agentHistoryFactFromTurn(unknown.turns[0]!)).toMatchObject({
    stopReason: null,
    completedAt: undefined,
  });
  expect(agentHistoryFactFromTurn({ ...unknown.turns[0]!, clientUserMessageId: null })).toBeNull();
  const merged = prependAgentHistory(latest, history("older", "Older"), {
    hasOlder: false,
    cursor: "older",
  });
  expect(merged.turns.map((turn) => turn.nativeUserMessageId)).toEqual(["older", "latest"]);
  expect(merged.turns.at(-1)).toMatchObject({
    sequence: latest.turns[0]?.sequence,
    clientUserMessageId: "client-latest",
    status: "failed",
    error: "Failed",
  });
  expect(
    prependAgentHistory(merged, history("older", "Older"), { hasOlder: false }).turns,
  ).toHaveLength(2);
});

it("classifies native success-shaped failures and preserves explicit cancellation and auth hints", () => {
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: null,
    result: "Overloaded",
    terminal_reason: "api_error",
  } as Parameters<typeof deriveClaudeTurnOutcome>[0];
  expect(deriveClaudeTurnOutcome(result)).toMatchObject({
    status: "failed",
    stopReason: "error",
    error: "Overloaded",
  });
  expect(deriveClaudeTurnOutcome(result, { cancelled: true })).toMatchObject({
    status: "cancelled",
    error: null,
  });
  expect(deriveClaudeTurnOutcome(result, { authenticationFailure: "Sign in" })).toMatchObject({
    authenticationRequired: true,
    error: "Sign in",
  });
});

it("publishes effective metadata and outcome fields in the exact snapshot delta", () => {
  const before = initial();
  const after = updateAgentSessionMetadata(before, {
    configOptions: [],
    modes: null,
    capabilities: {
      prompt: { text: true, resourceLink: true, image: true, audio: false, embeddedContext: false },
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
      controls: { compact: true },
    },
    effectiveSelection: { model: "sonnet", effort: "high" },
  });
  expect(
    applyAgentConversationDelta(before, diffAgentConversationSnapshots(before, after)!),
  ).toEqual(after);
  const { revision: _revision, ...metadata } = after.metadata!;
  expect(updateAgentSessionMetadata(after, metadata)).toBe(after);
  const completed: AgentConversationSnapshot = completeAgentConversationTurn(after, 1, {
    status: "failed",
    stopReason: "error",
    error: "Failure",
  });
  expect(
    applyAgentConversationDelta(after, diffAgentConversationSnapshots(after, completed)!),
  ).toEqual(completed);
});

it("keeps tool identity and reports current context independently of cumulative usage", () => {
  const project = createClaudeMessageProjection();
  let snapshot = beginAgentConversationTurn(
    emptyAgentConversationSnapshot({ backend: "claude", threadId: "thread", sessionId: "session" }),
    1,
    "Inspect",
  );
  const events = [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "root",
        usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: "child",
      message: { id: "child", usage: { input_tokens: 500 }, content: [] },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "read-1", content: "File contents", is_error: false },
        ],
      },
    },
    {
      type: "result",
      modelUsage: {
        sonnet: {
          inputTokens: 1000,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 2000,
          contextWindow: 200000,
        },
      },
      total_cost_usd: 0.25,
    },
  ];
  for (const event of events) snapshot = project(snapshot, event as unknown as SDKMessage, 1);
  expect(snapshot.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "tool-call",
        title: "Read",
        toolCallId: "read-1",
        status: "completed",
        detail: "File contents",
        input: JSON.stringify({ file_path: "README.md" }),
      }),
      expect.objectContaining({
        kind: "usage",
        used: 95,
        size: 200000,
        cost: { amount: 0.25, currency: "USD" },
      }),
    ]),
  );
});

it("emits one consecutive revision for a multi-block SDK record", () => {
  const before = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "thread",
    sessionId: "session",
  });
  const after = createClaudeMessageProjection()(
    before,
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "message",
        content: [
          { type: "text", text: "Inspecting" },
          { type: "tool_use", id: "tool", name: "Read", input: {} },
        ],
      },
    } as unknown as SDKMessage,
    1,
  );
  expect(after.revision).toBe(before.revision + 1);
  expect(diffAgentConversationSnapshots(before, after)?.turns[0]?.updates).toHaveLength(2);
});

it("acknowledges root image-only prompts by native UUID without duplicating them as assistant text", () => {
  const project = createClaudeMessageProjection();
  const message = event({
    type: "user",
    uuid: "native-image-user",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "large-image-data" },
        },
      ],
    },
  });
  const projected = project(initial(), message, 1);
  expect(projected.turns[0]?.nativeUserMessageId).toBe("native-image-user");
  expect(projected.turns[0]?.promptImages).toEqual([
    { nativeMessageId: "native-image-user", index: 0, mediaType: "image/png" },
  ]);
  expect(
    applyAgentConversationDelta(initial(), diffAgentConversationSnapshots(initial(), projected)!),
  ).toEqual(projected);
  expect(projected.turns[0]?.updates.filter((update) => update.kind === "message")).toEqual([]);
  const history = projectClaudeHistory(
    emptyAgentConversationSnapshot({ backend: "claude", threadId: "thread", sessionId: "session" }),
    [
      message,
      {
        type: "user",
        uuid: "child-user",
        parent_tool_use_id: null,
        parent_agent_id: "child-agent",
        message: { content: "Child instruction" },
      },
      {
        type: "assistant",
        uuid: "answer",
        parent_tool_use_id: null,
        message: { id: "answer-api", content: [{ type: "text", text: "Image description" }] },
      },
    ] as unknown as Parameters<typeof projectClaudeHistory>[1],
  );
  expect(history.turns).toHaveLength(1);
  expect(history.turns[0]?.promptImages).toEqual([
    { nativeMessageId: "native-image-user", index: 0, mediaType: "image/png" },
  ]);
  expect(history.turns[0]).toMatchObject({
    nativeUserMessageId: "native-image-user",
    promptText: "[Image]",
  });
  expect(JSON.stringify(history)).not.toContain("large-image-data");
  expect(
    history.turns[0]?.updates.find(
      (update) => update.kind === "message" && update.text === "Child instruction",
    ),
  ).toMatchObject({ actor: { agentId: "child-agent" }, role: "user" });
});

it("retracts a tool result back to its surviving origin without deleting its call identity", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("tool-origin", [
      { type: "tool_use", id: "tool", name: "Read", input: { file_path: "file.txt" } },
    ]),
    1,
  );
  snapshot = project(snapshot, toolResult("tool", "Contents"), 1);
  expect(snapshot.toolCalls?.[0]?.update.status).toBe("completed");
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "model_refusal_fallback",
      uuid: "fallback-tool",
      scope: "local",
      retracted_message_uuids: ["result-tool"],
      original_model: "sonnet",
      fallback_model: "opus",
      content: "Retry",
    }),
    1,
  );
  expect(snapshot.toolCalls?.[0]?.update).toMatchObject({
    toolCallId: "tool",
    status: "in_progress",
    recordIds: ["tool-origin"],
  });
  expect(snapshot.turns[0]?.updates.find((update) => update.kind === "tool-call")).toMatchObject({
    toolCallId: "tool",
    status: "in_progress",
  });
});

it("renders Write updates from native structured patches rather than treating complete contents as a diff", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("write-origin", [
      {
        type: "tool_use",
        id: "write",
        name: "Write",
        input: { file_path: "file.txt", content: "new" },
      },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    toolResult("write", "Updated", {
      type: "update",
      filePath: "file.txt",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
      ],
    }),
    1,
  );
  expect(snapshot.toolCalls?.[0]?.update.changes).toEqual([
    { path: "file.txt", kind: "update", diff: "@@ -1,1 +1,1 @@\n-old\n+new" },
  ]);
  snapshot = project(
    snapshot,
    assistant("create-origin", [
      {
        type: "tool_use",
        id: "create",
        name: "Write",
        input: { file_path: "new.txt", content: "new\nline" },
      },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    toolResult("create", "Created", { type: "create", filePath: "new.txt" }),
    1,
  );
  expect(
    snapshot.toolCalls?.find(({ update }) => update.toolCallId === "create")?.update.changes,
  ).toEqual([{ path: "new.txt", kind: "add", diff: "new\nline" }]);
});

it("keeps image tool metadata while excluding native base64 from the canonical transcript", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("read-image", [
      { type: "tool_use", id: "image", name: "Read", input: { file_path: "diagram.png" } },
    ]),
    1,
  );
  const imageData = "sensitive-image-bytes".repeat(40_000);
  snapshot = project(
    snapshot,
    toolResult("image", "Image", {
      type: "image",
      file: { base64: imageData, type: "image/png", originalSize: 1024 },
    }),
    1,
  );
  expect(snapshot.toolCalls?.[0]?.update.output).toEqual({
    type: "image",
    file: { type: "image/png", originalSize: 1024, base64: undefined },
  });
  expect(JSON.stringify(snapshot)).not.toContain("sensitive-image-bytes");
  snapshot = project(
    snapshot,
    assistant("mcp-image", [
      { type: "mcp_tool_use", id: "mcp", name: "show", server_name: "media", input: {} },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    toolResult("mcp", [
      { type: "image", data: imageData, mimeType: "image/png" },
      { type: "resource_link", uri: "https://example.test/report", name: "Report" },
    ]),
    1,
  );
  const mcp = snapshot.toolCalls?.find(({ update }) => update.toolCallId === "mcp")?.update;
  expect(mcp).toMatchObject({
    name: "mcp__media__show",
    output: [
      { type: "text", text: "[Image · image/png]" },
      { type: "resource_link", uri: "https://example.test/report", name: "Report" },
    ],
    resources: [{ uri: "https://example.test/report", name: "Report" }],
  });
  expect(JSON.stringify(snapshot)).not.toContain("sensitive-image-bytes");
});

it("expands the history window beyond the live 64-turn limit while keeping existing sequence identities", () => {
  const initialSnapshot = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "thread",
    sessionId: "session",
  });
  const turns = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      sequence: index + 1,
      clientUserMessageId: `${prefix}-${index}`,
      nativeUserMessageId: `${prefix}-${index}`,
      promptText: "Prompt",
      updates: [],
      stopReason: "end_turn",
    }));
  const current = { ...initialSnapshot, turns: turns("new", 64) };
  const older = { ...initialSnapshot, turns: turns("old", 64) };
  const merged = prependAgentHistory(current, older, { hasOlder: false, cursor: "old-0" });
  expect(merged.turns).toHaveLength(128);
  expect(merged.turns.slice(-64).map((turn) => turn.sequence)).toEqual(
    current.turns.map((turn) => turn.sequence),
  );
  expect(merged.history).toMatchObject({ windowSize: 128, cursor: "old-0" });
});

it("admits large older pages without skipping hidden history or evicting current turns when the window fills", () => {
  const base = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "thread",
    sessionId: "session",
  });
  const turns = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      sequence: index + 1,
      clientUserMessageId: `${prefix}-${index}`,
      nativeUserMessageId: `${prefix}-${index}`,
      promptText: "Prompt",
      stopReason: null,
      updates: [
        {
          kind: "message" as const,
          key: `${prefix}-${index}`,
          messageId: `${prefix}-${index}`,
          role: "agent" as const,
          text: "x".repeat(60000),
        },
      ],
    }));
  const older = {
    ...base,
    turns: turns("old", 20),
    history: { hasOlder: true, oldestSequence: 1, cursor: "old-0" },
  };
  const admitted = prependAgentHistory(base, older, {
    hasOlder: false,
    cursor: "native-page-before",
  });
  expect(admitted.turns.length).toBeGreaterThan(0);
  expect(admitted.turns.length).toBeLessThan(20);
  expect(admitted.history).toMatchObject({
    hasOlder: true,
    cursor: admitted.turns[0]?.nativeUserMessageId,
    windowFull: false,
  });
  expect(diffAgentConversationSnapshots(base, admitted)?.resync).toBeUndefined();
  const projectionClipped = prependAgentHistory(
    base,
    { ...older, turns: older.turns.slice(-1) },
    { hasOlder: false, cursor: "hidden-native-boundary" },
  );
  expect(projectionClipped.history).toMatchObject({ hasOlder: true, cursor: "old-19" });
  const current = {
    ...base,
    turns: turns("current", 34),
    tasks: [
      {
        id: "live",
        bornTurnSequence: 1,
        description: "Watch",
        backgrounded: true,
        status: "running" as const,
      },
    ],
    liveBackgroundTaskIds: ["live"],
  };
  const full = prependAgentHistory(
    current,
    { ...base, turns: older.turns.slice(-1) },
    { hasOlder: true, cursor: "old-19" },
  );
  expect(full.turns).toEqual(current.turns);
  expect(full.history).toMatchObject({ windowFull: true, cursor: "current-0" });
  expect(full.tasks).toEqual(current.tasks);
  expect(full.liveBackgroundTaskIds).toEqual(["live"]);
});

it("retains server tools, document fallbacks and mixed generated-file outcomes without inventing edits", () => {
  const project = createClaudeMessageProjection();
  let snapshot = project(
    initial(),
    assistant("server", [
      { type: "server_tool_use", id: "search", name: "web_search", input: { query: "workspace" } },
      {
        type: "document",
        title: "Report",
        source: { type: "base64", data: "private-document-bytes", media_type: "application/pdf" },
      },
    ]),
    1,
  );
  snapshot = project(
    snapshot,
    event({
      type: "system",
      subtype: "files_persisted",
      uuid: "files",
      session_id: "session",
      files: [{ filename: "report.pdf", file_id: "file-1" }],
      failed: [{ filename: "chart.png", error: "Access denied" }],
      processed_at: "2026-09-30T00:00:00Z",
    }),
    1,
  );
  expect(snapshot.toolCalls?.[0]?.update).toMatchObject({
    toolCallId: "search",
    name: "web_search",
    presentation: "web-search",
  });
  expect(snapshot.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "message", text: "[Document · Report]" }),
      expect.objectContaining({
        kind: "diagnostic",
        message: "Saved report.pdf\nchart.png: Access denied",
        severity: "error",
        details: {
          files: [{ filename: "report.pdf", file_id: "file-1" }],
          failed: [{ filename: "chart.png", error: "Access denied" }],
        },
      }),
    ]),
  );
  expect(snapshot.toolCalls?.some(({ update }) => update.presentation === "file-change")).toBe(
    false,
  );
  expect(JSON.stringify(snapshot)).not.toContain("private-document-bytes");
});
