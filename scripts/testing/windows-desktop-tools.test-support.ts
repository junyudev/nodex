/* @effect-diagnostics asyncFunction:off -- Native conformance harness. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Effect from "effect/Effect";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isProcessRunning } from "../tooling/process";
import {
  isTestedBrowserAppServerPair,
  type TestedBrowserAppServerPair,
} from "../../src/shared/browser-app-server-compatibility";
import {
  readBrowserRuntimeReleaseLock,
  resolveBrowserRuntimeReleaseLockPath,
} from "../browser-runtime-release-lock";
import { BrowserUseThreadConfigBuilder } from "../../src/main/codex/browser-use-thread-config";
import { resolveCodexRuntime } from "../../src/main/codex/codex-runtime";
import {
  windowsDesktopToolCodexHome,
  windowsReplSystemEnvironment,
} from "../../src/main/codex/desktop-tool-environment";
import { makeWindowsBrowserRuntimeVerifier } from "../../src/main/platform/node/WindowsBrowserRuntimeVerifier";
import {
  makeWindowsDesktopTools,
  type WindowsProcessIdentity,
} from "../../src/main/platform/node/WindowsDesktopTools";

const runExecutable = promisify(execFile);

export function windowsDesktopToolConformanceCandidate(
  repositoryRoot: string,
  arch: string,
): TestedBrowserAppServerPair | undefined {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Unsupported Windows Desktop Tool architecture: ${arch}`);
  const lock = readBrowserRuntimeReleaseLock(resolveBrowserRuntimeReleaseLockPath(repositoryRoot));
  const asset = lock.assets[`win32-${arch}`];
  if (!asset) throw new Error(`Desktop Tool runtime is unavailable for win32-${arch}`);
  const pair = {
    appServer: asset.appServer,
    browser: {
      browserPluginVersion: lock.browserPluginVersion,
      manifestSha256: asset.manifestSha256,
      peerCliVersion: asset.runtimeVersions.codexCli,
      targetArch: arch,
      targetPlatform: "win32",
    },
  };
  return isTestedBrowserAppServerPair(pair.appServer, pair.browser) ? undefined : pair;
}

export async function probeWindowsDesktopTools(options: {
  readonly location:
    | { readonly isPackaged: true; readonly resourcesPath: string }
    | { readonly isPackaged: false; readonly projectRootPath: string };
  readonly boundary: string;
  readonly launcher: string;
  readonly conformanceCandidatePair?: TestedBrowserAppServerPair;
}) {
  if (process.platform !== "win32") throw new Error("Desktop Tool conformance requires Windows");
  const native = makeWindowsDesktopTools(options.launcher);
  const verifier = makeWindowsBrowserRuntimeVerifier(native, options.boundary, Effect.runPromise);
  const signal = AbortSignal.timeout(180_000);
  const { browserRuntime } = await resolveCodexRuntime({
    ...options.location,
    platform: process.platform,
    architecture: process.arch,
    windowsBrowserRuntimeVerifier: verifier,
    conformanceCandidatePair: options.conformanceCandidatePair,
    signal,
  });
  if (browserRuntime.status !== "available") throw new Error(browserRuntime.message);
  if (browserRuntime.bundle.manifest.targetPlatform !== "win32")
    throw new Error("Desktop Tool conformance resolved a foreign closure");

  const { rootPath, paths, manifest } = browserRuntime.bundle;
  const addon = Object.keys(manifest.trust.pe).find(
    (file) =>
      file.startsWith(
        `runtime/bin/node_modules/@img/sharp-win32-${manifest.targetArch}/lib/sharp-`,
      ) && file.endsWith(".node"),
  );
  if (!addon) throw new Error("Desktop Tool closure is missing its Sharp addon");
  await runExecutable(
    paths.node,
    [
      "-e",
      'if (typeof require(process.argv[1]).pipeline !== "function") throw new Error("Sharp addon did not load");',
      join(rootPath, addon),
    ],
    {
      env: windowsReplSystemEnvironment(process.env),
      signal,
      timeout: 30_000,
      windowsHide: true,
    },
  );

  const home = await mkdtemp(join(tmpdir(), "nodex-vendor-repl-"));
  try {
    await mkdir(windowsDesktopToolCodexHome(home), { recursive: true });
    const result = new BrowserUseThreadConfigBuilder({
      browserRuntime,
      codexHome: home,
      runtimeStateHome: home,
      windows: { jobLauncher: options.launcher, environment: process.env },
    }).buildResult();
    if (result.status !== "available") throw new Error(result.message);
    const server = result.config["mcp_servers.node_repl"] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    const transport = new StdioClientTransport(server);
    const client = new Client({ name: "Nodex native conformance", version: "1" });
    // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The installed-app CLI also owns this standalone native runtime.
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
    const request = { signal, timeout: 30_000 };
    const marker = "NODEX_WINDOWS_REPL_CONFORMANCE";
    const expectedRepl = normalize(browserRuntime.bundle.paths.nodeRepl).toLowerCase();
    let processes: WindowsProcessIdentity[];
    try {
      await client.connect(transport, request);
      if (!client.getServerVersion() || transport.pid === null)
        throw new Error("Windows REPL did not initialize");
      const tools = await client.listTools(undefined, request);
      if (!tools.tools.some(({ name }) => name === "js"))
        throw new Error("Windows REPL did not advertise js");
      const result = await client.callTool(
        { name: "js", arguments: { code: `nodeRepl.write("${marker}");` } },
        undefined,
        request,
      );
      if (
        result.isError ||
        !Array.isArray(result.content) ||
        !result.content.some((item) => item.type === "text" && item.text.includes(marker))
      )
        throw new Error(`Windows REPL js failed: ${JSON.stringify(result)}`);
      const launcher = await run(native.processIdentity(transport.pid));
      const descendants = await run(native.descendants(launcher));
      if (!descendants.some(({ imagePath }) => normalize(imagePath).toLowerCase() === expectedRepl))
        throw new Error("The packaged vendor REPL was not observed in the launcher job");
      processes = [launcher, ...descendants];
    } finally {
      await client.close();
    }
    const stopBy = Date.now() + 10_000;
    for (const identity of processes) {
      for (;;) {
        const current = await run(native.processIdentity(identity.pid).pipe(Effect.result));
        if (current._tag === "Success" && current.success.creationTime !== identity.creationTime)
          break;
        // An identity query can fail for reasons other than process exit.
        if (current._tag === "Failure" && !isProcessRunning(identity.pid)) break;
        if (Date.now() >= stopBy)
          throw new Error(`Windows Desktop Tool process survived close: ${identity.imagePath}`);
        await delay(50);
      }
    }
    return {
      status: "passed" as const,
      signedImages: Object.keys(manifest.trust.pe).length,
      processesClosed: processes.length,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
