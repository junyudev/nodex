import { describe, expect, test, it } from "vite-plus/test";
import { z } from "zod";
import { toolFailure, toolSuccess } from "../../main/app-tools/app-tool-result";
import type { CodexCanonicalItem } from "../codex-conversation-state/codex-conversation-state";
import { agentActivityV2DynamicAutomationUpdateItem } from "../codex-conversation-state/test-fixtures/agent-activity-v2-item-family-corpus";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import { projectNativeAutomationUpdate } from "./automation-projection";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { automationSchema, automationTool } from "./automation-schema";

describe("automation projection", () => {
  type McpItem = Extract<CodexCanonicalItem, { type: "mcpToolCall" }>;
  const proposal = {
    operation: "suggested_update",
    kind: "heartbeat",
    id: "automation-1",
    expectedRevision: 7,
    status: "PAUSED",
    name: "Follow up",
    prompt: "Check progress",
    trigger: { kind: "clock", rrule: "FREQ=DAILY" },
    targetSessionId: "session:resolved",
    notificationPolicy: null,
    mode: "run",
    runbookPageId: "runbook-page",
  } as const;
  function nativeResult(value: Record<string, unknown>): McpItem["result"] {
    const result = z
      .object({ content: z.array(z.json()), structuredContent: z.json() })
      .parse(JSON.parse(JSON.stringify(toolSuccess(value))));
    return { ...result, _meta: null };
  }
  function item(overrides: Partial<McpItem> = {}): McpItem {
    return {
      type: "mcpToolCall",
      environmentId: null,
      id: "call-1",
      server: "nodex_app",
      tool: "automations_update",
      status: "completed",
      arguments: { ...proposal, targetSessionId: "session:raw" },
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: false,
      result: nativeResult({ proposal, committed: false }),
      error: null,
      durationMs: 2,
      ...overrides,
    };
  }

  const eventTrigger = {
    kind: "event",
    filter: {
      sourceId: null,
      repositories: [],
      events: ["check_failed"],
      labels: [],
      actorClass: "any",
    },
  };

  describe("native Automation result projection", () => {
    test("keeps canonical MCP identity and the validated result proposal", () => {
      const source = item();
      const [view] = projectCodexCanonicalTurnItemViews({
        threadId: "thread-1",
        turnId: "turn-1",
        items: [source],
        observedAtMs: 1,
        turnStatus: "completed",
        commandExecutionStartedAtMsById: {},
        interruptedCommandExecutionItemIds: [],
      });
      expect(view?.semanticKind).toBe("mcpToolCall");
      expect(view?.mcpToolCall?.invocation.server).toBe("nodex_app");
      expect(view?.automationUpdate?.proposal).toEqual(proposal);
    });

    test("keeps an OpenCode Owner-review proposal resolved by the Host", () => {
      const resolved = {
        ...proposal,
        backendBinding: { driver: "opencode", instanceId: "personal" },
      };
      const projected = projectNativeAutomationUpdate(
        item({
          result: nativeResult({ proposal: resolved, committed: false }),
        }),
      );
      expect(projected?.proposal).toEqual(resolved);
    });

    test.each([
      { server: "unrelated" },
      { status: "inProgress" },
      { result: nativeResult({ ok: false, proposal, committed: false }) },
      {
        result: nativeResult({
          ...toolFailure("unauthorized").structuredContent,
          proposal,
          committed: false,
        }),
      },
      {
        result: nativeResult({
          proposal: { ...proposal, targetSessionId: undefined },
          committed: false,
        }),
      },
    ] as Partial<McpItem>[])(
      "does not turn an unrelated, unfinished, or invalid result into an actionable card",
      (overrides) => {
        expect(projectNativeAutomationUpdate(item(overrides))).toBeUndefined();
      },
    );

    test("opens a successful view using the returned definition identity", () => {
      const projected = projectNativeAutomationUpdate(
        item({
          arguments: { operation: "view", id: "automation-1" },
          result: nativeResult({
            item: {
              id: "automation-1",
              kind: "heartbeat",
              name: "Current task",
              trigger: { kind: "clock", rrule: "FREQ=WEEKLY", timezone: "UTC", nextRunAt: null },
              mode: "ask_first",
              runbookPageId: "runbook-page",
            },
          }),
        }),
      );
      expect(projected?.result).toMatchObject({
        automationId: "automation-1",
        snapshot: {
          name: "Current task",
          trigger: { kind: "clock", rrule: "FREQ=WEEKLY", timezone: "UTC", nextRunAt: null },
          mode: "ask_first",
          runbookPageId: "runbook-page",
        },
      });
      expect(projected?.proposal).toBeUndefined();
    });

    test("projects event definitions and rejects mixed trigger fields", () => {
      const trigger = eventTrigger;
      const read = (value: unknown) =>
        projectNativeAutomationUpdate(
          item({
            arguments: { operation: "view", id: "automation-1" },
            result: nativeResult({
              item: { id: "automation-1", kind: "cron", name: "Current task", trigger: value },
            }),
          }),
        );

      expect(read(trigger)?.result?.snapshot?.trigger).toEqual(trigger);
      expect(read({ ...trigger, rrule: "FREQ=DAILY" })).toBeUndefined();
    });
  });

  test("uses a deleted event Automation's trigger from the dynamic tool receipt", () => {
    const snapshot = { kind: "cron", name: "Check failed builds", trigger: eventTrigger };
    const receipt = { automationId: "automation-1", operation: "delete", deleteStatus: "deleted" };
    const [view] = projectCodexCanonicalTurnItemViews({
      threadId: "thread-1",
      turnId: "turn-1",
      items: [
        {
          ...agentActivityV2DynamicAutomationUpdateItem,
          arguments: { operation: "delete", id: receipt.automationId },
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({ ...receipt, snapshot }),
            },
          ],
        },
      ],
      observedAtMs: 1,
      turnStatus: "completed",
      commandExecutionStartedAtMsById: {},
      interruptedCommandExecutionItemIds: [],
    });

    expect(view?.automationUpdate?.result).toEqual({ ...receipt, snapshot });
    expect(view?.automationUpdate?.arguments).toMatchObject(snapshot);
  });
});

