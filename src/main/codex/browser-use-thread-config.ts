import path from "node:path";
import type { HostDesktopTools } from "@nodex/agent-runtime/contracts";
import type { BrowserPluginReconcileResult } from "./browser-plugin-reconciler";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type {
  BrowserRuntimeAvailability,
  VerifiedBrowserRuntimeBundle,
} from "./browser-runtime-bundle";
import type {
  BrowserRuntimeBackend,
  BrowserRuntimeUnavailableReason,
} from "../../shared/browser-runtime-metadata";
import { resolveAvailableBrowserUseBackends } from "./browser-use-backends";
import type { ComputerUseRuntimeResult } from "../host-runtime/ComputerUseRuntime";
import { nodexDesktopToolMarketplaceName } from "./bundled-desktop-tool-marketplace";
import {
  computerUseNativePipePath,
  windowsComputerUseReplEnvironment,
} from "./computer-use-runtime-config";
import {
  codexReplScratchParent,
  nodeReplServerDefinition,
  windowsReplSystemEnvironment,
  windowsDesktopToolCodexHome,
} from "./desktop-tool-environment";

const BROWSER_USE_IN_APP_INSTRUCTIONS =
  "Control the in-app browser in conjunction with the Browser Plugin.";
const COMPUTER_USE_INSTRUCTIONS = "Control desktop apps on macOS through Computer Use.";

const MAC_NODE_REPL_INSTRUCTIONS = [
  "Use `js` for persistent, redeclarable top-level bindings, `js_reset` to clear bindings, and `js_add_node_module_dir` to add package directories.",
  "",
  "On macOS the effective chat permission mode governs JavaScript and child commands:",
  "",
  "| Mode | Reads | Writes | Direct network |",
  "| --- | --- | --- | --- |",
  "| Ask for approval or Approve for me | Paths allowed by the sandbox | Execution workspace, Project Sources, attachments and scratch, subject to sandbox protections | Blocked |",
  "| Full access | OS-account access | OS-account access | Allowed within host policy |",
  "| Codex read-only context | Paths allowed by the sandbox | Blocked by default | Blocked by default |",
  "",
  "Codex also honors writable roots in its native workspace policy. Browser and app access have separate consent.",
  "`nodeRepl.cwd` and `nodeRepl.tmpDir` report paths. Scratch is removed when the REPL process exits. Host-managed REPLs are released after 30 minutes idle. Bindings clear on kernel reset or when its effective policy or working directory changes.",
  "",
  "For a secret handoff, keep the value in a binding. Spawn the intended executable with an argument array and piped stdin. Pass the value using `child.stdin.end(value)`. `gh secret set NAME --repo owner/repo` reads the value from stdin.",
  "Never put the value in tool arguments, environment variables, output, logs, files or the clipboard. If an independent value is available, compare a short SHA-256 prefix locally and report only match or no match. Report the command outcome separately.",
].join("\n");

type BrowserUseThreadConfig = NonNullable<ThreadStartParams["config"]>;

export const buildDesktopToolPluginOverrides = (
  pluginIds: readonly string[],
): BrowserUseThreadConfig =>
  Object.fromEntries(pluginIds.map((id) => [`plugins.${id}.enabled`, false]));

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

export interface WindowsDesktopToolServerOptions {
  readonly jobLauncher: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}
type WindowsReplOptions = WindowsDesktopToolServerOptions & {
  readonly computerUse?: {
    readonly env: NonNullable<ReturnType<typeof windowsComputerUseReplEnvironment>>;
  };
};
type AvailableMacComputerUse = Extract<
  ComputerUseRuntimeResult,
  { status: "available"; platform?: "darwin" }
>;

type BrowserUseThreadConfigBuilderOptions = {
  windows?: WindowsDesktopToolServerOptions;
  availableBackends?: () => readonly BrowserRuntimeBackend[];
  browserRuntime: BrowserRuntimeAvailability;
  computerUsePluginReady?: () => boolean;
  computerUseRuntime?: () => ComputerUseRuntimeResult | null;
  codexHome: string;
  disabledDesktopPluginIds?: readonly string[];
  runtimeStateHome: string;
};

