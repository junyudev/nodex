import { describe, expect, test } from "vite-plus/test";
import {
  filesForSuite,
  nativeRequirements,
  NODEX_CLI_BOOTSTRAP_TEST,
  ownersOfTest,
  STRESS_TEST_SUITES,
  YJS_YRS_TEST,
} from "./test-suites";

describe("application test ownership", () => {
  test.each([
    ["src/main/new-application/behavior.node.test.ts", "core-client", "default"],
    ["src/main/new-application/behavior.test.ts", "main", "default"],
    ["src/main/core-client/behavior.stress.node.test.ts", "core-client", "stress"],
    ["src/main/core-client/behavior.stress.test.ts", "main", "stress"],
    ["src/main/behavior.integration.ts", "integration", "default"],
    ["src/main/behavior.stress.integration.ts", "integration", "stress"],
    ["src/renderer/behavior.node.test.tsx", "unit", "default"],
    ["src/renderer/behavior.test.tsx", "renderer", "default"],
    ["src/renderer/behavior.test.ts", "unit", "default"],
    ["src/renderer/behavior.jsdom.test.ts", "renderer", "default"],
    ["src/renderer/behavior.stress.node.test.tsx", "unit", "stress"],
    ["src/renderer/behavior.stress.test.ts", "renderer", "stress"],
    ["src/renderer/behavior.stress.browser.test.tsx", "browser", "stress"],
    ["src/renderer/behavior.browser.test.tsx", "browser", "default"],
    ["packages/landing/src/download-cta.jsdom.test.ts", "renderer", "default"],
    ["packages/effect-codex-app-server/src/client.test.ts", "effect-codex", "default"],
    [YJS_YRS_TEST, "core-client", "default"],
  ])("assigns %s to one runtime and tier", (file, suite, tier) => {
    expect(ownersOfTest(file)).toEqual([{ suite, tier }]);
  });

  test("keeps unowned and upstream-only tests visible as outside the application contract", () => {
    expect(ownersOfTest("packages/new-package/src/missing.test.ts")).toEqual([]);
    expect(ownersOfTest("third_party/blocknote/packages/core/src/upstream.test.ts")).toEqual([]);
    expect(ownersOfTest("scripts/fixtures/tooling/invalid.test.ts")).toEqual([]);
  });

  test("distinguishes full, empty and bridge-only native preparation", () => {
    expect(nativeRequirements("unit")).toEqual([]);
    expect(nativeRequirements("core-client")).toEqual(["core-server", "yjs-yrs-bridge", "cli"]);
    expect(nativeRequirements("core-client", [])).toEqual([]);
    expect(nativeRequirements("core-client", [NODEX_CLI_BOOTSTRAP_TEST])).toEqual([
      "core-server",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [YJS_YRS_TEST])).toEqual(["yjs-yrs-bridge"]);
    expect(nativeRequirements("core-client", ["src/main/new/behavior.node.test.ts"])).toEqual([
      "core-server",
    ]);
    expect(nativeRequirements("integration")).toEqual(["core-server"]);
    expect(STRESS_TEST_SUITES).toContain("core-client");
    expect(filesForSuite("effect-codex", "stress").include).toEqual([]);
  });
});