describe("automation schema", () => {
  const heartbeat = {
    operation: "create",
    kind: "heartbeat",
    name: "Watch the build",
    prompt: "Check the build and report meaningful changes.",
    trigger: { kind: "clock", rrule: "FREQ=MINUTELY;INTERVAL=30" },
  };
  const cron = {
    ...heartbeat,
    kind: "cron",
    projectId: "project-1",
    executionEnvironment: "local",
    cwds: ["/workspace/project-1"],
  };

  const eventTrigger = { kind: "event", filter: { events: ["check_failed"] } };

  describe("Automation tool input", () => {
    it("accepts an event trigger without a schedule and fills the filter defaults", () => {
      expect(
        automationSchema.parse({
          ...cron,
          trigger: eventTrigger,
          conditionText: "The failure is on main",
          model: "reviewer",
        }),
      ).toMatchObject({
        trigger: {
          kind: "event",
          filter: {
            sourceId: null,
            repositories: [],
            events: ["check_failed"],
            labels: [],
            actorClass: "any",
          },
        },
      });
    });

    it.each([
      { ...cron, trigger: { ...eventTrigger, rrule: "FREQ=DAILY" } },
      { ...cron, trigger: { ...eventTrigger, timezone: "UTC" } },
      { ...cron, trigger: { kind: "clock", timezone: "UTC" } },
      { ...heartbeat, trigger: eventTrigger },
      { ...cron, rrule: "FREQ=DAILY" },
      { ...cron, timezone: "UTC" },
      { ...cron, sourceCondition: eventTrigger.filter },
    ])("rejects invalid trigger combinations: %j", (input) => {
      expect(automationSchema.safeParse(input).success).toBe(false);
    });

    it.each([
      { field: "rrule", characters: 8192 },
      { field: "timezone", characters: 256 },
    ])("applies UTF-8 byte bounds to trigger.$field", ({ field, characters }) => {
      const atLimit = { ...heartbeat.trigger, [field]: "é".repeat(characters) };
      expect(automationSchema.safeParse({ ...heartbeat, trigger: atLimit }).success).toBe(true);

      const overLimit = { ...atLimit, [field]: "é".repeat(characters + 1) };
      const result = automationSchema.safeParse({ ...heartbeat, trigger: overLimit });
      expect(result.error?.issues).toEqual([expect.objectContaining({ path: ["trigger", field] })]);
    });

    it("separates Automation mode from the requested operation and retains clock authority", () => {
      for (const mode of ["dry_run", "ask_first", "run"] as const) {
        expect(
          automationSchema.parse({
            ...cron,
            operation: "suggested_create",
            mode,
            ownerMemberId: "member:owner",
            scope: { kind: "space" },
            conditionText: "Every weekday at nine",
            trigger: { ...cron.trigger, timezone: "Asia/Singapore" },
          }),
        ).toMatchObject({
          operation: "suggested_create",
          mode,
          ownerMemberId: "member:owner",
          scope: { kind: "space" },
          trigger: { ...cron.trigger, timezone: "Asia/Singapore" },
        });
      }
      expect(automationSchema.safeParse({ ...cron, mode: "automatic" }).success).toBe(false);
      expect(
        automationSchema.safeParse({ ...cron, operation: undefined, mode: "create" }).success,
      ).toBe(false);
    });

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

    it("accepts an exact ACP instance without treating a missing instance as a default", () => {
      const backendBinding = { driver: "acpRegistry", instanceId: "personal" };
      expect(automationSchema.parse({ ...cron, backendBinding })).toMatchObject({ backendBinding });
      expect(automationSchema.parse({ ...heartbeat, backendBinding })).toMatchObject({
        backendBinding,
      });
      for (const instanceId of [null, undefined, "", " "]) {
        expect(
          automationSchema.safeParse({
            ...cron,
            backendBinding: { ...backendBinding, instanceId },
          }).success,
        ).toBe(false);
      }
    });

    it("retains exact configured and unfamiliar Agent instances in Automations and proposed edits", () => {
      for (const driver of ["claudeAgent", "opencode", "futureAgent"] as const) {
        const backendBinding = { driver, instanceId: "configured-instance" };
        expect(automationSchema.parse({ ...cron, backendBinding })).toMatchObject({
          backendBinding,
        });
        expect(
          automationSchema.parse({ ...heartbeat, operation: "suggested_create", backendBinding }),
        ).toMatchObject({ backendBinding });
        expect(automationSchema.safeParse({ ...cron, backendBinding: { driver } }).success).toBe(
          false,
        );
      }
    });

    it("requires complete revision-fenced updates and deletion commands", () => {
      const update = { ...cron, operation: "update", id: "automation-1", status: "PAUSED" };
      const deletion = { operation: "delete", id: "automation-1" };
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
        { operation: "update", id: "automation-1", expectedRevision: 1, status: "PAUSED" },
        { ...update, expectedRevision: 1, status: "DELETED" },
      ]) {
        expect(automationSchema.safeParse(input).success).toBe(false);
      }
    });

    it("rejects mixed targets, malformed bindings, caller authority, and unimplemented modes", () => {
      for (const input of [
        { ...cron, projectId: undefined },
        { ...cron, executionEnvironment: undefined },
        { ...cron, targetSessionId: "session-1" },
        { ...heartbeat, projectId: "project-1" },
        { ...heartbeat, cwds: ["/workspace"] },
        { ...heartbeat, targetThreadId: "thread-1" },
        { ...heartbeat, backendBinding: { driver: "acpRegistry", instanceId: "1-invalid" } },
        { ...heartbeat, authority: { scope: "library" } },
        { operation: "view", id: "automation-1", operationId: "unexpected" },
      ]) {
        expect(automationSchema.safeParse(input).success).toBe(false);
      }
    });

    it("accepts opaque retry keys and preserves runtime-advertised model tuples", () => {
      const idempotencyKey = "06d6709c-45e7-4b37-8c26-74e9d64c5aa1";
      expect(
        automationSchema.parse({
          ...cron,
          model: "next-model",
          reasoningEffort: "ultra",
          serviceTier: "priority",
          idempotencyKey,
        }),
      ).toMatchObject({
        model: "next-model",
        reasoningEffort: "ultra",
        serviceTier: "priority",
        idempotencyKey,
      });
      for (const idempotencyKey of ["", "x".repeat(129)]) {
        expect(automationSchema.safeParse({ ...heartbeat, idempotencyKey }).success).toBe(false);
      }
    });

    it("enforces Core text and collection bounds without counting Unicode names as UTF-16 units", () => {
      expect(automationSchema.safeParse({ ...heartbeat, name: "🦉".repeat(256) }).success).toBe(
        true,
      );
      for (const input of [
        { ...heartbeat, name: "🦉".repeat(257) },
        { ...heartbeat, name: " " },
        { ...heartbeat, prompt: " " },
        { ...heartbeat, trigger: { ...heartbeat.trigger, rrule: " " } },
        { ...cron, model: "界".repeat(171) },
        { ...cron, scope: { kind: "project", projectId: "界".repeat(171) } },
        { ...cron, reasoningEffort: "界".repeat(22) },
        { ...cron, serviceTier: "x".repeat(65) },
        { ...cron, cwds: Array.from({ length: 129 }, (_, index) => `/workspace/${index}`) },
      ]) {
        expect(automationSchema.safeParse(input).success).toBe(false);
      }
    });

    it("bounds definition discovery and publishes a valid MCP tool contract", () => {
      expect(automationSchema.parse({ operation: "list" })).toEqual({
        operation: "list",
        limit: 20,
      });
      expect(
        automationSchema.parse({
          operation: "list",
          query: " build ",
          cursor: "opaque",
          limit: 100,
        }),
      ).toEqual({ operation: "list", query: " build ", cursor: "opaque", limit: 100 });
      for (const input of [
        { operation: "list", limit: 101 },
        { operation: "list", limit: 0 },
        { operation: "list", cursor: "x".repeat(2049) },
        { operation: "list", query: "x".repeat(513) },
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
});
