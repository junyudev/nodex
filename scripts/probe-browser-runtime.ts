#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type {
  McpServerToolCallResponse,
  ThreadStartResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type { BrowserUsePeerAuthorizationMode } from "../src/shared/browser-use-host-capability";
import { ScopedCallbackRuntime } from "../src/main/app/ScopedCallbackRuntime";
import {
  browserPluginRequestPortFromPromise,
  makeBrowserPluginReconciler,
} from "../src/main/codex/browser-plugin-reconciler";
import { BrowserUseThreadConfigBuilder } from "../src/main/codex/browser-use-thread-config";
import { resolveCodexRuntime } from "../src/main/codex/codex-runtime";
import { makeBrowserUseNativePipeServer } from "../src/main/browser-use/browser-use-native-pipe-server";
import { createBrowserUsePeerAuthorizer } from "../src/main/browser-use/browser-use-peer-authorizer";
import {
  ComputerUseRuntime,
  testLayer as computerUseRuntimeLayer,
} from "../src/main/host-runtime/ComputerUseRuntime";
import { makeComputerUseHostPlatform } from "../src/main/platform/electron/ComputerUseHostPlatform";
import type { SkyNativeAddon } from "../src/main/sky-native";
import { runCodexProbeMain, withCodexProbeSession } from "./codex-probe-session";

type BrowserRuntimeProbeReport = {
  appServerRuntimeVersion: string;
  browserPluginVersion: string;
  browserRuntimeVersions: {
    codexCli: string;
    cuaRuntime: string;
    node: string;
    peerAuthorization: string;
  };
  computerUse:
    | { appCount: number; status: "available" }
    | { reason: string; status: "unavailable" };
  nativePipeMethods: string[];
  nodeReplResult: string;
  targetArch: string;
  targetPlatform: string;
};

export interface BrowserRuntimeProbeOptions {
  readonly resourcesPath?: string;
}

interface BrowserRuntimeCleanupDependencies {
  readonly closeNativePipeServer: () => Promise<void>;
  readonly removeStateHome: () => void;
  readonly stopComputerUseRuntime: () => Promise<void>;
  readonly stopClient: () => Promise<void>;
}

export async function cleanupBrowserRuntime(
  dependencies: BrowserRuntimeCleanupDependencies,
): Promise<void> {
  let firstError: unknown;
  let hasError = false;
  const operations = [
    dependencies.stopClient,
    dependencies.stopComputerUseRuntime,
    dependencies.closeNativePipeServer,
    dependencies.removeStateHome,
  ];

  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      if (hasError) continue;
      firstError = error;
      hasError = true;
    }
  }

  if (hasError) throw firstError;
}

function makeComputerUseProbeCode(computerUsePluginRoot: string): string {
  const launcherPath = path.join(computerUsePluginRoot, "bin", "computer-use-client-launcher");
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Installed Computer Use launcher is missing: ${launcherPath}`);
  }
  return `
globalThis.sky = (await import("@oai/sky")).sky;
var computerUseApps = await sky.list_apps();
nodeRepl.write("__NODEX_CUA_PROBE__" + JSON.stringify({ appCount: computerUseApps.length }));
`;
}

function resolveInstalledComputerUsePluginRoot(runtimeStateHome: string, version: string): string {
  const pluginRoot = path.join(
    runtimeStateHome,
    "plugins",
    "cache",
    "openai-bundled",
    "computer-use",
    version,
  );
  if (!fs.existsSync(path.join(pluginRoot, "bin", "computer-use-client-launcher"))) {
    throw new Error(
      `Installed Computer Use client is missing from the app-server plugin cache: ${pluginRoot}`,
    );
  }
  return pluginRoot;
}

function parseComputerUseProbeResult(text: string): { appCount?: unknown } {
  const marker = "__NODEX_CUA_PROBE__";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Computer Use probe did not return its result marker: ${text}`);
  }
  return JSON.parse(text.slice(markerIndex + marker.length).trim()) as {
    appCount?: unknown;
  };
}

