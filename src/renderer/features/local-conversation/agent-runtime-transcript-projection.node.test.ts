import { describe, expect, test } from "vite-plus/test";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import {
  isAgentRuntimeItemHidden,
  parseAgentRuntimeToolName,
  projectAgentRuntimeHookRun,
  projectAgentRuntimeItem,
} from "./agent-runtime-transcript-projection";

const at = "2026-10-15T00:00:00.000Z";
const base = {
  id: "item",
  threadId: "parent",
  runId: "parent-run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as AgentTurnItem["status"],
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
};
const tool = (
  toolName: string,
  status: AgentTurnItem["status"] = "completed",
): Extract<AgentTurnItem, { type: "dynamic_tool" }> => ({
  ...base,
  status,
  type: "dynamic_tool",
  toolName,
  input: { query: "plan" },
  output: "done",
});
const task = (
  status: AgentTurnItem["status"],
  overrides: Partial<Extract<AgentTurnItem, { type: "subagent" }>> = {},
): Extract<AgentTurnItem, { type: "subagent" }> => ({
  ...base,
  status,
  type: "subagent",
  subagentId: "task",
  origin: "app_owned",
  driver: "claudeAgent",
  providerInstanceId: "claude",
  childThreadId: "child",
  prompt: "Review the auth module\nand report findings",
  result: null,
  ...overrides,
});
const message = (
  overrides: Partial<Extract<AgentTurnItem, { type: "user_message" }>>,
): Extract<AgentTurnItem, { type: "user_message" }> => ({
  ...base,
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  messageId: "message",
  inputIntent: "turn_start",
  text: "Hello",
  attachments: [],
  ...overrides,
});

describe("Runtime application tool presentation", () => {
  test("every provider spelling of the application server resolves to nodex_app", () => {
    expect(parseAgentRuntimeToolName("mcp__nodex_app__search")).toEqual({
      namespace: "nodex_app",
      tool: "search",
    });
    expect(parseAgentRuntimeToolName("nodex_app.create_session")).toEqual({
      namespace: "nodex_app",
      tool: "create_session",
    });
    expect(parseAgentRuntimeToolName("nodex-app.fetch")).toMatchObject({ namespace: "nodex_app" });
    expect(parseAgentRuntimeToolName("github.create_issue")).toEqual({
      namespace: "github",
      tool: "create_issue",
    });
    expect(parseAgentRuntimeToolName("WebFetch")).toEqual({ namespace: null, tool: "WebFetch" });
    expect(parseAgentRuntimeToolName(null)).toEqual({ namespace: null, tool: "Tool" });
  });

  test("application calls keep their namespace for rich rendering", () => {
    expect(projectAgentRuntimeItem(tool("mcp__nodex_app__search"))).toMatchObject({
      type: "dynamicToolCall",
      namespace: "nodex_app",
      tool: "search",
    });
  });

  test("execution plumbing never reaches the transcript and task calls defer to the task row", () => {
    for (const name of ["list_agent_models", "task_status", "task_wait"])
      for (const status of ["running", "completed", "failed"] as const)
        expect(projectAgentRuntimeItem(tool(`nodex_app.${name}`, status))).toBeNull();
    for (const name of ["mcp__nodex_app__delegate_task", "nodex_app.task_cancel"]) {
      expect(isAgentRuntimeItemHidden(tool(name, "running"))).toBe(true);
      expect(isAgentRuntimeItemHidden(tool(name, "completed"))).toBe(true);
      // A failed delegation has no task row, so the failure stays visible.
      expect(projectAgentRuntimeItem(tool(name, "failed"))).toMatchObject({ status: "failed" });
    }
    expect(projectAgentRuntimeItem(tool("nodex_app.task_send"))).not.toBeNull();
    expect(projectAgentRuntimeItem(tool("other.task_status"))).not.toBeNull();
  });
});

