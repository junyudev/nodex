import { describe, expect, test } from "vite-plus/test";
import {
  filesForSuite,
  AGENT_EVAL_DESKTOP_ENVIRONMENT_TEST,
  nativeRequirements,
  NATIVE_PIP_PROBE_TEST,
  NODEX_CLI_BOOTSTRAP_TEST,
  SCOPED_AGENT_CORE_TEST,
  HOST_SERVE_PLATFORM_TEST,
  PROFILE_CLONE_TEST,
  AUTOMATIONS_CLI_TEST,
  ownersOfTest,
  STRESS_TEST_SUITES,
  LIVE_TEST_SUITES,
  YJS_YRS_TEST,
} from "./test-suites";

describe("application test ownership", () => {
  test.each([
    ["src/main/new-application/behavior.node.test.ts", "core-client", "default"],
    ["src/main/new-application/behavior.test.ts", "main", "default"],
    ["src/main/platform/node/NodeExecutionRuntime.test.ts", "main", "default"],
    ["src/main/platform/node/AgentRuntimeEntrypoint.node.test.ts", "core-client", "default"],
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
    ["packages/agent-runtime/src/nodex/Authority.test.ts", "agent-runtime", "default"],
    ["packages/agent-runtime/vendor/contracts/src/background.test.ts", "agent-runtime", "default"],
    [
      "packages/agent-runtime/vendor/shared/src/orchestrationV2PendingBackgroundWork.test.ts",
      "agent-runtime",
      "default",
    ],
    [
      "packages/agent-runtime/vendor/new-package/src/nested/behavior.test.ts",
      "agent-runtime",
      "default",
    ],
    [
      "packages/agent-runtime/vendor/provider-opencode/src/server/v2/OpenCode2Client.live.test.ts",
      "agent-runtime",
      "live",
    ],
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
    expect(nativeRequirements("core-client", undefined, "darwin")).toEqual([
      "core-server",
      "yjs-yrs-bridge",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [])).toEqual([]);
    expect(nativeRequirements("core-client", [NODEX_CLI_BOOTSTRAP_TEST])).toEqual([
      "core-server",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [PROFILE_CLONE_TEST])).toEqual(["core-server", "cli"]);
    expect(nativeRequirements("core-client", [SCOPED_AGENT_CORE_TEST])).toEqual([
      "core-server",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [HOST_SERVE_PLATFORM_TEST])).toEqual([
      "core-server",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [AUTOMATIONS_CLI_TEST])).toEqual([
      "core-server",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [AGENT_EVAL_DESKTOP_ENVIRONMENT_TEST])).toEqual([
      "core-server",
      "cli",
    ]);
    expect(nativeRequirements("core-client", [YJS_YRS_TEST])).toEqual(["yjs-yrs-bridge"]);
    expect(nativeRequirements("core-client", ["src/main/new/behavior.node.test.ts"])).toEqual([
      "core-server",
    ]);
    expect(nativeRequirements("integration")).toEqual(["core-server"]);
    expect(STRESS_TEST_SUITES).toContain("core-client");
    expect(LIVE_TEST_SUITES).toEqual(["agent-runtime"]);
    expect(filesForSuite("effect-codex", "stress").include).toEqual([]);
    expect(filesForSuite("effect-codex", "live").include).toEqual([]);
  });

  test("prepares native maintenance only for Windows installation boundaries", () => {
    expect(
      nativeRequirements("unit", ["scripts/windows-installation-processes.test.ts"], "win32"),
    ).toEqual(["windows-maintenance"]);
    expect(
      nativeRequirements("unit", ["scripts/windows-installation-processes.test.ts"], "darwin"),
    ).toEqual([]);
    expect(
      nativeRequirements("core-client", ["src/main/core-client/core-client.node.test.ts"], "win32"),
    ).toEqual(["windows-maintenance", "core-server"]);
    expect(nativeRequirements("core-client", undefined, "win32")).toEqual([
      "core-server",
      "yjs-yrs-bridge",
      "cli",
      "windows-maintenance",
    ]);
  });

  test.each(["darwin", "linux", "win32"] as const)(
    "prepares the production PiP addon only for its macOS test on %s",
    (platform) => {
      const expected = platform === "darwin" ? ["agent-runtime"] : [];
      expect(nativeRequirements("unit", undefined, platform)).toEqual(
        platform === "win32" ? ["windows-maintenance"] : expected,
      );
      expect(nativeRequirements("unit", [NATIVE_PIP_PROBE_TEST], platform)).toEqual(expected);
      expect(nativeRequirements("unit", [], platform)).toEqual([]);
      expect(nativeRequirements("unit", ["scripts/testing/run-tests.test.ts"], platform)).toEqual(
        [],
      );
    },
  );
});
