import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import type { DevelopmentEnvironmentHome } from "./development-environment-home";
import {
  createDevLaunchPlan,
  parseDevLauncherArguments,
  resolveDevelopmentSeedInitialization,
} from "./dev-launcher";

const HOME: DevelopmentEnvironmentHome = {
  root: "/tmp/nodex-dev",
  nodexHome: "/tmp/nodex-dev/.nodex",
  codexHome: "/tmp/nodex-dev/.nodex/agent",
  workspace: "/tmp/nodex-dev/workspace",
  artifacts: "/tmp/nodex-dev/artifacts",
  manifestPath: "/tmp/nodex-dev/dev-home.json",
  repositoryRealpath: path.resolve("."),
  wasCreated: true,
  manifest: {
    version: 1,
    environmentId: "11111111-1111-4111-8111-111111111111",
    repositoryRealpath: path.resolve("."),
    createdAt: "2026-08-16T00:00:00.000Z",
  },
};

describe("dev launcher", () => {
  test("parses the public command contract without requiring a separator", () => {
    expect(
      parseDevLauncherArguments([
        "--home",
        "runs.local/perf",
        "--seed",
        "board/dense",
        "--build",
        "--auth-json",
        "/tmp/auth.json",
        "--agent-config-toml",
        "/tmp/config.toml",
        "--remote-debugging-port",
        "9229",
        "--enable",
        "runtime-metrics",
        "--enable",
        "runtime-metrics",
        "--delete",
      ]),
    ).toEqual({
      home: "runs.local/perf",
      seed: "board/dense",
      backup: "latest",
      build: true,
      authJson: "/tmp/auth.json",
      agentConfigToml: "/tmp/config.toml",
      remoteDebuggingPort: "9229",
      enabledFeatures: ["runtime-metrics", "runtime-metrics"],
      deleteHome: true,
      help: false,
    });
  });

  test("rejects missing values and unknown options", () => {
    expect(() => parseDevLauncherArguments(["--home"])).toThrow("--home requires a value");
    expect(() => parseDevLauncherArguments(["--resume", "old-session"])).toThrow(
      "Unknown dev option",
    );
    expect(() =>
      parseDevLauncherArguments(["--seed", "board/dense", "--from-profile", "/tmp/live"]),
    ).toThrow("mutually exclusive");
    expect(() => parseDevLauncherArguments(["--backup", "backup-1"])).toThrow(
      "requires --from-profile",
    );
  });

  test("parses a real Profile snapshot source and disables remote observability", () => {
    const arguments_ = parseDevLauncherArguments([
      "--from-profile",
      "/tmp/live-profile",
      "--backup",
      "backup-1",
    ]);
    expect(arguments_).toMatchObject({
      fromProfile: "/tmp/live-profile",
      backup: "backup-1",
    });
    const plan = createDevLaunchPlan({ arguments: arguments_, environment: {}, home: HOME });
    expect(plan.environment).toMatchObject({
      NODEX_SENTRY_ENABLED: "false",
      NODEX_SENTRY_REPLAY_ENABLED: "false",
      NODEX_TELEMETRY_ENABLED: "false",
    });
  });

  test("selects HMR by default and applies one invocation feature override", () => {
    const parsed = parseDevLauncherArguments([
      "--enable",
      "runtime-metrics",
      "--enable",
      "runtime-metrics",
    ]);
    const plan = createDevLaunchPlan({
      arguments: parsed,
      environment: {},
      home: HOME,
    });
    expect(plan.mode).toBe("hmr");
    expect(plan.enabledFeatures).toEqual(["runtime-metrics"]);
    expect(plan.application).toEqual({
      command: "pnpm",
      args: ["exec", "electron-vite", "dev", "--logLevel", "warn", "--remoteDebuggingPort", "0"],
    });
    expect(plan.environment).toMatchObject({
      NODEX_HOME: HOME.nodexHome,
      CODEX_HOME: HOME.codexHome,
      NODEX_INITIAL_PROJECTS_DIR: HOME.workspace,
      NODEX_DEV_ENABLED_FEATURES: "runtime-metrics",
    });
    expect(plan.environment.NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE).toBeUndefined();
    expect(plan.environment.NODEX_CORE_EXECUTABLE).toBeUndefined();
  });

  test("accepts the CDP alias and lets the command line override the environment", () => {
    const plan = createDevLaunchPlan({
      arguments: parseDevLauncherArguments(["--cdp", "9333"]),
      environment: { NODEX_REMOTE_DEBUGGING_PORT: "9444" },
      home: HOME,
    });
    expect(plan.application.args).toEqual([
      "exec",
      "electron-vite",
      "dev",
      "--logLevel",
      "warn",
      "--remoteDebuggingPort",
      "9333",
    ]);
    expect(plan.environment.NODEX_REMOTE_DEBUGGING_PORT).toBe("9333");
  });

  test("selects a build-first built application plan", () => {
    const plan = createDevLaunchPlan({
      arguments: parseDevLauncherArguments(["--build"]),
      environment: { NODEX_REMOTE_DEBUGGING_PORT: "9333" },
      home: HOME,
    });
    expect(plan.mode).toBe("built");
    expect(plan.preparation.map((command) => command.args.at(-1))).toEqual([
      "core:binaries:build:release",
      "build",
      "stage:codex-runtime:mac:cached",
    ]);
    expect(plan.environment).toMatchObject({
      NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: path.join(
        HOME.repositoryRealpath,
        "target/release/nodex-browser-profile-helper",
      ),
      NODEX_CORE_EXECUTABLE: path.join(HOME.repositoryRealpath, "target/release/nodex-core"),
    });
    expect(plan.application.args).toContain("--remote-debugging-port=9333");
  });

  test("applies a seed once, reuses matching provenance, and rejects drift", () => {
    const requestedSeed = { id: "board/dense", revision: 2 } as const;
    expect(
      resolveDevelopmentSeedInitialization({
        manifest: HOME.manifest,
        requestedSeed,
      }),
    ).toEqual({ kind: "apply", seed: requestedSeed });
    expect(
      resolveDevelopmentSeedInitialization({
        manifest: {
          ...HOME.manifest,
          initializedAt: "2026-08-17T00:00:00.000Z",
          seed: requestedSeed,
        },
        requestedSeed,
      }),
    ).toEqual({ kind: "reuse", seed: requestedSeed });
    expect(() =>
      resolveDevelopmentSeedInitialization({
        manifest: {
          ...HOME.manifest,
          initializedAt: "2026-08-17T00:00:00.000Z",
          seed: requestedSeed,
        },
        requestedSeed: { id: "board/dense", revision: 3 },
      }),
    ).toThrow(/refusing board\/dense@3/u);
    expect(() =>
      resolveDevelopmentSeedInitialization({
        manifest: {
          ...HOME.manifest,
          initializedAt: "2026-08-17T00:00:00.000Z",
        },
        requestedSeed,
      }),
    ).toThrow("already initialized without a seed");
  });

  test("fails before launch for unknown feature slugs and invalid debug ports", () => {
    expect(() =>
      createDevLaunchPlan({
        arguments: parseDevLauncherArguments(["--enable", "missing"]),
        environment: {},
        home: HOME,
      }),
    ).toThrow(/Available features: database-page-reorder-menu, runtime-metrics/u);
    expect(() => parseDevLauncherArguments(["--remote-debugging-port", "70000"])).toThrow(
      "--remote-debugging-port",
    );
    expect(() => parseDevLauncherArguments(["--cdp", "9229", "--cdp", "9333"])).toThrow(
      "may be specified only once",
    );
    expect(() =>
      createDevLaunchPlan({
        arguments: parseDevLauncherArguments([]),
        environment: { NODEX_REMOTE_DEBUGGING_PORT: "70000" },
        home: HOME,
      }),
    ).toThrow("NODEX_REMOTE_DEBUGGING_PORT");
  });
});
