import path from "node:path";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type {
  BrowserRuntimeAvailability,
  BrowserRuntimeUnavailableReason,
  VerifiedBrowserRuntimeBundle,
} from "./browser-runtime-bundle";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import { resolveAvailableBrowserUseBackends } from "./browser-use-backends";
import type { ComputerUseRuntimeResult } from "../host-runtime/ComputerUseRuntime";

const BROWSER_USE_IN_APP_INSTRUCTIONS =
  "Control the in-app browser in conjunction with the Browser Plugin.";
const COMPUTER_USE_INSTRUCTIONS = "Control desktop apps on macOS through Computer Use.";

// The native Browser and Computer Use peers validate the code-signing identity
// of node_repl and its two nearest ancestors. Keep this launcher alive so the
// process tree is node_repl -> codex -> vendor-signed node. Browser peer
// identity remains independent from the primary app-server's locked release identity.
export const SIGNED_NODE_REPL_LAUNCHER_SOURCE = `
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" });
const forwardedSignals = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  forwardedSignals.set(signal, handler);
  process.on(signal, handler);
}
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  for (const [forwardedSignal, handler] of forwardedSignals) {
    process.off(forwardedSignal, handler);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`.trim();

type BrowserUseThreadConfig = NonNullable<ThreadStartParams["config"]>;

export type BrowserUseThreadConfigResult =
  | {
      message: string;
      reason: BrowserRuntimeUnavailableReason;
      status: "unavailable";
    }
  | {
      config: BrowserUseThreadConfig;
      status: "available";
    };

type BrowserUseThreadConfigBuilderOptions = {
  availableBackends?: () => readonly BrowserRuntimeBackend[];
  browserRuntime: BrowserRuntimeAvailability;
  computerUsePluginReady?: () => boolean;
  computerUseRuntime?: () => ComputerUseRuntimeResult | null;
  runtimeStateHome: string;
};

function buildAvailableConfig(
  bundle: VerifiedBrowserRuntimeBundle,
  runtimeStateHome: string,
  availableBackends: readonly BrowserRuntimeBackend[],
  computerUseRuntime: Extract<ComputerUseRuntimeResult, { status: "available" }> | null,
): BrowserUseThreadConfig {
  const availableBackendsValue = availableBackends.join(",");
  // app-server installs local marketplace plugins into versioned directories
  // beneath CODEX_HOME/plugins/cache and exposes skill paths from that cache.
  // Trust the app-server-owned home so both the marketplace source and the
  // effective installed copy can load dependencies. Privileged operations stay
  // behind the reviewed services from the verified runtime closure.
  const trustedCodePaths = [runtimeStateHome, bundle.rootPath].join(path.delimiter);
  const trustedServices: Record<string, string> = {};
  if (availableBackends.length > 0) {
    trustedServices.browser = bundle.paths.browserPluginService;
  }
  if (computerUseRuntime && bundle.paths.computerUseRpcService) {
    trustedServices.sky = bundle.paths.computerUseRpcService;
  }
  const env: Record<string, string> = {
    BROWSER_USE_AVAILABLE_BACKENDS: availableBackendsValue,
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: bundle.manifest.buildFlavor,
    BROWSER_USE_CODEX_APP_VERSION: bundle.manifest.desktopBuild,
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: "1",
    CODEX_CLI_PATH: bundle.paths.codexCli,
    CODEX_HOME: runtimeStateHome,
    NODE_REPL_DISABLE_ANALYTICS: "1",
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    NODE_REPL_NODE_MODULE_DIRS: bundle.nodeModuleDirs.join(path.delimiter),
    NODE_REPL_NODE_PATH: bundle.paths.node,
    NODE_REPL_TRUSTED_RPC_ENABLED: "1",
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify(trustedServices),
    NODE_REPL_TRUSTED_CODE_PATHS: trustedCodePaths,
  };
  if (availableBackends.includes("iab")) {
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER = BROWSER_USE_IN_APP_INSTRUCTIONS;
  }
  if (availableBackends.includes("chrome")) {
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME =
      "Control the Chrome browser in conjunction with the Chrome Plugin.";
  }
  if (computerUseRuntime) {
    env.NODE_REPL_HOST_SERVICES_PIPE_PATH = computerUseRuntime.hostServicesPipePath;
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE = COMPUTER_USE_INSTRUCTIONS;
    env.SKY_CUA_SERVICE_PATH = computerUseRuntime.appPath;
  }

  const config: BrowserUseThreadConfig = {
    "features.js_repl": false,
    "mcp_servers.node_repl": {
      args: [
        "-e",
        SIGNED_NODE_REPL_LAUNCHER_SOURCE,
        bundle.paths.codexCli,
        "sandbox",
        "-P",
        ":danger-full-access",
        "--",
        bundle.paths.nodeRepl,
      ],
      command: bundle.paths.node,
      env,
      startup_timeout_sec: 120,
    },
  };
  if (bundle.manifest.targetPlatform !== "darwin") return config;
  return {
    ...config,
    "shell_environment_policy.set.BROWSER_USE_AVAILABLE_BACKENDS": availableBackendsValue,
    "shell_environment_policy.set.NODE_REPL_TRUSTED_CODE_PATHS": trustedCodePaths,
  };
}

export class BrowserUseThreadConfigBuilder {
  private readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  private readonly browserRuntime: BrowserRuntimeAvailability;
  private readonly computerUsePluginReady: () => boolean;
  private readonly computerUseRuntime: () => ComputerUseRuntimeResult | null;
  private readonly runtimeStateHome: string;

  constructor(options: BrowserUseThreadConfigBuilderOptions) {
    this.availableBackends = options.availableBackends ?? (() => ["iab"]);
    this.browserRuntime = options.browserRuntime;
    this.computerUsePluginReady = options.computerUsePluginReady ?? (() => false);
    this.computerUseRuntime = options.computerUseRuntime ?? (() => null);
    this.runtimeStateHome = path.resolve(options.runtimeStateHome);
  }

  buildResult(): BrowserUseThreadConfigResult {
    if (this.browserRuntime.status === "unavailable") return this.browserRuntime;

    let requestedBackends: readonly BrowserRuntimeBackend[];
    try {
      requestedBackends = this.availableBackends();
    } catch (error) {
      return {
        message:
          error instanceof Error
            ? `Browser backend availability failed: ${error.message}`
            : "Browser backend availability failed",
        reason: "backend-unavailable",
        status: "unavailable",
      };
    }
    const availableBackends = resolveAvailableBrowserUseBackends(
      this.browserRuntime.bundle.manifest.supportedBackends,
      requestedBackends,
    );
    const computerUseRuntime = this.computerUsePluginReady() ? this.computerUseRuntime() : null;
    const availableComputerUseRuntime =
      computerUseRuntime?.status === "available" ? computerUseRuntime : null;
    if (availableBackends.length === 0 && !availableComputerUseRuntime) {
      return {
        message: "Browser runtime bundle is verified, but no browser backend is available",
        reason: "backend-unavailable",
        status: "unavailable",
      };
    }

    return {
      config: buildAvailableConfig(
        this.browserRuntime.bundle,
        this.runtimeStateHome,
        availableBackends,
        availableComputerUseRuntime,
      ),
      status: "available",
    };
  }

  async build(): Promise<BrowserUseThreadConfig | null> {
    const result = this.buildResult();
    return result.status === "available" ? result.config : null;
  }
}
