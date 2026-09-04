import { beforeEach, describe, expect, vi, test } from "vite-plus/test";

const invokeCalls: unknown[][] = [];
let closeListener: ((...args: unknown[]) => void) | null = null;

vi.mock("./app-close-flush-deps", () => ({
  notifyAppCloseFlushComplete: async (webContentsId: number) => {
    invokeCalls.push(["app:flush-before-close:done", webContentsId]);
    return undefined;
  },
  readAppCloseBridge: () => ({
    on: (event: string, callback: (...args: unknown[]) => void) => {
      if (event === "app:flush-before-close") {
        closeListener = callback;
      }
      return () => undefined;
    },
    invoke: async () => undefined,
    getPathInfoForFile: () => null,
  }),
}));

async function loadAppCloseFlushModule() {
  vi.resetModules();
  return import("./app-close-flush");
}

describe("app-close-flush", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    closeListener = null;
  });

  test("waits for all registered handlers and acks once", async () => {
    const { registerAppCloseFlushHandler } = await loadAppCloseFlushModule();
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

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify(["first:start", "second:start", "first:end"]),
    );
    expect(JSON.stringify(invokeCalls)).toBe(JSON.stringify([["app:flush-before-close:done", 42]]));

    unregisterSuccess();
    unregisterFailure();
  });
});