describe("Runtime delegated task rows", () => {
  test("created conversations retain their selected model in the transcript", () => {
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "thread_created",
        targetThreadId: "child",
        targetRunId: "child-run",
        targetProviderInstanceId: "codex",
        targetModel: "gpt-6.1-sol",
      }),
    ).toEqual({
      type: "subAgentActivity",
      id: "item",
      kind: "started",
      agentThreadId: "child",
      agentPath: "child",
      model: "gpt-6.1-sol",
      reasoningEffort: null,
    });
  });

  test("a task reports its own lifecycle instead of a creation outcome", () => {
    const statuses = (
      ["running", "waiting", "completed", "failed", "interrupted", "cancelled"] as const
    ).map((status) => {
      const projected = projectAgentRuntimeItem(task(status));
      return projected?.type === "delegatedTask" ? projected.status : null;
    });
    expect(statuses).toEqual(["running", "waiting", "completed", "failed", "stopped", "cancelled"]);
  });

  test("rows carry the task identity, owner Run and a readable title", () => {
    expect(projectAgentRuntimeItem(task("running", { progress: "Reading files" }))).toEqual({
      type: "delegatedTask",
      id: "item",
      taskId: "task",
      ownerRunId: "parent-run",
      childThreadId: "child",
      title: "Review the auth module",
      providerInstanceId: "claude",
      status: "running",
      prompt: "Review the auth module\nand report findings",
      summary: "Reading files",
    });
    expect(
      projectAgentRuntimeItem(task("completed", { title: "Audit", result: "No issues" })),
    ).toMatchObject({ title: "Audit", summary: "No issues" });
  });
});

describe("Runtime message attribution and notices", () => {
  test("input another Agent sent links to the sending conversation", () => {
    expect(
      projectAgentRuntimeItem(
        message({ createdBy: "agent", creationSource: "mcp", senderThreadId: "parent" }),
      ),
    ).toMatchObject({ origin: { kind: "agent", senderThreadId: "parent" } });
    expect(
      projectAgentRuntimeItem(message({ createdBy: "agent", creationSource: "server" })),
    ).toMatchObject({ origin: { kind: "nodex" } });
    expect(projectAgentRuntimeItem(message({}))).not.toHaveProperty("origin");
  });

  test("steered and queued input keep their delivery intent", () => {
    expect(projectAgentRuntimeItem(message({ inputIntent: "steer" }))).toMatchObject({
      inputIntent: "steer",
    });
    expect(projectAgentRuntimeItem(message({ inputIntent: "queued_turn" }))).toMatchObject({
      inputIntent: "queued",
    });
    expect(projectAgentRuntimeItem(message({ inputIntent: "turn_start" }))).not.toHaveProperty(
      "inputIntent",
    );
  });

  test("reported work names the one task it can open", () => {
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "notification",
        source: { kind: "subagent", childThreadId: "child" },
        outcome: "completed",
        summary: 'Subagent "Audit" finished',
      }),
    ).toEqual({
      type: "runtimeNotice",
      id: "item",
      message: 'Subagent "Audit" finished',
      notice: { kind: "report", source: "subagent", outcome: "completed", childThreadId: "child" },
    });
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "notification",
        source: { kind: "system" },
        outcome: "updated",
        summary: "Nodex restarted and resumed this turn",
      }),
    ).toMatchObject({ notice: { kind: "report", source: "system", childThreadId: null } });
  });

  test("a stopped Run ends with one marker; the request bookkeeping stays hidden", () => {
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "run_interrupt_result",
        status: "interrupted",
        message: "Run interrupted by user",
      }),
    ).toMatchObject({ type: "runtimeNotice", message: "Stopped", notice: { kind: "stopped" } });
    expect(
      projectAgentRuntimeItem({ ...base, type: "run_interrupt_request", message: "Stop" }),
    ).toBeNull();
  });

  test("a handoff names the Agents it moved between, never the history it carried", () => {
    const handoff = {
      ...base,
      type: "handoff",
      contextHandoffId: "handoff",
      fromProviderThreadIds: ["codex-thread"],
      toProviderThreadId: "claude-thread",
      fromProviderInstanceIds: ["codex"],
      toProviderInstanceId: "claude",
      toModel: "sonnet",
      strategy: "full_thread_summary",
      summary: "[Historical user; user_message] the whole earlier conversation",
    } as Extract<AgentTurnItem, { type: "handoff" }>;
    expect(
      projectAgentRuntimeItem({
        ...handoff,
        fromModelSelections: [{ instanceId: "codex", model: "gpt" }],
      }),
    ).toEqual({
      type: "runtimeNotice",
      id: "item",
      message: "Context handoff to sonnet",
      notice: {
        kind: "agentHandoff",
        carried: "conversation",
        failed: false,
        from: [{ providerInstanceId: "codex", model: "gpt" }],
        to: { providerInstanceId: "claude", model: "sonnet" },
      },
    });
    // Returning to an Agent carries only what it missed; a merged fork carries the fork's work.
    expect(
      projectAgentRuntimeItem({ ...handoff, strategy: "delta_since_target_last_seen" }),
    ).toMatchObject({ notice: { carried: "missed" } });
    expect(
      projectAgentRuntimeItem({ ...handoff, strategy: "fork_delta_summary", status: "failed" }),
    ).toMatchObject({ notice: { carried: "fork", failed: true } });
    // Without recorded source models the Agents still name the handoff.
    expect(projectAgentRuntimeItem(handoff)).toMatchObject({
      notice: { from: [{ providerInstanceId: "codex", model: null }] },
    });
  });
});

