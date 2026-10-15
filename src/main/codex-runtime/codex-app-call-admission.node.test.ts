import type { ItemStartedNotification } from "@nodex/codex-app-server-protocol/v2/ItemStartedNotification";
import { describe, expect, it } from "vitest";
import { createCodexAppCallAdmission } from "./codex-app-call-admission";

const event = (id = "call-1"): ItemStartedNotification => ({
  threadId: "thread-1",
  turnId: "turn-1",
  startedAtMs: 1,
  item: {
    type: "mcpToolCall",
    id,
    server: "nodex_app",
    tool: "read_page",
    status: "inProgress",
    arguments: { pageId: "page-1" },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: true,
    result: null,
    error: null,
    durationMs: null,
  },
});
const request = () => ({
  name: "read_page",
  arguments: { pageId: "page-1" },
  metadata: {
    callId: "call-1",
    "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1" },
  },
});
const ready = () => {
  const ledger = createCodexAppCallAdmission();
  ledger.observe(event());
  return ledger;
};

describe("native MCP invocation admission", () => {
  it("requires trusted observation and exact caller, tool and arguments", () => {
    const ledger = createCodexAppCallAdmission();
    expect(ledger.claim(request())).toBeNull();
    expect(ledger.observe(event())).toBe(true);
    expect(ledger.claim({ ...request(), name: "delete_page" })).toBeNull();
    expect(ledger.claim({ ...request(), arguments: { pageId: "page-2" } })).toBeNull();
    const forged = request();
    forged.metadata["x-codex-turn-metadata"].thread_id = "other-thread";
    expect(ledger.claim(forged)).toBeNull();
    expect(ledger.claim(request())?.isActive()).toBe(true);
  });

  it("does not admit a call twice even after duplicate protocol delivery", () => {
    const ledger = ready();
    expect(ledger.claim(request())).not.toBeNull();
    expect(ledger.observe(event())).toBe(false);
    expect(ledger.claim(request())).toBeNull();
  });

  it.each(["complete", "cancel", "close"])("revokes the exact call on %s", (action) => {
    const ledger = ready();
    const claim = ledger.claim(request());
    expect(claim?.isActive()).toBe(true);
    if (action === "complete") ledger.completeCall("thread-1", "turn-1", "call-1");
    if (action === "cancel") ledger.cancelTurn("thread-1", "turn-1");
    if (action === "close") ledger.close();
    expect(claim?.isActive()).toBe(false);
    expect(ledger.claim(request())).toBeNull();
    if (action === "cancel") expect(ledger.observe(event("late-call"))).toBe(false);
  });

  it("retains original background calls and distinguishes reused call IDs by native Turn", () => {
    const ledger = ready();
    const first = ledger.claim(request());
    expect(ledger.observe({ ...event(), turnId: "turn-2" })).toBe(true);
    const second = ledger.claim({
      ...request(),
      metadata: {
        callId: "call-1",
        "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-2" },
      },
    });
    expect(first?.turnId).toBe("turn-1");
    expect(second?.turnId).toBe("turn-2");
    expect(first?.isActive()).toBe(true);
    ledger.completeCall("thread-1", "turn-2", "call-1");
    expect(first?.isActive()).toBe(true);
    expect(second?.isActive()).toBe(false);
    ledger.close();
    expect(first?.isActive()).toBe(false);
  });

  it("releases completed bodies and fails closed on count, byte and cancellation overflow", () => {
    const ledger = createCodexAppCallAdmission(1);
    expect(ledger.observe(event())).toBe(true);
    const first = ledger.claim(request());
    ledger.completeCall("thread-1", "turn-1", "call-1");
    expect(first?.isActive()).toBe(false);
    expect(ledger.observe(event("call-2"))).toBe(true);
    expect(ledger.observe(event("call-3"))).toBe(false);
    expect(ledger.overflowed).toBe(true);
    expect(createCodexAppCallAdmission().claim(request())).toBeNull();
    const bytes = createCodexAppCallAdmission();
    const oversized = event();
    if (oversized.item.type !== "mcpToolCall") throw new Error("Expected MCP call");
    oversized.item.arguments = { text: "x".repeat(4 * 1024 * 1024) };
    expect(bytes.observe(oversized)).toBe(false);
    expect(bytes.overflowed).toBe(true);
    const cancelled = createCodexAppCallAdmission(1);
    cancelled.cancelTurn("thread-1", "turn-1");
    cancelled.cancelTurn("thread-1", "turn-2");
    expect(cancelled.overflowed).toBe(true);
    expect(cancelled.observe(event())).toBe(false);
  });
});
