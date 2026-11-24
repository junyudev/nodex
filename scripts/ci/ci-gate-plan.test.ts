import { describe, expect, test } from "vite-plus/test";

import {
  APP_TEST_SUITES,
  appShardCount,
  assertCiGatePlan,
  cachedAppLanes,
  parseCachedAppLaneIds,
  requiredJobIdsForGatePlan,
  STATIC_GROUPS,
  type CiGatePlan,
} from "./ci-gate-plan";

const fullPlan: CiGatePlan = {
  allGates: true,
  appTestSuites: APP_TEST_SUITES,
  dependencyKind: "source",
  docsOnly: false,
  draft: false,
  landingOnly: false,
  protocolContracts: true,
  relatedPaths: [],
  rustFast: true,
  rustFull: true,
  rustMigration: true,
  staticGroups: STATIC_GROUPS,
  testMode: "full",
  windowsChecks: true,
};

describe("CI gate plan contract", () => {
  test("derives every required workflow job from the full plan", () => {
    expect(requiredJobIdsForGatePlan(fullPlan)).toEqual([
      "static-contracts",
      "app-tests",
      "rust-checks",
      "windows-checks",
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

  test("rejects a reduced draft plan with any heavy gate", () => {
    expect(() => assertCiGatePlan({ ...fullPlan, draft: true })).toThrow(
      "Draft plans may select only cheap static contracts",
    );
  });

  test("covers each shard exactly once without adding jobs to any plan", () => {
    const expected = APP_TEST_SUITES.flatMap((suite) =>
      Array.from({ length: appShardCount(suite) }, (_, shard) => ({ suite, shard })),
    );
    // Exercise every subset because grouping only occurs if the selected shards use the available slots.
    for (let mask = 0; mask < 2 ** APP_TEST_SUITES.length; mask++) {
      const plan = {
        ...fullPlan,
        appTestSuites: APP_TEST_SUITES.filter((_, index) => mask & (1 << index)),
      };
      const lanes = cachedAppLanes(plan);
      expect(lanes.size).toBe(plan.appTestSuites.length);
      expect([...lanes.values()].flat()).toHaveLength(
        expected.filter(({ suite }) => plan.appTestSuites.includes(suite)).length,
      );
      expect([...lanes.values()].flat()).toEqual(
        expect.arrayContaining(expected.filter(({ suite }) => plan.appTestSuites.includes(suite))),
      );
      expect([...lanes.values()].every((lane) => lane.length > 0 && lane.length <= 2)).toBe(true);
    }
    expect(cachedAppLanes(fullPlan).size).toBe(8);
  });

  test("rejects an incomplete or repeated app matrix", () => {
    const actual = [...cachedAppLanes(fullPlan).keys()];
    expect(parseCachedAppLaneIds(actual, fullPlan)).toEqual(actual);
    expect(() => parseCachedAppLaneIds(actual.slice(1), fullPlan)).toThrow(
      "every selected suite and shard",
    );
    expect(() => parseCachedAppLaneIds([...actual.slice(1), actual[1]], fullPlan)).toThrow(
      "every selected suite and shard",
    );
  });
});
