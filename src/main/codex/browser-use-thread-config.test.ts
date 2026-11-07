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
import { BrowserUseThreadConfigBuilder } from "./browser-use-thread-config";

import { nodexDesktopToolMarketplaceName } from "./bundled-desktop-tool-marketplace";
import { computerUseNativePipePath } from "./computer-use-runtime-config";
import type { BrowserPluginReconcileResult } from "./browser-plugin-reconciler";
import { NODE_REPL_LAUNCHER_SOURCE } from "./desktop-tool-environment";

const temporaryRoots: string[] = [];

async function makeVerifiedRuntime() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-config-"));
  temporaryRoots.push(runtimeRoot);
  const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifest = writeBrowserRuntimeFixture(bundleRoot);
  const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
  const browserRuntime = await resolveBrowserRuntimeBundle({
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
      codexHome: path.resolve("/tmp/native-codex-home"),
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
    const { browserRuntime, bundleRoot } = await makeVerifiedRuntime();
    const runtimeStateHome = path.join(bundleRoot, "..", "state");
    const builder = new BrowserUseThreadConfigBuilder({
      codexHome: path.resolve("/tmp/native-codex-home"),
      browserRuntime,
      runtimeStateHome,
    });

    const config = await builder.build();

    expect(config).not.toBeNull();
    expect(config?.["features.js_repl"]).toBe(false);
    expect(config?.["mcp_servers.node_repl"]).toMatchObject({
      args: [
        "-e",
        NODE_REPL_LAUNCHER_SOURCE,
        expect.any(String),
        path.join(bundleRoot, "bin", "codex"),
        "sandbox",
        "-P",
        ":danger-full-access",
        "--",
        path.join(bundleRoot, "bin", "node_repl"),
      ],
      command: path.join(bundleRoot, "bin", "node"),
      enabled: true,
      env_vars: [],
      startup_timeout_sec: 120,
      env: {
        BROWSER_USE_AVAILABLE_BACKENDS: "iab",
        BROWSER_USE_DISABLE_AMBIENT_NETWORK: "1",
        CODEX_CLI_PATH: path.join(bundleRoot, "bin", "codex"),
        CODEX_HOME: path.resolve("/tmp/native-codex-home"),
        NODE_REPL_DISABLE_ANALYTICS: "1",
        NODE_REPL_NODE_MODULE_DIRS: [
          path.join(bundleRoot, "marketplace", "plugins", "browser", "node_modules"),
          path.join(bundleRoot, "runtime", "lib", "node_modules"),
        ].join(path.delimiter),
        NODE_REPL_NODE_PATH: path.join(bundleRoot, "bin", "node"),
        NODE_REPL_TRUSTED_CODE_PATHS: [
          path.resolve(runtimeStateHome),
          path.join(
            path.resolve("/tmp/native-codex-home"),
            "plugins",
            "cache",
            nodexDesktopToolMarketplaceName(runtimeStateHome),
          ),
          bundleRoot,
        ].join(path.delimiter),
        NODE_REPL_TRUSTED_RPC_ENABLED: "1",
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
          browser: path.join(bundleRoot, "marketplace", "plugins", "browser", "service.js"),
        }),
      },
    });
    const nodeRepl = config?.["mcp_servers.node_repl"] as {
      args: string[];
      env: Record<string, string>;
    };
    // The launcher keeps exactly the Desktop Tool variables Nodex declares.
    expect(JSON.parse(nodeRepl.args[2] ?? "null")).toEqual(Object.keys(nodeRepl.env).sort());
    expect(
      config?.["shell_environment_policy.set.BROWSER_USE_DISABLE_AMBIENT_NETWORK"],
    ).toBeUndefined();
    expect(config?.["shell_environment_policy.set.NODE_REPL_DISABLE_ANALYTICS"]).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("NODE_REPL_TRUST_ALL_CODE");
    expect(JSON.stringify(config)).not.toContain("experimental_thread_config_endpoint");
  });

  test("advertises Chrome only when an active backend resolver supplies it", async () => {
    const { browserRuntime } = await makeVerifiedRuntime();
    const builder = new BrowserUseThreadConfigBuilder({
      codexHome: path.resolve("/tmp/native-codex-home"),
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

  test("disables foreign desktop peers only for the current Thread", async () => {
    const { browserRuntime } = await makeVerifiedRuntime();
    const builder = new BrowserUseThreadConfigBuilder({
      browserRuntime,
      codexHome: path.resolve("/tmp/native-codex-home"),
      disabledDesktopPluginIds: ["browser@openai-bundled", "chrome@nodex-desktop-012345abcdef"],
      runtimeStateHome: "/tmp/nodex-agent",
    });

    const config = await builder.build();
    expect(config?.["plugins.browser@openai-bundled.enabled"]).toBe(false);
    expect(config?.["plugins.chrome@nodex-desktop-012345abcdef.enabled"]).toBe(false);
    expect(config?.["plugins.pdf@openai-bundled.enabled"]).toBeUndefined();
    expect(
      config?.[`plugins.browser@${nodexDesktopToolMarketplaceName("/tmp/nodex-agent")}.enabled`],
    ).toBe(true);
    expect(
      config?.[`plugins.chrome@${nodexDesktopToolMarketplaceName("/tmp/nodex-agent")}.enabled`],
    ).toBe(false);
  });

  test("builds Computer Use config independently of Browser backend availability", async () => {
    const { browserRuntime, bundleRoot } = await makeVerifiedRuntime();
    const runtimeStateHome = "/tmp/nodex-agent";
    const builder = new BrowserUseThreadConfigBuilder({
      codexHome: path.resolve("/tmp/native-codex-home"),
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
        NODE_REPL_LAUNCHER_SOURCE,
        expect.any(String),
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
      NODE_REPL_TRUSTED_CODE_PATHS: [
        path.resolve(runtimeStateHome),
        path.join(
          path.resolve("/tmp/native-codex-home"),
          "plugins",
          "cache",
          nodexDesktopToolMarketplaceName(runtimeStateHome),
        ),
        bundleRoot,
      ].join(path.delimiter),
      SKY_CUA_SERVICE_PATH: "/tmp/nodex-agent/computer-use/Codex Computer Use.app",
      SKY_CUA_SERVICE_NATIVE_PIPE_PATH: computerUseNativePipePath(runtimeStateHome),
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

const reconciledPlugins = (): Extract<BrowserPluginReconcileResult, { status: "ready" }> => ({
  status: "ready",
  enabled: true,
  installedVersion: "1.0.0-test",
  marketplaceRoot: "/reconciled/marketplace",
  chrome: {
    status: "ready",
    enabled: true,
    installedVersion: "1.0.0-test",
    pluginRoot: "/reconciled/chrome",
  },
  computerUse: {
    status: "ready",
    enabled: true,
    installedVersion: "1.0.0-test",
    pluginRoot: "/reconciled/computer-use",
  },
});

describe("host Desktop Tools", () => {
  test("shares the exact signed launcher and environment with Codex and uses reconciled plugin roots", async () => {
    const { browserRuntime } = await makeVerifiedRuntime();
    const builder = new BrowserUseThreadConfigBuilder({
      browserRuntime,
      availableBackends: () => ["iab", "chrome"],
      computerUsePluginReady: () => true,
      computerUseRuntime: () => ({
        status: "available",
        appPath: "/state/helper.app",
        hostServicesPipePath: "/state/host.sock",
        serviceExecutablePath: "/state/helper.app/service",
      }),
      codexHome: "/codex",
      runtimeStateHome: "/state",
    });
    const config = builder.buildResult();
    if (config.status !== "available") throw new Error(config.message);
    const { command, args, env } = config.config["mcp_servers.node_repl"] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(builder.buildDesktopTools(reconciledPlugins())).toEqual({
      server: { command, args, env },
      pluginRoots: [
        path.join("/reconciled/marketplace", "plugins", "browser"),
        "/reconciled/chrome",
        "/reconciled/computer-use",
      ],
    });
  });

  test.each([
    {
      backends: ["iab", "chrome"] as const,
      chromeReady: false,
      computerReady: false,
      expectedBackends: "iab",
      roots: [path.join("/reconciled/marketplace", "plugins", "browser")],
    },
    {
      backends: ["iab"] as const,
      chromeReady: true,
      computerReady: false,
      expectedBackends: "iab",
      roots: [path.join("/reconciled/marketplace", "plugins", "browser")],
    },
    {
      backends: ["chrome"] as const,
      chromeReady: true,
      computerReady: false,
      expectedBackends: "chrome",
      roots: ["/reconciled/chrome"],
    },
    {
      backends: [] as const,
      chromeReady: false,
      computerReady: true,
      expectedBackends: "",
      roots: ["/reconciled/computer-use"],
    },
  ])(
    "independently gates backend and plugin readiness: $expectedBackends, $computerReady",
    async ({ backends, chromeReady, computerReady, expectedBackends, roots }) => {
      const { browserRuntime } = await makeVerifiedRuntime();
      const plugins = reconciledPlugins();
      if (!chromeReady)
        plugins.chrome = {
          status: "unavailable",
          reason: "backend-unavailable",
          message: "unavailable",
        };
      const builder = new BrowserUseThreadConfigBuilder({
        browserRuntime,
        availableBackends: () => backends,
        computerUsePluginReady: () => computerReady,
        computerUseRuntime: () => ({
          status: "available",
          appPath: "/state/helper.app",
          hostServicesPipePath: "/state/host.sock",
          serviceExecutablePath: "/state/service",
        }),
        codexHome: "/codex",
        runtimeStateHome: "/state",
      });
      const tools = builder.buildDesktopTools(plugins);
      expect(tools?.pluginRoots).toEqual(roots);
      expect(tools?.server.env.BROWSER_USE_AVAILABLE_BACKENDS).toBe(expectedBackends);
      expect(Boolean(tools?.server.env.NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER)).toBe(
        backends.some((backend) => backend === "iab"),
      );
      expect(Boolean(tools?.server.env.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME)).toBe(
        expectedBackends.includes("chrome"),
      );
      expect(Boolean(tools?.server.env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE)).toBe(
        computerReady,
      );
      expect(Boolean(tools?.server.env.SKY_CUA_SERVICE_PATH)).toBe(computerReady);
      expect(Boolean(JSON.parse(tools!.server.env.NODE_REPL_TRUSTED_SERVICES!).sky)).toBe(
        computerReady,
      );
    },
  );

  test("returns null when no capability or materialization is ready", async () => {
    const { browserRuntime } = await makeVerifiedRuntime();
    const builder = new BrowserUseThreadConfigBuilder({
      browserRuntime,
      availableBackends: () => [],
      codexHome: "/codex",
      runtimeStateHome: "/state",
    });
    expect(builder.buildDesktopTools(reconciledPlugins())).toBeNull();
    expect(builder.buildDesktopTools(null)).toBeNull();
    expect(
      builder.buildDesktopTools({
        status: "unavailable",
        reason: "reconciliation-failed",
        message: "not installed",
      }),
    ).toBeNull();
  });
});
