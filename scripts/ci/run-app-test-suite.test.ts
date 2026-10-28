import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES, STATIC_GROUPS, type CiGatePlan } from "./ci-gate-plan.ts";
import { commandForAppTestSuite, environmentForAppTestSuite } from "./run-app-test-suite.ts";

const plan = (overrides: Partial<CiGatePlan>): CiGatePlan => ({
  allGates: false,
  appTestSuites: APP_TEST_SUITES,
  dependencyKind: "source",
  docsOnly: false,
  landingOnly: false,
  protocolContracts: false,
  relatedPaths: [],
  releaseTransition: false,
  rustFast: false,
  rustFull: false,
  rustMigration: false,
  staticGroups: STATIC_GROUPS,
  testMode: "full",
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

  test("rejects suites outside the classified plan", () => {
    expect(() => commandForAppTestSuite("main", plan({ appTestSuites: ["renderer"] }))).toThrow(
      "not selected",
    );
  });

  test("reclaims isolated Linux browser realms without mutating the parent environment", () => {
    const environment = { CI: "true", CI_SOURCE_SHA: "source", TMPDIR: "/large-runner-tmp" };
    expect(environmentForAppTestSuite("browser", environment, "linux")).toEqual({
      ...environment,
      VITEST_CHROMIUM_GC_FORCE: "1",
    });
    expect(environment).not.toHaveProperty("VITEST_CHROMIUM_GC_FORCE");
  });

  test.each(APP_TEST_SUITES.filter((suite) => suite !== "browser"))(
    "preserves the environment for the %s suite",
    (suite) => {
      const environment = { CI: "true", NODE_OPTIONS: "--enable-source-maps" };
      expect(environmentForAppTestSuite(suite, environment, "linux")).toBe(environment);
    },
  );

  test.each(["darwin", "win32"] as const)("preserves the browser environment on %s", (platform) => {
    const environment = { CI: "true", TMPDIR: "/tmp" };
    expect(environmentForAppTestSuite("browser", environment, platform)).toBe(environment);
  });
});