describe("Runtime Turn metadata", () => {
  test("hooks stay out of the transcript and read as the Turn's hook runs", () => {
    const hook: Extract<AgentTurnItem, { type: "hook_run" }> = {
      ...base,
      type: "hook_run",
      eventName: "userPromptSubmit",
      source: "project",
      sourcePath: "/workspace/.codex/hooks.json",
      hookStatus: "blocked",
      statusMessage: null,
      entries: [{ kind: "feedback", text: "Fix it before retrying." }],
    };
    expect(isAgentRuntimeItemHidden(hook)).toBe(true);
    expect(projectAgentRuntimeHookRun(hook).run).toMatchObject({
      eventName: "userPromptSubmit",
      source: "project",
      status: "blocked",
      entries: [{ kind: "feedback", text: "Fix it before retrying." }],
    });
  });
  test("reviews, cited memory and command reads keep what the reply footer reads", () => {
    expect(
      projectAgentRuntimeItem(
        {
          ...base,
          type: "approval_review",
          targetItemId: null,
          actionKind: "command",
          actionSummary: "touch protected.txt",
          decision: "denied",
          riskLevel: "low",
          userAuthorization: "low",
          rationale: "Not requested.",
        },
        "/workspace",
      ),
    ).toMatchObject({
      type: "automaticApprovalReview",
      action: { type: "command", command: "touch protected.txt" },
      status: "denied",
      rationale: "Not requested.",
    });
    const citation = {
      entries: [{ path: "MEMORY.md", lineStart: 2, lineEnd: 4, note: "Convention." }],
      threadIds: [],
    };
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "assistant_message",
        messageId: "reply",
        text: "Done.",
        streaming: false,
        memoryCitation: citation,
      }),
    ).toMatchObject({ type: "agentMessage", memoryCitation: citation });
    const read = {
      type: "read",
      command: "cat SKILL.md",
      name: "SKILL.md",
      path: "/w/SKILL.md",
    } as const;
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "command_execution",
        input: "cat SKILL.md",
        commandActions: [read],
      }),
    ).toMatchObject({ type: "commandExecution", commandActions: [read] });
  });
});

describe("Runtime user messages", () => {
  test("show only what the user wrote, never the app data sent beside it", () => {
    const projected = projectAgentRuntimeItem(
      message({
        text: "Use the selected variant\n\n[Visualization changes](t3-context://v1/nodex-app-context/0123abcd)",
      }),
    );
    expect(projected).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: "Use the selected variant" }],
    });
  });
});
