import { describe, expect, test, vi } from "vite-plus/test";

function restoreWindow(originalWindowDescriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as { window?: unknown }).window;
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  }
}

describe("renderer api transport", () => {
  test("uses the Electron bridge for typed commands even when window.api appears after import", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    delete (globalThis as { window?: unknown }).window;

    try {
      vi.resetModules();
      const { prepareOwnedBlockDocument } = await import("./api");
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

      const result = await prepareOwnedBlockDocument("project-1", "page-1");

      expect(result).toBe("ok");
      expect(JSON.stringify(invokeCalls)).toBe(
        JSON.stringify([["block-document:owned:prepare", "project-1", "page-1"]]),
      );
    } finally {
      restoreWindow(originalWindowDescriptor);
    }
  });

  test("preserves local abort semantics when cancellation races IPC completion", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    let resolveSearch!: (value: unknown) => void;
    const searchResult = new Promise<unknown>((resolve) => {
      resolveSearch = resolve;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        api: {
          invoke: async (channel: string) => {
            if (channel !== "find:search") return false;
            return await searchResult;
          },
        },
      },
    });

    try {
      const { findContent } = await import("./find");
      const controller = new AbortController();
      const search = findContent(
        {
          query: "codex electron",
          kinds: ["page"],
          place: { kind: "project", projectId: "project-1" },
          limit: 1,
        },
        "instant",
        controller.signal,
      );

      controller.abort();
      resolveSearch({
        phase: "instant",
        hits: [],
        coverage: [],
        truncated: false,
        nextCursor: null,
      });

      await expect(search).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      restoreWindow(originalWindowDescriptor);
    }
  });
});
