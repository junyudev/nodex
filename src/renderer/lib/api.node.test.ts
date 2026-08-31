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

  test("decodes completed and cancelled Page search IPC outcomes", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    let cancelled = false;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        api: {
          invoke: async (channel: string) => {
            if (channel !== "pages:search") return false;
            if (cancelled) return { status: "cancelled" };
            return {
              status: "completed",
              snapshot: {
                libraryId: "library-1",
                storeEpoch: "epoch-1",
                commitSeq: 1,
                results: [],
              },
            };
          },
        },
      },
    });

    try {
      const { searchPages } = await import("./api");
      const input = { projectIds: ["project-1"], query: "codex electron" };

      await expect(searchPages(input)).resolves.toMatchObject({
        libraryId: "library-1",
        results: [],
      });
      cancelled = true;
      await expect(searchPages(input)).rejects.toMatchObject({ name: "AbortError" });
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
            if (channel !== "pages:search") return false;
            return await searchResult;
          },
        },
      },
    });

    try {
      const { searchPages } = await import("./api");
      const controller = new AbortController();
      const search = searchPages(
        { projectIds: ["project-1"], query: "codex electron" },
        controller.signal,
      );

      controller.abort();
      resolveSearch({
        status: "completed",
        snapshot: {
          libraryId: "library-1",
          storeEpoch: "epoch-1",
          commitSeq: 1,
          results: [],
        },
      });

      await expect(search).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      restoreWindow(originalWindowDescriptor);
    }
  });

  test("routes prompt-rail aborts through the request-scoped cancel channel", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    let resolveIndex!: (value: unknown) => void;
    const indexResult = new Promise<unknown>((resolve) => {
      resolveIndex = resolve;
    });
    const invokeCalls: unknown[][] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        api: {
          invoke: async (channel: string, ...args: unknown[]) => {
            invokeCalls.push([channel, ...args]);
            if (channel === "codex:thread:prompt-rail:index") return await indexResult;
            if (channel === "codex:thread:prompt-rail:cancel") {
              resolveIndex({ status: "cancelled", requestId: args[0] });
              return true;
            }
            throw new Error(`Unexpected channel ${channel}`);
          },
        },
      },
    });

    try {
      const { loadCodexPromptRailIndex } = await import("./api");
      const controller = new AbortController();
      const request = {
        requestId: "prompt-index-1",
        threadId: "thread-a",
        expectedTopologyGeneration: 7,
      };
      const loading = loadCodexPromptRailIndex(request, { signal: controller.signal });
      controller.abort();

      await expect(loading).resolves.toEqual({
        status: "cancelled",
        requestId: request.requestId,
      });
      expect(invokeCalls).toEqual([
        ["codex:thread:prompt-rail:index", request],
        ["codex:thread:prompt-rail:cancel", request.requestId],
      ]);
    } finally {
      restoreWindow(originalWindowDescriptor);
    }
  });
});
