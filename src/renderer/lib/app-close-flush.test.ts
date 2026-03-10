import { describe, expect, test } from "bun:test";

const invokeCalls: unknown[][] = [];
let closeListener: ((...args: unknown[]) => void) | null = null;

const windowApi = {
  invoke: async (...args: unknown[]) => {
    invokeCalls.push(args);
    return undefined;
  },
  on: (event: string, callback: (...args: unknown[]) => void) => {
    if (event === "app:flush-before-close") {
      closeListener = callback;
    }
    return () => undefined;
  },
};

(globalThis as { window?: unknown }).window = {
  api: windowApi,
} as Window & typeof globalThis;

describe("app-close-flush", () => {
  test("waits for all registered handlers and acks once", async () => {
    invokeCalls.length = 0;
    const { registerAppCloseFlushHandler } = await import("./app-close-flush");
    const calls: string[] = [];
    const unregisterSuccess = registerAppCloseFlushHandler(async () => {
      calls.push("first:start");
      await Promise.resolve();
      calls.push("first:end");
    });
    const unregisterFailure = registerAppCloseFlushHandler(async () => {
      calls.push("second:start");
      throw new Error("boom");
    });

    closeListener?.(42);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.stringify(calls)).toBe(JSON.stringify([
      "first:start",
      "second:start",
      "first:end",
    ]));
    expect(JSON.stringify(invokeCalls)).toBe(JSON.stringify([
      ["app:flush-before-close:done", 42],
    ]));

    unregisterSuccess();
    unregisterFailure();
  });
});
