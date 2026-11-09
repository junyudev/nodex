import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { toolFailure, toolSuccess } from "../../main/app-tools/app-tool-result";
import type { CodexCanonicalItem } from "../codex-conversation-state/codex-conversation-state";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import { projectNativeAutomationUpdate } from "./automation-projection";

type McpItem = Extract<CodexCanonicalItem, { type: "mcpToolCall" }>;
const proposal = {
  operation: "suggested_update",
  kind: "heartbeat",
  id: "automation-1",
  expectedRevision: 7,
  status: "PAUSED",
  name: "Follow up",
  prompt: "Check progress",
  rrule: "FREQ=DAILY",
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
      backendBinding: { kind: "opencode", instanceConfigId: "personal" },
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
            rrule: "FREQ=WEEKLY",
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
        rrule: "FREQ=WEEKLY",
        mode: "ask_first",
        runbookPageId: "runbook-page",
      },
    });
    expect(projected?.proposal).toBeUndefined();
  });
});