export function classifyComputerUseProbeResponse(
  text: string,
  isError: boolean,
): BrowserRuntimeProbeReport["computerUse"] {
  if (isError && text.includes("The Mac is locked") && text.toLowerCase().includes("unlock")) {
    return { reason: "mac-locked", status: "unavailable" };
  }
  const parsed = parseComputerUseProbeResult(text);
  if (isError || !Number.isSafeInteger(parsed.appCount) || Number(parsed.appCount) <= 0) {
    throw new Error(`Computer Use list_apps probe failed: ${text}`);
  }
  return { appCount: Number(parsed.appCount), status: "available" };
}

function textFromToolResponse(response: McpServerToolCallResponse): string {
  return response.content
    .flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "text" &&
        "text" in entry &&
        typeof entry.text === "string"
      ) {
        return [entry.text];
      }
      return [];
    })
    .join("\n");
}

function makeBrowserClientProbeCode(browserClientPath: string): string {
  return `
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(browserClientPath)});
  globalThis.agent = await setupBrowserRuntime({ globals: globalThis });
}
if (globalThis.agent?.browsers == null) {
  throw new Error("Browser client setup did not provide an agent runtime");
}
globalThis.browser = await globalThis.agent.browsers.get("iab");
const probeInfo = (await globalThis.agent.browsers.list()).find(
  (candidate) => candidate.id === browser.browserId,
);
nodeRepl.write(JSON.stringify({
  backendType: probeInfo?.type,
  browserId: browser.browserId,
  documentationLength: (await browser.documentation()).length,
  rootNodeRepl: {
    fetchAvailable: typeof globalThis.nodeRepl?.fetch === "function",
    keys: Object.keys(globalThis.nodeRepl ?? {}).sort(),
    requestMetaAvailable: globalThis.nodeRepl?.requestMeta != null,
    rpcAvailable: typeof globalThis.nodeRepl?.rpc === "function",
  },
}));
`;
}

