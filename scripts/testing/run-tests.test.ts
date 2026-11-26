import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { parseTestSelection, runTests } from "./run-tests";
import {
  CODEX_SCALE_TEST,
  filesForSuite,
  NATIVE_PIP_PROBE_TEST,
  YJS_YRS_TEST,
  type SuiteId,
} from "../../config/test-suites";
import type { Command } from "../tooling/process";
import { discoverSuite } from "./runtime.ts";

const result = (exitCode = 0) => ({ exitCode, signal: null, durationMs: 1 });
const root = path.resolve(".");

describe("test execution", () => {
  test("isolates test processes from the launcher's Agent shell", async () => {
    const commands: Command[] = [];
    await runTests(parseTestSelection(["main", CODEX_SCALE_TEST], "default"), {
      repositoryRoot: root,
      env: {
        NODEX_AGENT_SHELL: "1",
        NODEX_AGENT_ENDPOINT: "http://agent.invalid",
        NODEX_AGENT_CREDENTIAL: "secret",
        NODEX_CLI_TASK_ID: "task",
        NODEX_AGENT_PROFILE_HOME: "/profile",
        CODEX_TOOL_CALL_ID: "call",
        SHLVL: "3",
        NODE_EXTRA_CA_CERTS: "/certs.pem",
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
    expect(env.CODEX_TOOL_CALL_ID).toBeUndefined();
    expect(env.SHLVL).toBe("1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/certs.pem");
  });

  test("prepares Electron before focused discovery resolves its runtime", async () => {
    const events: string[] = [];
    await runTests(parseTestSelection(["main", CODEX_SCALE_TEST], "default"), {
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
    expect(parseTestSelection(["core-client", "--related", ...args], "default")).toMatchObject({
      related: true,
      tier: "related",
    });
    expect(parseTestSelection(["standard"], "stress").tier).toBe("default");
    expect(parseTestSelection(["nightly"], "default")).toMatchObject({
      tier: "nightly",
      suites: expect.arrayContaining([
        "unit",
        "core-client",
        "main",
        "renderer",
        "integration",
        "browser",
      ]),
    });
    expect(parseTestSelection(["live"], "default")).toEqual({
      suites: ["agent-runtime"],
      tier: "live",
      related: false,
      args: [],
    });
    expect(() => parseTestSelection(["main", "--", "file.ts"], "default")).toThrow(
      "without a standalone",
    );
    expect(() =>
      parseTestSelection(["main", "--config=config/vitest.node.config.ts"], "default"),
    ).toThrow("owns its config");
  });
  test("prepares the aggregate's native union once before any suite executes", async () => {
    const events: string[] = [];
    const exit = await runTests(parseTestSelection(["standard"], "default"), {
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
    await runTests(parseTestSelection(["core-client", YJS_YRS_TEST], "default"), {
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
        parseTestSelection(
          ["unit", ...(related ? ["--related"] : []), NATIVE_PIP_PROBE_TEST],
          "default",
        ),
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
      await runTests(parseTestSelection(["standard"], "default"), {
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
      runTests(parseTestSelection(["integration"], "default"), {
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
      await runTests(parseTestSelection(["standard"], "default"), {
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

test.each([
  ["stress", "release"],
  ["nightly", "dev"],
] as const)(
  "the Core %s tier prepares only selected artifacts with the %s profile",
  async (tier, profile) => {
    await runTests(parseTestSelection(["core-client"], tier), {
      repositoryRoot: root,
      prepareElectron: async () => "/tmp/electron",
      env: {},
      signal: new AbortController().signal,
      discover: async (_suite, _args, _related, context) => {
        expect(context.env?.NODEX_TEST_TIER).toBe(tier);
        return [`src/main/core-client/database-context-menu-scenario.${tier}.node.test.ts`];
      },
      prepare: async (artifacts, context) => {
        expect(artifacts).toEqual(["core-server"]);
        expect(context.profile).toBe(profile);
        return { executables: { "core-server": "/tmp/core" } };
      },
      execute: async () => result(),
    });
  },
);

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

test("uses sibling nightly selection alongside the default graph or cached CI collection", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "nodex-related-tests-")));
  const project = "src/main";
  const source = project + "/fixture";
  const changed = source + "/changed.ts";
  const relatedDefault = source + "/related.node.test.ts";
  const relatedNightly = source + "/changed.nightly.node.test.ts";
  const crossCutting = source + "/deep.nightly.node.test.ts";
  const unrelatedDefault = source + "/unrelated.node.test.ts";
  const unrelatedNightly = source + "/unrelated.nightly.node.test.ts";
  const stress = source + "/changed.stress.node.test.ts";
  try {
    await Promise.all([
      mkdir(path.join(cwd, source), { recursive: true }),
      mkdir(path.join(cwd, "config")),
    ]);
    const files = {
      [changed]: "export const value = 1;",
      [relatedDefault]: "import './changed.ts';",
      [relatedNightly]: "",
      [crossCutting]: "import './related.node.test.ts';",
      [unrelatedDefault]: "",
      [unrelatedNightly]: "",
      [stress]: "import './changed.ts';",
    };
    await Promise.all(
      Object.entries(files).map(([file, content]) => writeFile(path.join(cwd, file), content)),
    );
    const signal = new AbortController().signal;
    const root = path.join(cwd, project);
    const config = path.join(cwd, "config/vitest.core-client.config.ts");
    const discover = async (
      scope: "default" | "related" | "nightly",
      mode: Parameters<typeof discoverSuite>[2],
      args: readonly string[],
    ) => {
      const globs = Object.fromEntries(
        (["default", "related", "nightly"] as const).map((tier) => {
          const { include, exclude } = filesForSuite("core-client", tier);
          return [
            tier,
            { include: include.map((glob) => glob.replace(project + "/", "")), exclude },
          ];
        }),
      );
      await writeFile(
        config,
        "const suites = " +
          JSON.stringify(globs) +
          "\n" +
          "export default { root: " +
          JSON.stringify(root) +
          ", test: suites[process.env.NODEX_TEST_TIER] };",
      );
      return discoverSuite("core-client", args, mode, {
        cwd,
        signal,
        env: { ...process.env, NODEX_TEST_TIER: scope },
      });
    };
    expect(await discover("related", "related", ["./" + changed])).toEqual([
      relatedNightly,
      relatedDefault,
    ]);
    expect(await discover("related", "related", ["./" + unrelatedNightly])).toEqual([
      unrelatedNightly,
    ]);
    expect(await discover("related", "default-with-related-nightly", ["./" + changed])).toEqual([
      relatedNightly,
      relatedDefault,
      unrelatedDefault,
    ]);
    expect(await discover("default", "run", [])).toEqual([relatedDefault, unrelatedDefault]);
    expect(await discover("nightly", "run", [])).toEqual([
      relatedNightly,
      crossCutting,
      unrelatedNightly,
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
      expectedTier: "related",
    },
    { name: "stress", args: ["browser"], tier: "stress" },
  ] as const)(
    "retires isolated realms in the $name runner before Vitest starts",
    async (fixture) => {
      const { args, tier } = fixture;
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
        discover: async () => ["src/renderer/example.browser.test.tsx"],
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
        SHLVL: "1",
        NODEX_TEST_TIER: "expectedTier" in fixture ? fixture.expectedTier : tier,
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
      await runTests(parseTestSelection([suite], "default"), {
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
        SHLVL: "1",
        NODEX_TEST_TIER: "default",
        ...(suite === "main" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        NODE_ENV: "test",
      });
      expect(environment.VITEST_CHROMIUM_GC_FORCE).toBe("0");
    },
  );
});
