import { describe, expect, test } from "bun:test";

describe("renderer api transport", () => {
  test("uses the Electron bridge even when window.api appears after import", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    delete (globalThis as { window?: unknown }).window;

    try {
      const { invoke } = await import("./api");
      const invokeCalls: unknown[][] = [];

      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: {
          api: {
            invoke: async (...args: unknown[]) => {
              invokeCalls.push(args);
              return "ok";
            },
          },
        },
      });

      const result = await invoke("window:new");

      expect(result).toBe("ok");
      expect(JSON.stringify(invokeCalls)).toBe(JSON.stringify([
        ["window:new"],
      ]));
    } finally {
      delete (globalThis as { window?: unknown }).window;
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });
});