async function probeBrowserRuntimePromise(
  projectRoot: string,
  options: BrowserRuntimeProbeOptions,
  callbacks: ScopedCallbackRuntime["Service"],
): Promise<BrowserRuntimeProbeReport> {
  const resourcesPath = options.resourcesPath?.trim();
  const isPackaged = Boolean(resourcesPath);
  const peerAuthorizationMode: BrowserUsePeerAuthorizationMode = isPackaged
    ? "packaged"
    : "disabled";
  const runtime = resolveCodexRuntime({
    isPackaged,
    ...(resourcesPath
      ? { resourcesPath: path.resolve(resourcesPath) }
      : { projectRootPath: projectRoot }),
  });
  if (runtime.browserRuntime.status === "unavailable") {
    throw new Error(runtime.browserRuntime.message);
  }
  if (!runtime.appServerRuntimeVersion) {
    throw new Error("Agent runtime is missing its app-server runtime version");
  }
  const appServerRuntimeVersion = runtime.appServerRuntimeVersion;

  const bundle = runtime.browserRuntime.bundle;
  const stateHome = fs.mkdtempSync(path.join(projectRoot, ".generated", "browser-runtime-probe-"));
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const nativePipeMethods: string[] = [];
  const nativePipeDiagnostics: string[] = [];
  const nativePipeScope = await callbacks.runPromise(Scope.make());
  await callbacks.runPromise(
    makeBrowserUseNativePipeServer({
      events: {
        onAuthorizationError: (error) => {
          nativePipeDiagnostics.push(
            `authorization-error:${error instanceof Error ? error.message : String(error)}`,
          );
        },
        onRejectedSocket: (result) => {
          nativePipeDiagnostics.push(`rejected:${JSON.stringify(result)}`);
        },
        onSocketError: (error) => {
          nativePipeDiagnostics.push(`socket-error:${error.message}`);
        },
      },
      handler: (request) => {
        nativePipeMethods.push(request.method);
        if (request.method === "ping") return "pong";
        if (request.method === "getInfo") {
          return {
            apiSupportOverrides: {},
            capabilities: { browser: [], tab: [] },
            metadata: {
              codexAppBuildFlavor: bundle.manifest.buildFlavor,
              codexAppSessionId: "runtime-probe",
              codexSessionId: sessionId,
            },
            name: "Nodex Browser Runtime Probe",
            type: "iab",
            version: bundle.manifest.desktopBuild,
          };
        }
        throw new Error(`Unexpected Browser runtime probe method: ${request.method}`);
      },
      platform: process.platform,
      socketPeerAuthorizer: createBrowserUsePeerAuthorizer({
        addonPath: bundle.paths.peerAuthorization,
        mode: peerAuthorizationMode,
      }),
    }).pipe(Scope.provide(nativePipeScope)),
  );
  const requireForProbe = createRequire(import.meta.url);
  const computerUseScope = await callbacks.runPromise(Scope.make());
  const macOSRelease = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
    encoding: "utf8",
  }).trim();
  const computerUseHost = {
    ...makeComputerUseHostPlatform({ macOSRelease, platform: process.platform }, callbacks),
    loadAddon: Effect.sync(
      () =>
        requireForProbe(bundle.paths.skyNativeAddon) as Pick<
          SkyNativeAddon,
          "computerUseServiceProcessMatchesExecutablePath" | "spawnComputerUseService"
        >,
    ),
  };
  const computerUseContext = await callbacks.runPromise(
    Layer.buildWithScope(
      computerUseRuntimeLayer(
        {
          browserRuntime: runtime.browserRuntime,
          macOSRelease,
          peerAuthorizationMode,
          platform: process.platform,
          runtimeStateHome: stateHome,
          terminateManagedServiceOnDispose: true,
        },
        computerUseHost,
      ),
      computerUseScope,
    ),
  );
  const computerUseRuntime = Context.get(computerUseContext, ComputerUseRuntime);

  try {
    const computerUseRuntimeResult = await callbacks.runPromise(computerUseRuntime.ensureReady);
    return await callbacks.runPromise(
      withCodexProbeSession(
        callbacks,
        {
          additionalSearchPaths: runtime.additionalSearchPaths,
          binaryPath: runtime.binaryPath,
          clientInfo: {
            name: "nodex-browser-runtime-probe",
            title: "Nodex Browser Runtime Probe",
            version: "1.0.0",
          },
          env: {
            ...process.env,
            CODEX_HOME: stateHome,
          },
          expectedCodexHome: stateHome,
          requestTimeout: 150_000,
        },
        async (client) => {
          const reconciler = await callbacks.runPromise(
            makeBrowserPluginReconciler({
              browserRuntime: runtime.browserRuntime,
              client: browserPluginRequestPortFromPromise(client),
              computerUseAvailable: () => computerUseRuntimeResult.status === "available",
              runtimeStateHome: stateHome,
            }),
          );
          const reconciliation = await callbacks.runPromise(reconciler.ensureInstalled);
          if (reconciliation.status !== "ready") throw new Error(reconciliation.message);

          const browserConfig = await new BrowserUseThreadConfigBuilder({
            availableBackends: () => ["iab"],
            browserRuntime: runtime.browserRuntime,
            computerUsePluginReady: () =>
              reconciliation.status === "ready" && reconciliation.computerUse.status === "ready",
            computerUseRuntime: () => computerUseRuntimeResult,
            runtimeStateHome: stateHome,
          }).build();
          if (!browserConfig)
            throw new Error("Verified Browser runtime did not build thread config");
          const nodeReplConfig = browserConfig["mcp_servers.node_repl"];
          if (
            typeof nodeReplConfig !== "object" ||
            nodeReplConfig === null ||
            !("env" in nodeReplConfig) ||
            typeof nodeReplConfig.env !== "object" ||
            nodeReplConfig.env === null ||
            Array.isArray(nodeReplConfig.env)
          ) {
            throw new Error("Browser runtime thread config is missing Node REPL environment");
          }
          const threadResponse = await client.request<ThreadStartResponse>("thread/start", {
            config: browserConfig,
            cwd: projectRoot,
            ephemeral: true,
          });
          const threadId = threadResponse.thread.id;
          const toolResponse = await client.request<McpServerToolCallResponse>(
            "mcpServer/tool/call",
            {
              _meta: {
                "x-codex-turn-metadata": {
                  session_id: sessionId,
                  thread_id: threadId,
                  turn_id: turnId,
                },
              },
              arguments: {
                code: makeBrowserClientProbeCode(bundle.paths.browserPluginClient),
              },
              server: "node_repl",
              threadId,
              tool: "js",
            },
          );
          const nodeReplResult = textFromToolResponse(toolResponse);
          if (
            toolResponse.isError ||
            !nodeReplResult.includes('"backendType":"iab"') ||
            !nodeReplResult.includes('"rootNodeRepl":{"fetchAvailable":false') ||
            !nodeReplResult.includes('"rpcAvailable":true')
          ) {
            throw new Error(
              `Browser client conformance failed: ${nodeReplResult || "empty result"}` +
                (nativePipeDiagnostics.length > 0 ? ` (${nativePipeDiagnostics.join("; ")})` : ""),
            );
          }
          if (!nativePipeMethods.includes("getInfo")) {
            throw new Error("Browser client did not reach the native-pipe Browser backend");
          }

          let computerUse: BrowserRuntimeProbeReport["computerUse"];
          if (
            computerUseRuntimeResult.status === "available" &&
            reconciliation.computerUse.status === "ready"
          ) {
            const installedComputerUsePluginRoot = resolveInstalledComputerUsePluginRoot(
              stateHome,
              reconciliation.computerUse.installedVersion,
            );
            const computerUseResponse = await client.request<McpServerToolCallResponse>(
              "mcpServer/tool/call",
              {
                _meta: {
                  "x-codex-turn-metadata": {
                    item_id: randomUUID(),
                    session_id: sessionId,
                    thread_id: threadId,
                    turn_id: turnId,
                  },
                },
                arguments: {
                  code: makeComputerUseProbeCode(installedComputerUsePluginRoot),
                  timeout_ms: 30_000,
                },
                server: "node_repl",
                threadId,
                tool: "js",
              },
            );
            const computerUseText = textFromToolResponse(computerUseResponse);
            computerUse = classifyComputerUseProbeResponse(
              computerUseText,
              computerUseResponse.isError === true,
            );
          } else {
            computerUse = {
              reason:
                computerUseRuntimeResult.status === "unavailable"
                  ? computerUseRuntimeResult.reason
                  : reconciliation.computerUse.status === "unavailable"
                    ? reconciliation.computerUse.reason
                    : "Computer Use probe prerequisites were not ready",
              status: "unavailable",
            };
          }

          return {
            appServerRuntimeVersion,
            browserPluginVersion: bundle.manifest.browserPlugin.version,
            browserRuntimeVersions: bundle.manifest.runtimeVersions,
            computerUse,
            nativePipeMethods: [...new Set(nativePipeMethods)],
            nodeReplResult,
            targetArch: bundle.manifest.targetArch,
            targetPlatform: bundle.manifest.targetPlatform,
          };
        },
      ),
    );
  } finally {
    await cleanupBrowserRuntime({
      closeNativePipeServer: () => callbacks.runPromise(Scope.close(nativePipeScope, Exit.void)),
      removeStateHome: () =>
        fs.rmSync(stateHome, {
          force: true,
          maxRetries: 10,
          recursive: true,
          retryDelay: 100,
        }),
      stopComputerUseRuntime: () => callbacks.runPromise(Scope.close(computerUseScope, Exit.void)),
      stopClient: () => Promise.resolve(),
    });
  }
}

