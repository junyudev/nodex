import { describe, expect, test } from "vite-plus/test";

import {
  APP_TEST_SUITES,
  assertCiGatePlan,
  requiredJobIdsForGatePlan,
  STATIC_GROUPS,
  type CiGatePlan,
} from "./ci-gate-plan";

const fullPlan: CiGatePlan = {
  allGates: true,
  appTestSuites: APP_TEST_SUITES,
  dependencyKind: "source",
  docsOnly: false,
  landingOnly: false,
  protocolContracts: true,
  relatedPaths: [],
  rustFast: true,
  rustFull: true,
  rustMigration: true,
  staticGroups: STATIC_GROUPS,
  testMode: "full",
};

describe("CI gate plan contract", () => {
  test("derives every required workflow job from the full plan", () => {
    expect(requiredJobIdsForGatePlan(fullPlan)).toEqual([
      "static-contracts",
      "app-tests",
      "rust-checks",
    ]);
  });

  test("rejects unknown fields and inconsistent test selections", () => {
    expect(() => assertCiGatePlan({ ...fullPlan, surprise: true })).toThrow("unknown fields");
    expect(() => assertCiGatePlan({ ...fullPlan, testMode: "related" })).toThrow("changed paths");
    expect(() => assertCiGatePlan({ ...fullPlan, relatedPaths: ["../outside"] })).toThrow("safe");
    expect(() => assertCiGatePlan({ ...fullPlan, relatedPaths: ["src/main/a\rb.ts"] })).toThrow(
      "safe",
    );
  });

  test("keeps release transition isolated from ordinary jobs", () => {});
});
