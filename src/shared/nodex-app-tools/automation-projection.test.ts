import { describe, expect, test } from "vite-plus/test";
import type { CodexCanonicalItem } from "../codex-conversation-state/codex-conversation-state";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import { projectNativeAutomationUpdate } from "./automation-projection";

type McpItem = Extract<CodexCanonicalItem, { type: "mcpToolCall" }>;
const proposal = {
  mode: "suggested_update",
  kind: "heartbeat",
  id: "automation-1",
  expectedRevision: 7,
  status: "PAUSED",
  name: "Follow up",
  prompt: "Check progress",
  rrule: "FREQ=DAILY",
  targetSessionId: "session:resolved",
  notificationPolicy: null,
} as const;
function item(overrides: Partial<McpItem> = {}): McpItem {
  return {
    type: "mcpToolCall",
    id: "call-1",
    server: "nodex_app",
    tool: "automation_update",
    status: "completed",
    arguments: { ...proposal, targetSessionId: "session:raw" },
    appContext: null,
    pluginId: null,
    readOnlyHint: false,
    result: {
      content: [],
      structuredContent: { ok: true, data: { proposal, committed: false } },
      _meta: null,
    },
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

  test.each([
    { server: "unrelated" },
    { status: "inProgress" },
    {
      result: {
        content: [],
        structuredContent: { ok: false, data: { proposal, committed: false } },
        _meta: null,
      },
    },
    {
      result: {
        content: [],
        structuredContent: {
          ok: true,
          data: { proposal: { ...proposal, targetSessionId: undefined }, committed: false },
        },
        _meta: null,
      },
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
        arguments: { mode: "view", id: "automation-1" },
        result: {
          content: [],
          structuredContent: {
            ok: true,
            data: {
              item: {
                id: "automation-1",
                kind: "heartbeat",
                name: "Current task",
                rrule: "FREQ=WEEKLY",
              },
            },
          },
          _meta: null,
        },
      }),
    );
    expect(projected?.result).toMatchObject({
      automationId: "automation-1",
      snapshot: { name: "Current task", rrule: "FREQ=WEEKLY" },
    });
    expect(projected?.proposal).toBeUndefined();
  });
});