export const probeBrowserRuntime = (
  projectRoot: string,
  options: BrowserRuntimeProbeOptions = {},
): Effect.Effect<BrowserRuntimeProbeReport, Cause.UnknownError, ScopedCallbackRuntime> =>
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    return yield* Effect.tryPromise(() =>
      probeBrowserRuntimePromise(projectRoot, options, callbacks),
    );
  });

function isDirectExecution(): boolean {
  const scriptPath = process.argv[1];
  return (
    typeof scriptPath === "string" &&
    path.resolve(scriptPath) === path.resolve(new URL(import.meta.url).pathname)
  );
}

if (isDirectExecution()) {
  const projectRoot = path.resolve(process.cwd());
  const arguments_ = process.argv.slice(2);
  const resourcesPathIndex = arguments_.indexOf("--resources-path");
  const resourcesPath = resourcesPathIndex < 0 ? undefined : arguments_[resourcesPathIndex + 1];
  if (resourcesPathIndex >= 0 && (!resourcesPath || resourcesPath.startsWith("--"))) {
    throw new Error("--resources-path requires a path to packaged Resources");
  }
  runCodexProbeMain(
    Effect.gen(function* () {
      const report = yield* probeBrowserRuntime(
        projectRoot,
        resourcesPath ? { resourcesPath } : {},
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }),
  );
}
