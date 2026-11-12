import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { parseTestSelection, runTests } from "./run-tests";
import {
  CODEX_SCALE_TEST,
  NATIVE_PIP_PROBE_TEST,
  YJS_YRS_TEST,
  type SuiteId,
} from "../../config/test-suites";
import type { Command } from "../tooling/process";

const result = (exitCode = 0) => ({ exitCode, signal: null, durationMs: 1 });
const root = path.resolve(".");

describe("test execution", () => {
  test("does not hand an ambient Agent shell binding to the test processes", async () => {
    const commands: Command[] = [];
    await runTests(parseTestSelection(["main", CODEX_SCALE_TEST]), {
      repositoryRoot: root,
      env: {
        NODEX_AGENT_SHELL: "1",
        NODEX_AGENT_ENDPOINT: "http://agent.invalid",
        NODEX_AGENT_CREDENTIAL: "secret",
        NODEX_CLI_TASK_ID: "task",
        NODEX_AGENT_PROFILE_HOME: "/profile",
      },
      signal: new AbortController().signal,
      prepare: async () => ({ executables: {} }),
      execute: async (command) => {
        commands.push(command);
        return result();
      },
    });
    const env = commands[0]?.env ?? {};
    expect(env.NODEX_AGENT_SHELL).toBeUndefined();
    expect(env.NODEX_AGENT_ENDPOINT).toBeUndefined();
    expect(env.NODEX_AGENT_CREDENTIAL).toBeUndefined();
    expect(env.NODEX_CLI_TASK_ID).toBeUndefined();
    expect(env.NODEX_AGENT_PROFILE_HOME).toBeUndefined();
  });

  test("prepares Electron before focused discovery resolves its runtime", async () => {
    const events: string[] = [];
    await runTests(parseTestSelection(["main", CODEX_SCALE_TEST]), {
      repositoryRoot: root,
      env: {},
      signal: new AbortController().signal,
      prepareElectron: async () => {
        events.push("electron");
        return "/tmp/electron";
      },
      discover: async () => {
        events.push("discover");
        return [CODEX_SCALE_TEST];
      },
      prepare: async () => ({ executables: {} }),
      execute: async () => {
        events.push("test");
        return result();
      },
    });
    expect(events).toEqual(["electron", "discover", "test"]);
  });
  test("forwards focused paths and Vitest flags without shell parsing", () => {
    const args = ["src/main/path with spaces.node.test.ts", "-t", "literal $value"];
    expect(parseTestSelection(["core-client", ...args], "default")).toMatchObject({
      suites: ["core-client"],
      related: false,
      args,
    });
    expect(parseTestSelection(["core-client", "--related", ...args], "default").related).toBe(true);
    expect(parseTestSelection(["standard"], "stress").tier).toBe("default");
    expect(parseTestSelection(["live"], "default")).toEqual({
      suites: ["agent-runtime"],
      tier: "live",
      related: false,
      args: [],
    });
    expect(() => parseTestSelection(["main", "--", "file.ts"])).toThrow("without a standalone");
    expect(() => parseTestSelection(["main", "--config=config/vitest.node.config.ts"])).toThrow(
      "owns its config",
    );
  });
  test("prepares the aggregate's native union once before any suite executes", async () => {
    const events: string[] = [];
    const exit = await runTests(parseTestSelection(["standard"]), {
      repositoryRoot: root,
      prepareElectron: async () => "/tmp/electron",
      env: {},
      signal: new AbortController().signal,
      prepare: async (artifacts) => {
        expect(artifacts).toEqual([
          ...(process.platform === "darwin" ? ["agent-runtime"] : []),
          ...(process.platform === "win32" ? ["windows-maintenance"] : []),
          "core-server",
          "yjs-yrs-bridge",
          "cli",
        ]);
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
      "config/vitest.node.config.ts",
      "config/vitest.effect-codex.config.ts",
      "packages/agent-runtime/vite.config.ts",
      "config/vitest.core-client.config.ts",
      "config/vitest.main.config.ts",
      "config/vitest.renderer.config.ts",
      "config/vitest.integration.config.ts",
    ]);
  });
  test("prepares only bridge for an actually discovered bridge selection", async () => {
    await runTests(parseTestSelection(["core-client", YJS_YRS_TEST]), {
      repositoryRoot: root,
      prepareElectron: async () => "/tmp/electron",
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
  test.skipIf(process.platform !== "darwin").each([false, true])(
    "prepares a focused production addon before execution (related: %s)",
    async (related) => {
      const events: string[] = [];
      await runTests(
        parseTestSelection(["unit", ...(related ? ["--related"] : []), NATIVE_PIP_PROBE_TEST]),
        {
          repositoryRoot: root,
          env: {},
          signal: new AbortController().signal,
          discover: async () => {
            events.push("discover");
            return [NATIVE_PIP_PROBE_TEST];
          },
          prepare: async (artifacts) => {
            expect(artifacts).toEqual(["agent-runtime"]);
            events.push("prepare");
            return { executables: {} };
          },
          execute: async () => {
            events.push("test");
            return result();
          },
        },
      );
      expect(events).toEqual(["discover", "prepare", "test"]);
    },
  );
  test.skipIf(process.platform !== "darwin").each(["default", "stress"] as const)(
    "does not stage the Agent runtime for unrelated %s unit tests",
    async (tier) => {
      await runTests(parseTestSelection(["unit", "scripts/testing/run-tests.test.ts"], tier), {
        repositoryRoot: root,
        env: {},
        signal: new AbortController().signal,
        discover: async () => ["scripts/testing/run-tests.test.ts"],
        prepare: async (artifacts) => {
          expect(artifacts).toEqual([]);
          return { executables: {} };
        },
        execute: async () => result(),
      });
    },
  );
  test("stops after a suite fails and preserves its exit code", async () => {
    let calls = 0;
    expect(
      await runTests(parseTestSelection(["standard"]), {
        repositoryRoot: root,
        prepareElectron: async () => "/tmp/electron",
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
        prepareElectron: async () => "/tmp/electron",
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
        prepareElectron: async () => "/tmp/electron",
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
    prepareElectron: async () => "/tmp/electron",
    env: {},
    signal: new AbortController().signal,
    discover: async (_suite, _args, _related, context) => {
      expect(context.env?.NODEX_TEST_TIER).toBe("stress");
      return ["src/main/core-client/database-context-menu-scenario.stress.node.test.ts"];
    },
    prepare: async (artifacts, context) => {
      expect(artifacts).toEqual(["core-server"]);
      expect(context.profile).toBe("release");
      return { executables: { "core-server": "/tmp/core" } };
    },
    execute: async () => result(),
  });
});

test("declares the locked Agent runtime for a discovered real-history pressure gate", async () => {
  const events: string[] = [];
  const exit = await runTests(parseTestSelection(["main", CODEX_SCALE_TEST], "stress"), {
    repositoryRoot: root,
    prepareElectron: async () => "/tmp/electron",
    env: {},
    signal: new AbortController().signal,
    discover: async () => [CODEX_SCALE_TEST],
    prepare: async (artifacts) => {
      expect(artifacts).toEqual(["core-server", "agent-runtime"]);
      events.push("native");
      return { executables: {} };
    },
    execute: async (command) => {
      expect(command.args.at(-1)).toBe("config/vitest.main.config.ts");
      events.push("test");
      return result();
    },
  });
  expect(exit).toBe(0);
  expect(events).toEqual(["native", "test"]);
});

describe("Browser process environment", () => {
  test.each([
    { name: "full", args: ["browser"], tier: "default" },
    {
      name: "focused",
      args: ["browser", "src/renderer/example.browser.test.tsx"],
      tier: "default",
    },
    {
      name: "related",
      args: ["browser", "--related", "src/renderer/example.tsx"],
      tier: "default",
    },
    { name: "stress", args: ["browser"], tier: "stress" },
  ] as const)(
    "retires isolated realms in the $name runner before Vitest starts",
    async ({ args, tier }) => {
      const environment = {
        TMPDIR: "/task temporary directory",
        NODE_OPTIONS: "--enable-source-maps",
        VITEST_CHROMIUM_GC_FORCE: "0",
      };
      let command: Command | undefined;
      const exit = await runTests(parseTestSelection(args, tier), {
        repositoryRoot: root,
        env: environment,
        signal: new AbortController().signal,
        prepare: async () => ({ executables: {} }),
        execute: async (selected) => {
          command = selected;
          return result();
        },
      });
      expect(exit).toBe(0);
      expect(command?.command).toBe(process.execPath);
      expect(command?.args.at(-1)).toBe("config/vitest.browser.config.ts");
      expect(command?.env).toEqual({
        ...environment,
        NODEX_TEST_TIER: tier,
        VITEST_CHROMIUM_GC_FORCE: "1",
        NODE_ENV: "test",
      });
      expect(environment.VITEST_CHROMIUM_GC_FORCE).toBe("0");
    },
  );

  test.each(["unit", "main"] satisfies SuiteId[])(
    "preserves inherited environment values for the %s runtime",
    async (suite) => {
      const environment = {
        TMPDIR: "/task temporary directory",
        NODE_OPTIONS: "--enable-source-maps",
        VITEST_CHROMIUM_GC_FORCE: "0",
      };
      let command: Command | undefined;
      await runTests(parseTestSelection([suite]), {
        repositoryRoot: root,
        env: environment,
        signal: new AbortController().signal,
        prepareElectron: async () => "/task/electron",
        prepare: async () => ({ executables: {} }),
        execute: async (selected) => {
          command = selected;
          return result();
        },
      });
      expect(command?.env).toEqual({
        ...environment,
        NODEX_TEST_TIER: "default",
        ...(suite === "main" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        NODE_ENV: "test",
      });
      expect(environment.VITEST_CHROMIUM_GC_FORCE).toBe("0");
    },
  );
});
