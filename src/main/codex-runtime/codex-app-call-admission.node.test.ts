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
  ledger.startTurn("thread-1", "turn-1");
  ledger.observe(event());
  return ledger;
};

describe("native MCP invocation admission", () => {
  it("requires trusted observation and exact caller, tool and arguments", () => {
    const ledger = createCodexAppCallAdmission();
    expect(ledger.claim(request())).toBeNull();
    expect(ledger.observe(event())).toBe(false);
    ledger.startTurn("thread-1", "turn-1");
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

  it.each(["end", "replace", "close"])("revokes active claims on %s", (action) => {
    const ledger = ready();
    const claim = ledger.claim(request());
    expect(claim?.isActive()).toBe(true);
    if (action === "end") ledger.endTurn("thread-1", "turn-1");
    if (action === "replace") ledger.startTurn("thread-1", "turn-2");
    if (action === "close") ledger.close();
    expect(claim?.isActive()).toBe(false);
    expect(ledger.claim(request())).toBeNull();
  });

  it("isolates generations and does not evict admitted calls to fit overflow", () => {
    const ledger = createCodexAppCallAdmission(1);
    ledger.startTurn("thread-1", "turn-1");
    expect(ledger.observe(event())).toBe(true);
    expect(ledger.observe(event("call-2"))).toBe(false);
    expect(createCodexAppCallAdmission().claim(request())).toBeNull();
    expect(ledger.claim(request())?.isActive()).toBe(true);
    ledger.endTurn("thread-1", "turn-1");
    ledger.startTurn("thread-1", "turn-2");
    expect(ledger.observe({ ...event("call-2"), turnId: "turn-2" })).toBe(true);
  });
});
