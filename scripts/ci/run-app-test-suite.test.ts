import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES, STATIC_GROUPS, type CiGatePlan } from "./ci-gate-plan.ts";
import { commandForAppTestSuite, fileShard, linuxTestEnvironment } from "./run-app-test-suite.ts";

const plan = (overrides: Partial<CiGatePlan>): CiGatePlan => ({
  allGates: false,
  appTestSuites: APP_TEST_SUITES,
  dependencyKind: "source",
  docsOnly: false,
  draft: false,
  landingOnly: false,
  protocolContracts: false,
  relatedPaths: [],
  rustFast: false,
  rustFull: false,
  rustMigration: false,
  staticGroups: STATIC_GROUPS,
  testMode: "full",
  windowsChecks: false,
  ...overrides,
});

describe("application CI suite execution", () => {
  test("runs a canonical full suite without path arguments", () => {
    expect(commandForAppTestSuite("renderer", plan({}))).toEqual([
      process.platform === "win32" ? "vp.cmd" : "vp",
      "run",
      "test:renderer",
    ]);
  });

  test("passes changed paths after an argument boundary for related selection", () => {
    expect(
      commandForAppTestSuite(
        "browser",
        plan({
          relatedPaths: ["src/renderer/lib/example.ts", "src/shared/types.ts"],
          testMode: "related",
        }),
      ),
    ).toEqual([
      process.platform === "win32" ? "vp.cmd" : "vp",
      "run",
      "test:browser:related",
      "./src/renderer/lib/example.ts",
      "./src/shared/types.ts",
    ]);
  });

  test("shard assignment is path-based and covers both shards", () => {
    const files = [
      "src/renderer/alpha.test.tsx",
      "src/renderer/beta.test.tsx",
      "src/renderer/gamma.test.tsx",
    ];
    const shards = files.map((file) => fileShard(file, 2));
    expect(new Set(shards)).toEqual(new Set([0, 1]));
    expect(
      [...files, "src/renderer/new.test.tsx"]
        .map((file) => fileShard(file, 2))
        .slice(0, files.length),
    ).toEqual(shards);
  });

  test("Vitest receives runtime configuration without ephemeral CI metadata", () => {
    expect(
      linuxTestEnvironment({
        CI: "true",
        PATH: "/bin",
        DISPLAY: ":99",
        VP_CLI_BIN: "/bin/vp",
        NODEX_BUILD_CACHE_DIR: "/infrastructure-cache",
        GITHUB_SHA: "source",
        GITHUB_RUN_ID: "run",
        ACTIONS_RUNTIME_TOKEN: "credential",
      }),
    ).toEqual({ CI: "true", PATH: "/bin", DISPLAY: ":99", VP_CLI_BIN: "/bin/vp" });
  });

  test("rejects suites outside the classified plan", () => {
    expect(() => commandForAppTestSuite("main", plan({ appTestSuites: ["renderer"] }))).toThrow(
      "not selected",
    );
  });
});
