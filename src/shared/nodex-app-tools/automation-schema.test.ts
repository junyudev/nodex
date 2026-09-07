import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vite-plus/test";
import { encodeBoundedOperationId } from "../operation-identity";
import { automationSchema, automationTool } from "./automation-schema";

const heartbeat = {
  mode: "create",
  kind: "heartbeat",
  name: "Watch the build",
  prompt: "Check the build and report meaningful changes.",
  rrule: "FREQ=MINUTELY;INTERVAL=30",
};
const cron = {
  ...heartbeat,
  kind: "cron",
  projectId: "project-1",
  executionEnvironment: "local",
  cwds: ["/workspace/project-1"],
};

describe("automation tool input", () => {
  it("accepts independent Cron runs and Session Heartbeats with explicit notification preferences", () => {
    expect(
      automationSchema.parse({ ...cron, projectId: null, cwds: [], notificationPolicy: null }),
    ).toMatchObject({ projectId: null, notificationPolicy: null });
    expect(
      automationSchema.parse({ ...heartbeat, notificationPolicy: "failed_runs_only" }),
    ).toMatchObject({ kind: "heartbeat", notificationPolicy: "failed_runs_only" });
    expect(automationSchema.parse({ ...heartbeat, targetSessionId: "session-1" })).toMatchObject({
      targetSessionId: "session-1",
    });
  });

  it("requires complete revision-fenced updates and deletion commands", () => {
    const update = { ...cron, mode: "update", id: "automation-1", status: "PAUSED" };
    const deletion = { mode: "delete", id: "automation-1" };
    expect(automationSchema.safeParse(update).success).toBe(false);
    expect(automationSchema.safeParse(deletion).success).toBe(false);
    expect(automationSchema.parse({ ...update, expectedRevision: 1 })).toMatchObject({
      status: "PAUSED",
      expectedRevision: 1,
    });
    expect(automationSchema.parse({ ...deletion, expectedRevision: 2 })).toEqual({
      ...deletion,
      expectedRevision: 2,
    });
    for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(automationSchema.safeParse({ ...deletion, expectedRevision }).success).toBe(false);
    }
    for (const input of [
      { mode: "update", id: "automation-1", expectedRevision: 1, status: "PAUSED" },
      { ...update, expectedRevision: 1, status: "DELETED" },
    ]) {
      expect(automationSchema.safeParse(input).success).toBe(false);
    }
  });

  it("rejects mixed targets, unsupported backends, caller authority, and unimplemented modes", () => {
    for (const input of [
      { ...cron, projectId: undefined },
      { ...cron, executionEnvironment: undefined },
      { ...cron, targetSessionId: "session-1" },
      { ...heartbeat, projectId: "project-1" },
      { ...heartbeat, cwds: ["/workspace"] },
      { ...heartbeat, targetThreadId: "thread-1" },
      { ...heartbeat, backendBinding: { kind: "acp", agentDefinitionId: "agent-1" } },
      { ...heartbeat, authority: { scope: "library" } },
      { mode: "view", id: "automation-1", operationId: "unexpected" },
    ]) {
      expect(automationSchema.safeParse(input).success).toBe(false);
    }
  });

  it("preserves runtime-advertised model tuples and bounded exact retry identities", () => {
    const operationId = encodeBoundedOperationId("automation-update", 1_000, "retry-1");
    expect(
      automationSchema.parse({
        ...cron,
        model: "next-model",
        reasoningEffort: "ultra",
        serviceTier: "priority",
        operationId,
      }),
    ).toMatchObject({
      model: "next-model",
      reasoningEffort: "ultra",
      serviceTier: "priority",
      operationId,
    });
    for (const operationId of ["retry-1", "", "x".repeat(513)]) {
      expect(automationSchema.safeParse({ ...heartbeat, operationId }).success).toBe(false);
    }
  });

  it("enforces Core text and collection bounds without counting Unicode names as UTF-16 units", () => {
    expect(automationSchema.safeParse({ ...heartbeat, name: "🦉".repeat(256) }).success).toBe(true);
    for (const input of [
      { ...heartbeat, name: "🦉".repeat(257) },
      { ...heartbeat, name: " " },
      { ...heartbeat, prompt: " " },
      { ...heartbeat, rrule: " " },
      { ...cron, model: "界".repeat(171) },
      { ...cron, reasoningEffort: "界".repeat(22) },
      { ...cron, serviceTier: "x".repeat(65) },
      { ...cron, cwds: Array.from({ length: 129 }, (_, index) => `/workspace/${index}`) },
    ]) {
      expect(automationSchema.safeParse(input).success).toBe(false);
    }
  });

  it("bounds definition discovery and publishes a valid MCP tool contract", () => {
    expect(automationSchema.parse({ mode: "list" })).toEqual({ mode: "list", limit: 20 });
    expect(
      automationSchema.parse({ mode: "list", query: " build ", cursor: "opaque", limit: 100 }),
    ).toEqual({ mode: "list", query: "build", cursor: "opaque", limit: 100 });
    for (const input of [
      { mode: "list", limit: 101 },
      { mode: "list", limit: 0 },
      { mode: "list", cursor: "x".repeat(2049) },
      { mode: "list", query: "x".repeat(513) },
    ]) {
      expect(automationSchema.safeParse(input).success).toBe(false);
    }
    expect(ToolSchema.parse(automationTool).annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});