function buildNodeReplServer(
  bundle: VerifiedBrowserRuntimeBundle,
  runtimeStateHome: string,
  codexHome: string,
  availableBackends: readonly BrowserRuntimeBackend[],
  computerUseRuntime: AvailableMacComputerUse | null,
  hostManaged: boolean,
  windows?: WindowsReplOptions,
) {
  const mac = bundle.manifest.targetPlatform === "darwin";
  const targetPath = windows ? path.win32 : path;
  const availableBackendsValue = availableBackends.join(",");
  // app-server installs local marketplace plugins into versioned directories
  // beneath CODEX_HOME/plugins/cache and exposes skill paths from that cache.
  // Trust only this Profile's materialized source and native installed cache.
  // Other clients' plugins in the shared home do not gain trusted RPC access.
  const installedPluginCache = targetPath.join(
    codexHome,
    "plugins",
    "cache",
    nodexDesktopToolMarketplaceName(runtimeStateHome, windows ? "win32" : undefined),
  );
  const trustedCodePaths = [runtimeStateHome, installedPluginCache, bundle.rootPath].join(
    targetPath.delimiter,
  );
  const trustedServices: Record<string, string> = {};
  if (availableBackends.length > 0) {
    trustedServices.browser = bundle.paths.browserPluginService;
  }
  if (windows?.computerUse) {
    trustedServices.sky = "@oai/sky/service";
  } else if (computerUseRuntime && bundle.paths.computerUseRpcService) {
    trustedServices.sky = bundle.paths.computerUseRpcService;
  }
  const env: Record<string, string> = {
    ...(windows ? windowsReplSystemEnvironment(windows.environment) : {}),
    ...windows?.computerUse?.env,
    BROWSER_USE_AVAILABLE_BACKENDS: availableBackendsValue,
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: windows
      ? nodexDesktopToolMarketplaceName(runtimeStateHome, "win32")
      : bundle.manifest.buildFlavor,
    BROWSER_USE_CODEX_APP_VERSION: bundle.manifest.desktopBuild,
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: "1",
    CODEX_CLI_PATH: bundle.paths.codexCli,
    CODEX_HOME: windows ? windowsDesktopToolCodexHome(runtimeStateHome) : codexHome,
    NODE_REPL_DISABLE_ANALYTICS: "1",
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    NODE_REPL_NODE_MODULE_DIRS: bundle.nodeModuleDirs.join(targetPath.delimiter),
    NODE_REPL_NODE_PATH: bundle.paths.node,
    NODE_REPL_TRUSTED_RPC_ENABLED: "1",
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify(trustedServices),
    NODE_REPL_TRUSTED_CODE_PATHS: trustedCodePaths,
  };
  if (mac) {
    env.NODE_REPL_TOOL_OVERRIDES = JSON.stringify({
      server_instructions: MAC_NODE_REPL_INSTRUCTIONS,
    });
  }
  if (availableBackends.includes("iab")) {
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER = BROWSER_USE_IN_APP_INSTRUCTIONS;
  }
  if (availableBackends.includes("chrome")) {
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME =
      "Control the Chrome browser in conjunction with the Chrome Plugin.";
  }
  if (windows?.computerUse) {
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE = "Control desktop apps through Computer Use.";
  }
  if (computerUseRuntime && !windows) {
    env.NODE_REPL_HOST_SERVICES_PIPE_PATH = computerUseRuntime.hostServicesPipePath;
    env.NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE = COMPUTER_USE_INSTRUCTIONS;
    env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH = computerUseNativePipePath(runtimeStateHome);
    env.SKY_CUA_SERVICE_PATH = computerUseRuntime.appPath;
  }

  if (mac && hostManaged) {
    // The Runtime sets the real value at spawn. Declaring the key pins it past Codex config.
    env.TMPDIR = "";
  }

  return nodeReplServerDefinition({
    windowsJobLauncher: windows?.jobLauncher,
    codexCliPath: bundle.paths.codexCli,
    env,
    scratchParent: mac && !hostManaged ? codexReplScratchParent(runtimeStateHome) : undefined,
    nodePath: bundle.paths.node,
    nodeReplPath: bundle.paths.nodeRepl,
  });
}

type AvailableDesktopRuntime = {
  status: "available";
  server: ReturnType<typeof nodeReplServerDefinition>;
  availableBackends: readonly BrowserRuntimeBackend[];
  computerUseAvailable: boolean;
};
type DesktopRuntimeResult =
  | AvailableDesktopRuntime
  | Extract<BrowserUseThreadConfigResult, { status: "unavailable" }>;

export class BrowserUseThreadConfigBuilder {
  private readonly windows: WindowsDesktopToolServerOptions | undefined;
  private readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  private readonly browserRuntime: BrowserRuntimeAvailability;
  private readonly computerUsePluginReady: () => boolean;
  private readonly computerUseRuntime: () => ComputerUseRuntimeResult | null;
  private readonly codexHome: string;
  private readonly disabledDesktopPluginIds: readonly string[];
  private readonly runtimeStateHome: string;

  constructor(options: BrowserUseThreadConfigBuilderOptions) {
    this.windows = options.windows;
    const targetPath = this.windows ? path.win32 : path;
    this.availableBackends = options.availableBackends ?? (() => ["iab"]);
    this.browserRuntime = options.browserRuntime;
    this.computerUsePluginReady = options.computerUsePluginReady ?? (() => false);
    this.computerUseRuntime = options.computerUseRuntime ?? (() => null);
    this.codexHome = targetPath.resolve(options.codexHome);
    this.disabledDesktopPluginIds = options.disabledDesktopPluginIds ?? [];
    this.runtimeStateHome = targetPath.resolve(options.runtimeStateHome);
  }

