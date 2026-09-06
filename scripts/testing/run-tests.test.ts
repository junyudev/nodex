import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { parseTestSelection, runTests } from "./run-tests";
import { YJS_YRS_TEST } from "../../config/test-suites";

const result = (exitCode = 0) => ({ exitCode, signal: null, durationMs: 1 });
const root = path.resolve(".");

describe("test execution", () => {
  test("forwards focused paths and Vitest flags without shell parsing", () => {
    const args = ["src/main/path with spaces.node.test.ts", "-t", "literal $value"];
    expect(parseTestSelection(["core-client", ...args], "default")).toMatchObject({
      suites: ["core-client"],
      related: false,
      args,
    });
    expect(parseTestSelection(["core-client", "--related", ...args], "default").related).toBe(true);
    expect(parseTestSelection(["standard"], "stress").tier).toBe("default");
    expect(() => parseTestSelection(["main", "--", "file.ts"])).toThrow("without a standalone");
    expect(() => parseTestSelection(["main", "--config=vitest.node.config.ts"])).toThrow(
      "owns its config",
    );
  });
  test("prepares the aggregate's native union once before any suite executes", async () => {
    const events: string[] = [];
    const exit = await runTests(parseTestSelection(["standard"]), {
      repositoryRoot: root,
      env: {},
      signal: new AbortController().signal,
      prepare: async (artifacts) => {
        expect(artifacts).toEqual(["core-server", "yjs-yrs-bridge", "cli"]);
        events.push("prepare");
        return { executables: { "core-server": "/tmp/core", "yjs-yrs-bridge": "/tmp/bridge" } };
      },
      execute: async (command) => {
        expect(command.env?.NODEX_CORE_EXECUTABLE).toBe("/tmp/core");
        events.push(command.args.at(-1) ?? "missing config");
        return result();
      },
    });
    expect(exit).toBe(0);
    expect(events).toEqual([
      "prepare",
      "vitest.node.config.ts",
      "vitest.effect-codex.config.ts",
      "vitest.core-client.config.ts",
      "vitest.main.config.ts",
      "vitest.renderer.config.ts",
      "vitest.integration.config.ts",
    ]);
  });
  test("prepares only bridge for an actually discovered bridge selection", async () => {
    await runTests(parseTestSelection(["core-client", YJS_YRS_TEST]), {
      repositoryRoot: root,
      env: {},
      signal: new AbortController().signal,
      discover: async () => [YJS_YRS_TEST],
      prepare: async (artifacts) => {
        expect(artifacts).toEqual(["yjs-yrs-bridge"]);
        return { executables: { "yjs-yrs-bridge": "/tmp/bridge" } };
      },
      execute: async () => result(),
    });
  });
  test("stops after a suite fails and preserves its exit code", async () => {
    let calls = 0;
    expect(
      await runTests(parseTestSelection(["standard"]), {
        repositoryRoot: root,
        env: {},
        signal: new AbortController().signal,
        prepare: async () => ({ executables: {} }),
        execute: async () => {
          calls++;
          return result(7);
        },
      }),
    ).toBe(7);
    expect(calls).toBe(1);
  });
  test("never starts tests when native preparation fails", async () => {
    await expect(
      runTests(parseTestSelection(["integration"]), {
        repositoryRoot: root,
        env: {},
        signal: new AbortController().signal,
        prepare: async () => {
          throw new Error("compiler failed");
        },
        execute: async () => {
          throw new Error("tests started too early");
        },
      }),
    ).rejects.toThrow("compiler failed");
  });
  test("cancellation stops the remaining suites", async () => {
    const controller = new AbortController();
    let calls = 0;
    expect(
      await runTests(parseTestSelection(["standard"]), {
        repositoryRoot: root,
        env: {},
        signal: controller.signal,
        prepare: async () => ({ executables: {} }),
        execute: async () => {
          calls++;
          controller.abort();
          return result();
        },
      }),
    ).toBe(130);
    expect(calls).toBe(1);
  });
});

test("a full Core stress tier does not prepare the default-only bridge", async () => {
  await runTests(parseTestSelection(["core-client"], "stress"), {
    repositoryRoot: root,
    env: {},
    signal: new AbortController().signal,
    discover: async (_suite, _args, _related, context) => {
      expect(context.env?.NODEX_TEST_TIER).toBe("stress");
      return ["src/main/core-client/database-context-menu-scenario.stress.node.test.ts"];
    },
    prepare: async (artifacts) => {
      expect(artifacts).toEqual(["core-server"]);
      return { executables: { "core-server": "/tmp/core" } };
    },
    execute: async () => result(),
  });
});
