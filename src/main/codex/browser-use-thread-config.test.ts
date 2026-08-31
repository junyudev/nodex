import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import { resolveBrowserRuntimeBundle } from "./browser-runtime-bundle";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "./browser-runtime-test-fixture";
import {
  BrowserUseThreadConfigBuilder,
  SIGNED_NODE_REPL_LAUNCHER_SOURCE,
} from "./browser-use-thread-config";

const temporaryRoots: string[] = [];

function makeVerifiedRuntime() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-config-"));
  temporaryRoots.push(runtimeRoot);
  const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifest = writeBrowserRuntimeFixture(bundleRoot);
  const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
  const browserRuntime = resolveBrowserRuntimeBundle({
    appServerIdentity: testedPair.appServer,
    runtimeRoot,
    targetArch: "arm64",
    targetPlatform: "darwin",
    testedPairs: [testedPair],
  });
  if (browserRuntime.status !== "available") {
    throw new Error(browserRuntime.message);
  }
  return { browserRuntime, bundleRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("BrowserUseThreadConfigBuilder", () => {
  test("returns null with a queryable reason when the bundle is unavailable", async () => {
    const builder = new BrowserUseThreadConfigBuilder({
      browserRuntime: {
        message: "Browser bundle is not installed",
        reason: "manifest-missing",
        status: "unavailable",
      },
      runtimeStateHome: "/tmp/nodex-agent",
    });

    expect(builder.buildResult()).toEqual({
      message: "Browser bundle is not installed",
      reason: "manifest-missing",
      status: "unavailable",
    });
    await expect(builder.build()).resolves.toBeNull();
  });

  test("builds the pinned Node REPL config only from verified paths", async () => {
    const { browserRuntime, bundleRoot } = makeVerifiedRuntime();
    const runtimeStateHome = path.join(bundleRoot, "..", "state");
    const builder = new BrowserUseThreadConfigBuilder({
      browserRuntime,
      runtimeStateHome,
    });

    const config = await builder.build();

    expect(config).not.toBeNull();
    expect(config?.["features.js_repl"]).toBe(false);
    expect(config?.["mcp_servers.node_repl"]).toMatchObject({
      args: [
        "-e",
        SIGNED_NODE_REPL_LAUNCHER_SOURCE,
        path.join(bundleRoot, "bin", "codex"),
        "sandbox",
        "-P",
        ":danger-full-access",
        "--",
        path.join(bundleRoot, "bin", "node_repl"),
      ],
      command: path.join(bundleRoot, "bin", "node"),
      startup_timeout_sec: 120,
      env: {
        BROWSER_USE_AVAILABLE_BACKENDS: "iab",
        BROWSER_USE_DISABLE_AMBIENT_NETWORK: "1",
        CODEX_CLI_PATH: path.join(bundleRoot, "bin", "codex"),
        CODEX_HOME: path.resolve(runtimeStateHome),
        NODE_REPL_DISABLE_ANALYTICS: "1",
        NODE_REPL_NODE_MODULE_DIRS: [
          path.join(bundleRoot, "marketplace", "plugins", "browser", "node_modules"),
          path.join(bundleRoot, "runtime", "lib", "node_modules"),
        ].join(path.delimiter),
        NODE_REPL_NODE_PATH: path.join(bundleRoot, "bin", "node"),
        NODE_REPL_TRUSTED_CODE_PATHS: [path.resolve(runtimeStateHome), bundleRoot].join(
          path.delimiter,
        ),
        NODE_REPL_TRUSTED_RPC_ENABLED: "1",
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
          browser: path.join(bundleRoot, "marketplace", "plugins", "browser", "service.js"),
        }),
      },
    });
    expect(
      config?.["shell_environment_policy.set.BROWSER_USE_DISABLE_AMBIENT_NETWORK"],
    ).toBeUndefined();
    expect(config?.["shell_environment_policy.set.NODE_REPL_DISABLE_ANALYTICS"]).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("NODE_REPL_TRUST_ALL_CODE");
    expect(JSON.stringify(config)).not.toContain("experimental_thread_config_endpoint");
  });

  test("advertises Chrome only when an active backend resolver supplies it", async () => {
    const { browserRuntime } = makeVerifiedRuntime();
    const builder = new BrowserUseThreadConfigBuilder({
      availableBackends: () => ["iab", "chrome"],
      browserRuntime,
      runtimeStateHome: "/tmp/nodex-agent",
    });

    const config = await builder.build();
    const nodeRepl = config?.["mcp_servers.node_repl"] as {
      env?: Record<string, string>;
    };

    expect(nodeRepl.env?.BROWSER_USE_AVAILABLE_BACKENDS).toBe("iab,chrome");
    expect(nodeRepl.env?.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME).toContain("Chrome browser");
  });

  test("builds Computer Use config independently of Browser backend availability", async () => {
    const { browserRuntime, bundleRoot } = makeVerifiedRuntime();
    const runtimeStateHome = "/tmp/nodex-agent";
    const builder = new BrowserUseThreadConfigBuilder({
      availableBackends: () => [],
      browserRuntime,
      computerUsePluginReady: () => true,
      computerUseRuntime: () => ({
        appPath: "/tmp/nodex-agent/computer-use/Codex Computer Use.app",
        hostServicesPipePath: "/tmp/nodex-host-services/runtime.sock",
        serviceExecutablePath:
          "/tmp/nodex-agent/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        status: "available",
      }),
      runtimeStateHome,
    });

    const config = await builder.build();
    const nodeRepl = config?.["mcp_servers.node_repl"] as {
      args?: string[];
      command?: string;
      env?: Record<string, string>;
    };

    expect(nodeRepl).toMatchObject({
      args: [
        "-e",
        SIGNED_NODE_REPL_LAUNCHER_SOURCE,
        browserRuntime.bundle.paths.codexCli,
        "sandbox",
        "-P",
        ":danger-full-access",
        "--",
        browserRuntime.bundle.paths.nodeRepl,
      ],
      command: browserRuntime.bundle.paths.node,
    });
    expect(nodeRepl.env).toMatchObject({
      NODE_REPL_HOST_SERVICES_PIPE_PATH: "/tmp/nodex-host-services/runtime.sock",
      NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE:
        "Control desktop apps on macOS through Computer Use.",
      NODE_REPL_TRUSTED_CODE_PATHS: [path.resolve(runtimeStateHome), bundleRoot].join(
        path.delimiter,
      ),
      SKY_CUA_SERVICE_PATH: "/tmp/nodex-agent/computer-use/Codex Computer Use.app",
    });
    expect(nodeRepl.env?.BROWSER_USE_AVAILABLE_BACKENDS).toBe("");
    expect(nodeRepl.env?.NODE_REPL_TRUSTED_SERVICES).toBe(
      JSON.stringify({
        sky: path.join(
          bundleRoot,
          "runtime",
          "lib",
          "node_modules",
          "@oai",
          "sky",
          "dist",
          "project",
          "cua",
          "sky_js",
          "src",
          "service.js",
        ),
      }),
    );
  });
});
