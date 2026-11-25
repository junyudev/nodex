import { describe, expect, test } from "vite-plus/test";
import { buildMcpAppFollowUpPrompt, parseMcpAppFollowUpMessage } from "./mcp-app-follow-up";
import { createMcpAppHostHandlerPort, createMcpAppPortCall } from "./mcp-app-port-rpc";

describe("MCP App follow-up messages", () => {
  test("normalizes a valid message and appends structured context to the prompt", () => {
    const message = parseMcpAppFollowUpMessage({
      context: { selectedDate: "2026-08-11" },
      ignored: true,
      prompt: "  Book this date  ",
      title: "  Confirm booking  ",
    });

    expect(message).toEqual({
      context: { selectedDate: "2026-08-11" },
      prompt: "Book this date",
      title: "Confirm booking",
    });
    expect(buildMcpAppFollowUpPrompt(message!)).toBe(
      'Book this date\n\nCurrent widget context (JSON):\n{\n  "selectedDate": "2026-08-11"\n}',
    );
  });

  test("rejects empty prompts, oversized titles, and oversized context", () => {
    expect(parseMcpAppFollowUpMessage({ prompt: "  " })).toBeNull();
    expect(parseMcpAppFollowUpMessage({ prompt: "Continue", title: "x".repeat(251) })).toBeNull();
    expect(
      parseMcpAppFollowUpMessage({ prompt: "Continue", context: "x".repeat(32_769) }),
    ).toBeNull();
  });
});

describe("MCP App port RPC", () => {
  test("resolves a host call over a per-call reply channel", async () => {
    const port = createMcpAppHostHandlerPort(async (input) => ({ input }));
    const call = createMcpAppPortCall(port);

    await expect(call("fixture")).resolves.toEqual({ input: "fixture" });
    port.close();
  });

  test("serializes safe error fields without a stack", async () => {
    const port = createMcpAppHostHandlerPort(() => {
      const error = new Error("denied");
      Object.assign(error, { code: -32_601 });
      throw error;
    });
    const call = createMcpAppPortCall(port);

    await expect(call(undefined)).rejects.toMatchObject({
      message: "denied",
      code: -32_601,
    });
    port.close();
  });

  test("aborts a pending call", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    const controller = new AbortController();
    const call = createMcpAppPortCall(channel.port2, controller.signal);
    const pending = call(undefined, { timeoutMs: null });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    channel.port1.close();
    channel.port2.close();
  });
});
