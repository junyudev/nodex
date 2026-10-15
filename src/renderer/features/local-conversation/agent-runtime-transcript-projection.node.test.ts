import { describe, expect, test } from "vite-plus/test";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import {
  isAgentRuntimeItemHidden,
  parseAgentRuntimeToolName,
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
});
