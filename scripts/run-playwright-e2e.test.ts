import { describe, expect, test } from "vitest";

import { resolveElectronE2eGrepInvert } from "../playwright.e2e.config";
import { NIGHTLY_E2E_SPECS, resolvePlaywrightE2eInvocation } from "./run-playwright-e2e";

describe("Playwright E2E runner arguments", () => {
  test("rejects an npm-style standalone separator before doing any work", () => {
    expect(() =>
      resolvePlaywrightE2eInvocation(["default", "--", "tests/e2e/page-files.spec.ts"]),
    ).toThrow(
      "Do not pass a standalone `--` to `vp run test:e2e`. Use: vp run test:e2e tests/e2e/<spec>.spec.ts",
    );
  });

  test("forwards focused files and real Playwright options", () => {
    expect(
      resolvePlaywrightE2eInvocation(["default", "tests/e2e/page-files.spec.ts", "--workers=1"]),
    ).toMatchObject({
      config: "playwright.e2e.config.ts",
      additionalArguments: ["tests/e2e/page-files.spec.ts", "--workers=1"],
    });
  });

  test("keeps performance policy in the shared runner", () => {
    expect(resolvePlaywrightE2eInvocation(["performance"])).toMatchObject({
      config: "playwright.e2e.config.ts",
      environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "1" },
      fixedArguments: ["--grep", expect.stringContaining("large-content surfaces")],
    });
  });

  test("runs the curated Nightly selection serially and overrides performance opt-ins", () => {
    expect(resolvePlaywrightE2eInvocation(["nightly"])).toEqual({
      scriptName: "test:e2e:nightly",
      config: "playwright.e2e.config.ts",
      fixedArguments: [...NIGHTLY_E2E_SPECS, "--workers=1"],
      additionalArguments: [],
      environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "0" },
    });
  });

  test("never admits paid Agent cases through an ordinary E2E mode", () => {
    expect(resolveElectronE2eGrepInvert(false).test("@paid-agent-file")).toBe(true);
    expect(resolveElectronE2eGrepInvert(true).test("@paid-agent-subagent")).toBe(true);
    expect(resolveElectronE2eGrepInvert(false).test("@performance")).toBe(true);
    expect(resolveElectronE2eGrepInvert(true).test("@performance")).toBe(false);
  });
});