  private resolveRuntime(
    plugins?: Extract<BrowserPluginReconcileResult, { status: "ready" }>,
  ): DesktopRuntimeResult {
    if (this.browserRuntime.status === "unavailable") return this.browserRuntime;

    const windowsTarget = this.browserRuntime.bundle.manifest.targetPlatform === "win32";
    if (windowsTarget && !this.windows)
      return {
        message: "Windows Desktop Tool launch provider is unavailable",
        reason: "platform-verification-failed",
        status: "unavailable",
      };

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
    if (plugins) {
      requestedBackends = requestedBackends.filter((backend) =>
        backend === "chrome"
          ? plugins.chrome.status === "ready" && plugins.chrome.enabled
          : plugins.enabled,
      );
    }
    const availableBackends = resolveAvailableBrowserUseBackends(
      this.browserRuntime.bundle.manifest.supportedBackends,
      requestedBackends,
    );
    const computerUseReady =
      this.computerUsePluginReady() &&
      (!plugins || (plugins.computerUse.status === "ready" && plugins.computerUse.enabled));
    const computerUseRuntime = computerUseReady ? this.computerUseRuntime() : null;
    const availableComputerUseRuntime =
      !windowsTarget &&
      computerUseRuntime?.status === "available" &&
      computerUseRuntime.platform !== "win32"
        ? computerUseRuntime
        : null;
    const windowsComputerUseEnv = windowsComputerUseReplEnvironment(computerUseRuntime);
    const windows =
      windowsTarget && this.windows
        ? {
            ...this.windows,
            computerUse: windowsComputerUseEnv ? { env: windowsComputerUseEnv } : undefined,
          }
        : undefined;
    if (availableBackends.length === 0 && !availableComputerUseRuntime && !windows?.computerUse) {
      return {
        message: "Browser runtime bundle is verified, but no browser backend is available",
        reason: "backend-unavailable",
        status: "unavailable",
      };
    }

    return {
      server: buildNodeReplServer(
        this.browserRuntime.bundle,
        this.runtimeStateHome,
        this.codexHome,
        availableBackends,
        availableComputerUseRuntime,
        plugins !== undefined,
        windows,
      ),
      availableBackends,
      computerUseAvailable: availableComputerUseRuntime !== null || !!windows?.computerUse,
      status: "available",
    };
  }

  buildResult(): BrowserUseThreadConfigResult {
    const runtime = this.resolveRuntime();
    if (runtime.status === "unavailable") return runtime;
    const config: BrowserUseThreadConfig = {
      ...buildDesktopToolPluginOverrides(this.disabledDesktopPluginIds),
      ...Object.fromEntries(
        [
          ["browser", runtime.availableBackends.length > 0],
          ["chrome", runtime.availableBackends.includes("chrome")],
          ["computer-use", runtime.computerUseAvailable],
        ].map(([name, enabled]) => [
          `plugins.${name}@${nodexDesktopToolMarketplaceName(this.runtimeStateHome, this.windows ? "win32" : undefined)}.enabled`,
          enabled,
        ]),
      ),
      "features.js_repl": false,
      "mcp_servers.node_repl": runtime.server,
    };
    if (
      this.browserRuntime.status === "available" &&
      this.browserRuntime.bundle.manifest.targetPlatform === "darwin"
    ) {
      config["shell_environment_policy.set.BROWSER_USE_AVAILABLE_BACKENDS"] =
        runtime.server.env.BROWSER_USE_AVAILABLE_BACKENDS;
      config["shell_environment_policy.set.NODE_REPL_TRUSTED_CODE_PATHS"] =
        runtime.server.env.NODE_REPL_TRUSTED_CODE_PATHS;
    }
    return { status: "available", config };
  }

  /** Session plugins must use the reconciled materialization, never the sealed source bundle. */
  buildDesktopTools(plugins: BrowserPluginReconcileResult | null): HostDesktopTools | null {
    if (plugins?.status !== "ready") return null;
    const runtime = this.resolveRuntime(plugins);
    if (runtime.status === "unavailable") return null;
    const { command, args, env } = runtime.server;
    return {
      server: { command, args, env },
      pluginRoots: [
        ...(runtime.availableBackends.includes("iab")
          ? [(this.windows ? path.win32 : path).join(plugins.marketplaceRoot, "plugins", "browser")]
          : []),
        ...(runtime.availableBackends.includes("chrome") && plugins.chrome.status === "ready"
          ? [plugins.chrome.pluginRoot]
          : []),
        ...(runtime.computerUseAvailable && plugins.computerUse.status === "ready"
          ? [plugins.computerUse.pluginRoot]
          : []),
      ],
    };
  }

  async build(): Promise<BrowserUseThreadConfig | null> {
    const result = this.buildResult();
    return result.status === "available" ? result.config : null;
  }
}
