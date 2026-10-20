import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import type { DevelopmentEnvironmentHome } from "./development-environment-home";
import {
  createDevLaunchPlan,
  nativeCliExecutable,
  developmentStoreRejection,
  parseDevelopmentStoreCheck,
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
        "--claude-config-dir",
        "~/.claude-nodex-dev",
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
      allowMissingConversations: false,
      build: true,
      authJson: "/tmp/auth.json",
      agentConfigToml: "/tmp/config.toml",
      claudeConfigDir: "~/.claude-nodex-dev",
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
    expect(() => parseDevLauncherArguments(["--allow-missing-conversations"])).toThrow(
      "requires --from-profile",
    );
  });

  test("parses a real Profile snapshot source and disables remote observability", () => {
    const arguments_ = parseDevLauncherArguments([
      "--from-profile",
      "/tmp/live-profile",
      "--backup",
      "backup-1",
      "--allow-missing-conversations",
    ]);
    expect(arguments_).toMatchObject({
      fromProfile: "/tmp/live-profile",
      backup: "backup-1",
      allowMissingConversations: true,
    });
    const plan = createDevLaunchPlan({
      arguments: arguments_,
      environment: {},
      home: HOME,
      platform: "linux",
    });
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
      platform: "darwin",
      architecture: "arm64",
    });
    expect(plan.mode).toBe("hmr");
    expect(plan.preparation).toContainEqual({
      command: "pnpm",
      args: ["--silent", "run", "build:agent-runtime", "--development"],
    });
    expect(plan.preparation[0]).toEqual({
      command: "pnpm",
      args: ["--silent", "run", "electron:prepare"],
    });
    expect(plan.enabledFeatures).toEqual(["runtime-metrics"]);
    expect(plan.application).toEqual({
      command: "pnpm",
      args: [
        "exec",
        "electron-vite",
        "dev",
        "--logLevel",
        "warn",
        "--remoteDebuggingPort",
        "0",
        "--",
        "-ApplePersistenceIgnoreState",
        "YES",
      ],
    });
    expect(plan.environment).toMatchObject({
      NODEX_HOME: HOME.nodexHome,
      CODEX_HOME: HOME.codexHome,
      NODEX_INITIAL_PROJECTS_DIR: HOME.workspace,
      NODEX_DEV_ENABLED_FEATURES: "runtime-metrics",
    });
    expect(plan.environment.NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE).toBe(
      path.join(
        HOME.repositoryRealpath,
        ".generated/rust-dev-runtime/bin/nodex-browser-profile-helper",
      ),
    );
    expect(plan.environment.NODEX_CORE_EXECUTABLE).toBe(
      path.join(HOME.repositoryRealpath, ".generated/rust-dev-runtime/bin/nodex-core"),
    );
    expect(nativeCliExecutable(HOME, false, plan.environment)).toBe(
      path.join(HOME.repositoryRealpath, ".generated/rust-dev-runtime/bin/nodex"),
    );
  });

  test("enables developer overlays only for the requested invocation", () => {
    const optedIn = createDevLaunchPlan({
      arguments: parseDevLauncherArguments([
        "--enable",
        "agentation",
        "--enable",
        "query-devtools",
      ]),
      environment: {},
      home: HOME,
      platform: "linux",
    });
    expect(optedIn.enabledFeatures).toEqual(["agentation", "query-devtools"]);
    expect(optedIn.environment.NODEX_DEV_ENABLED_FEATURES).toBe("agentation,query-devtools");

    const ordinaryLaunch = createDevLaunchPlan({
      arguments: parseDevLauncherArguments([]),
      environment: optedIn.environment,
      home: HOME,
      platform: "linux",
    });
    expect(ordinaryLaunch.enabledFeatures).toEqual([]);
    expect(ordinaryLaunch.environment.NODEX_DEV_ENABLED_FEATURES).toBeUndefined();
  });

  test.each([{ CARGO_PROFILE_DEV_DEBUG: "full" }, { RUSTFLAGS: "-C opt-level=1" }])(
    "keeps custom native development builds on their Cargo executables: %j",
    (environment) => {
      const plan = createDevLaunchPlan({
        arguments: parseDevLauncherArguments([]),
        environment,
        home: HOME,
        platform: "darwin",
        architecture: "arm64",
      });
      expect(plan.environment.NODEX_CORE_EXECUTABLE).toBeUndefined();
      expect(plan.environment.NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE).toBeUndefined();
      expect(nativeCliExecutable(HOME, false, plan.environment)).toBe(
        path.join(HOME.repositoryRealpath, "target/debug/nodex"),
      );
    },
  );

  test("launches uncached binaries from a custom Cargo target directory", () => {
    const plan = createDevLaunchPlan({
      arguments: parseDevLauncherArguments([]),
      environment: {
        CARGO_TARGET_DIR: "/tmp/custom-target",
        NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: "/tmp/custom-helper",
      },
      home: HOME,
      platform: "darwin",
      architecture: "arm64",
    });
    expect(plan.environment.NODEX_CORE_EXECUTABLE).toBe("/tmp/custom-target/debug/nodex-core");
    expect(plan.environment.NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE).toBe("/tmp/custom-helper");
    expect(nativeCliExecutable(HOME, false, plan.environment)).toBe(
      "/tmp/custom-target/debug/nodex",
    );
  });

  test.each([
    { CARGO_PROFILE_DEV_DEBUG: "full", output: path.join(HOME.repositoryRealpath, "target/debug") },
    { CARGO_TARGET_DIR: "/tmp/custom-target", output: "/tmp/custom-target/debug" },
  ])(
    "reselects Cargo binaries when an inherited managed bundle is bypassed: %j",
    ({ output, ...custom }) => {
      const cachedPlan = createDevLaunchPlan({
        arguments: parseDevLauncherArguments([]),
        environment: {},
        home: HOME,
        platform: "darwin",
        architecture: "arm64",
      });
      const uncachedPlan = createDevLaunchPlan({
        arguments: parseDevLauncherArguments([]),
        environment: { ...cachedPlan.environment, ...custom },
        home: HOME,
        platform: "darwin",
        architecture: "arm64",
      });
      const usesDefaultOutput = output === path.join(HOME.repositoryRealpath, "target/debug");
      expect(uncachedPlan.environment.NODEX_CORE_EXECUTABLE).toBe(
        usesDefaultOutput ? undefined : path.join(output, "nodex-core"),
      );
      expect(uncachedPlan.environment.NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE).toBe(
        usesDefaultOutput ? undefined : path.join(output, "nodex-browser-profile-helper"),
      );
      expect(nativeCliExecutable(HOME, false, uncachedPlan.environment)).toBe(
        path.join(output, "nodex"),
      );
    },
  );

  test("keeps explicit native executable overrides when bypassing a managed bundle", () => {
    const plan = createDevLaunchPlan({
      arguments: parseDevLauncherArguments([]),
      environment: {
        CARGO_PROFILE_DEV_DEBUG: "full",
        NODEX_CORE_EXECUTABLE: "/tmp/explicit-core",
        NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: "/tmp/explicit-helper",
      },
      home: HOME,
      platform: "darwin",
      architecture: "arm64",
    });
    expect(plan.environment.NODEX_CORE_EXECUTABLE).toBe("/tmp/explicit-core");
    expect(plan.environment.NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE).toBe("/tmp/explicit-helper");
  });

  test("accepts the CDP alias and lets the command line override the environment", () => {
    const plan = createDevLaunchPlan({
      arguments: parseDevLauncherArguments(["--cdp", "9333"]),
      environment: { NODEX_REMOTE_DEBUGGING_PORT: "9444" },
      home: HOME,
      platform: "linux",
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
      platform: "darwin",
    });
    expect(plan.mode).toBe("built");
    expect(plan.preparation.map((command) => command.args.at(-1))).toEqual([
      "electron:prepare",
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
    expect(plan.application.args).toEqual([
      "exec",
      "electron",
      ".",
      "--remote-debugging-port=9333",
      "-ApplePersistenceIgnoreState",
      "YES",
    ]);
  });

  test.each(["linux", "win32"] as const)(
    "keeps native launch arguments unchanged on %s",
    (platform) => {
      const plan = (build: boolean) =>
        createDevLaunchPlan({
          arguments: parseDevLauncherArguments(build ? ["--build"] : []),
          environment: {},
          home: HOME,
          platform,
        });
      expect(plan(false).application.args).toEqual([
        "exec",
        "electron-vite",
        "dev",
        "--logLevel",
        "warn",
        "--remoteDebuggingPort",
        "0",
      ]);
      expect(plan(true).application.args).toEqual([
        "exec",
        "electron",
        ".",
        "--remote-debugging-port=0",
      ]);
    },
  );

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

  test("opens Stores this build can open and refuses one it cannot, with the way out", () => {
    const check = (result: unknown) =>
      parseDevelopmentStoreCheck(JSON.stringify({ ok: true, result, version: 1 }));
    for (const openable of [
      { status: "new", currentRevision: 185 },
      { status: "current", storeRevision: 185, currentRevision: 185 },
      { status: "upgradable", storeRevision: 183, currentRevision: 185 },
    ]) {
      expect(developmentStoreRejection(HOME.root, check(openable))).toBeNull();
    }

    const rejection = developmentStoreRejection(
      HOME.root,
      check({
        status: "incompatible",
        storeRevision: 178,
        currentRevision: 185,
        reason: "v178 physical schema fingerprint is a; expected b",
      }),
    );
    expect(rejection).toContain(
      "/tmp/nodex-dev holds a v178 Store this build cannot open: v178 physical schema fingerprint is a; expected b",
    );
    expect(rejection).toContain("Start a new --home, or rerun with --delete");

    expect(() => check({ status: "unknown", currentRevision: 185 })).toThrow(
      "Profile Store check result is invalid",
    );
    expect(() =>
      parseDevelopmentStoreCheck(JSON.stringify({ ok: false, error: { code: "INVALID_INPUT" } })),
    ).toThrow("Profile Store check result is invalid");
  });

  test("fails before launch for unknown feature slugs and invalid debug ports", () => {
    expect(() =>
      createDevLaunchPlan({
        arguments: parseDevLauncherArguments(["--enable", "missing"]),
        environment: {},
        home: HOME,
        platform: "linux",
      }),
    ).toThrow(/Unknown development feature missing\. Available features:/u);
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
        platform: "linux",
      }),
    ).toThrow("NODEX_REMOTE_DEBUGGING_PORT");
  });
});
