import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES } from "./ci-gate-plan";
import { parseAppTestSuite, planAppTestSuite } from "./app-test-suite";

describe("application CI suite planning", () => {
  test("maps every suite to one canonical package script", () => {
    expect(APP_TEST_SUITES.map((suite) => [suite, planAppTestSuite(suite)])).toEqual([
      [
        "unit",
        {
          needsPlaywright: false,
          needsRust: false,
          needsXvfb: false,
          packageScript: "test:unit",
          relatedPackageScript: "test:unit:related",
        },
      ],
      [
        "effect-codex",
        {
          needsPlaywright: false,
          needsRust: false,
          needsXvfb: false,
          packageScript: "test:effect-codex",
          relatedPackageScript: "test:effect-codex:related",
        },
      ],
      [
        "core-client",
        {
          needsPlaywright: false,
          needsRust: true,
          needsXvfb: false,
          packageScript: "test:core-client",
          relatedPackageScript: "test:core-client:related",
        },
      ],
      [
        "main",
        {
          needsPlaywright: false,
          needsRust: true,
          needsXvfb: true,
          packageScript: "test:main",
          relatedPackageScript: "test:main:related",
        },
      ],
      [
        "renderer",
        {
          needsPlaywright: false,
          needsRust: false,
          needsXvfb: false,
          packageScript: "test:renderer",
          relatedPackageScript: "test:renderer:related",
        },
      ],
      [
        "integration",
        {
          needsPlaywright: false,
          needsRust: true,
          needsXvfb: true,
          packageScript: "test:integration",
          relatedPackageScript: "test:integration:related",
        },
      ],
      [
        "browser",
        {
          needsPlaywright: true,
          needsRust: false,
          needsXvfb: false,
          packageScript: "test:browser",
          relatedPackageScript: "test:browser:related",
        },
      ],
    ]);
  });

  test("rejects unknown matrix values", () => {
    expect(() => parseAppTestSuite("surprise")).toThrow("Unknown application test suite");
  });
});
