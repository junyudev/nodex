import { describe, expect, test } from "vitest";

import { resolveElectronE2eGrepInvert } from "../config/playwright.e2e.config";
import { resolvePlaywrightE2eInvocation } from "./run-playwright-e2e";

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
      config: "config/playwright.e2e.config.ts",
      additionalArguments: ["tests/e2e/page-files.spec.ts", "--workers=1"],
    });
  });

  test("keeps performance policy in the shared runner", () => {
    expect(resolvePlaywrightE2eInvocation(["performance"])).toMatchObject({
      config: "config/playwright.e2e.config.ts",
      environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "1" },
      fixedArguments: ["--grep", expect.stringContaining("large-content surfaces")],
      exclusive: true,
    });
  });

  test("runs the curated Nightly selection serially and overrides performance opt-ins", () => {
    const invocation = resolvePlaywrightE2eInvocation(["nightly"]);
    expect(invocation).toEqual({
      scriptName: "test:e2e:nightly",
      config: "config/playwright.e2e.config.ts",
      fixedArguments: ["--grep", expect.any(String), "--workers=1"],
      additionalArguments: [],
      environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "0" },
      exclusive: false,
    });
  });

  test("matches the automatic tag as a whole token", () => {
    const [, grep] = resolvePlaywrightE2eInvocation(["nightly"]).fixedArguments;
    const filter = new RegExp(grep!, "u");
    expect(filter.test("file.spec.ts case @automatic @another")).toBe(true);
    expect(filter.test("file.spec.ts case @automatic-preview")).toBe(false);
    expect(filter.test("file.spec.ts another case in the same file")).toBe(false);
  });

  test("never admits paid Agent cases through an ordinary E2E mode", () => {
    expect(resolveElectronE2eGrepInvert(false).test("@paid-agent-file")).toBe(true);
    expect(resolveElectronE2eGrepInvert(true).test("@paid-agent-subagent")).toBe(true);
    expect(resolveElectronE2eGrepInvert(false).test("@performance")).toBe(true);
    expect(resolveElectronE2eGrepInvert(true).test("@performance")).toBe(false);
  });
});
