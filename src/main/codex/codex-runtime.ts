import type { WindowsBrowserRuntimeVerifierPort } from "./browser-runtime-windows-verifier-port";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import {
  readRuntimeArtifactSha256,
  verifyRuntimeArtifacts,
} from "../platform/node/RuntimeArtifactVerification";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import {
  AGENT_RUNTIME_METADATA_FILENAME,
  parseBundledAgentRuntimeMetadata,
  type BundledAgentRuntimeMetadata,
} from "../../shared/codex-runtime-metadata";
import { projectBundledAppServerRuntimeIdentity } from "../../shared/browser-app-server-compatibility";
import {
  resolveBrowserRuntimeBundle,
  type BrowserRuntimeAvailability,
  type BrowserRuntimePlatformArtifactVerifier,
} from "./browser-runtime-bundle";
import { createBrowserRuntimePlatformArtifactVerifier } from "./browser-runtime-platform-verifier";
import {
  resolveNodeExecutionRuntime,
  type NodeExecutionRuntime,
} from "../platform/node/NodeExecutionRuntime";

export type CodexRuntimeSource = "bundled" | "staged";

export type ResolvedCodexRuntime = {
  additionalSearchPaths: string[];
  binaryPath: string;
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly prepareBrowserRuntime?: Effect.Effect<void, Cause.UnknownError>;
  nodeRuntime: NodeExecutionRuntime;
  appServerRuntimeVersion: string | null;
  metadataPath: string | null;
  missingBinaryMessage: string;
  rootPath: string;
  runtimeFamily: "codex";
  source: CodexRuntimeSource;
  version: string | null;
};

async function validateRuntimeArtifacts(
  runtimeRoot: string,
  metadata: BundledAgentRuntimeMetadata,
  signal?: AbortSignal,
): Promise<void> {
  await verifyRuntimeArtifacts(
    metadata.artifacts,
    async (artifact) => {
      const artifactPath = path.join(runtimeRoot, ...artifact.path.split("/"));
      let stats: Stats;
      try {
        stats = await fs.lstat(artifactPath);
      } catch {
        throw new Error(`Agent runtime artifact is missing: ${artifact.path}`);
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Agent runtime artifact is not a regular file: ${artifact.path}`);
      }
      if (stats.size !== artifact.size) {
        throw new Error(`Agent runtime artifact size does not match metadata: ${artifact.path}`);
      }
      if (
        artifact.executable &&
        metadata.targetPlatform !== "win32" &&
        process.platform !== "win32" &&
        (stats.mode & 0o111) === 0
      ) {
        throw new Error(`Agent runtime artifact is not executable: ${artifact.path}`);
      }
      if ((await readRuntimeArtifactSha256(artifactPath, signal)) !== artifact.sha256) {
        throw new Error(
          `Agent runtime artifact checksum does not match metadata: ${artifact.path}`,
        );
      }
    },
    signal,
  );
}

async function validateRuntimeSearchPaths(
  runtimeRoot: string,
  metadata: BundledAgentRuntimeMetadata,
): Promise<void> {
  for (const searchPath of metadata.searchPaths) {
    const searchPathRoot = path.join(runtimeRoot, ...searchPath.split("/"));
    let stats: Stats;
    try {
      stats = await fs.lstat(searchPathRoot);
    } catch {
      throw new Error(`Agent runtime search path is missing: ${searchPath}`);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Agent runtime search path is not a regular directory: ${searchPath}`);
    }
  }
}

interface DeferredWindowsBrowserRuntime {
  readonly verifyTransport: (signal: AbortSignal) => Promise<void>;
}

type ResolveCodexRuntimeOptions = {
  deferWindowsBrowserRuntime?: DeferredWindowsBrowserRuntime;
  platform?: string;
  architecture?: string;
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  windowsBrowserRuntimeVerifier?: WindowsBrowserRuntimeVerifierPort;
  signal?: AbortSignal;
  isPackaged: boolean;
  projectRootPath?: string;
  resourcesPath?: string;
};

async function resolveRuntimeFromRoot(input: {
  deferWindowsBrowserRuntime?: DeferredWindowsBrowserRuntime;
  platform?: string;
  architecture?: string;
  signal?: AbortSignal;
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  windowsBrowserRuntimeVerifier?: WindowsBrowserRuntimeVerifierPort;
  missingBinaryMessage: string;
  runtimeRoot: string;
  nodeRuntimeRoot: string;
  source: CodexRuntimeSource;
}): Promise<ResolvedCodexRuntime> {
  const metadataPath = path.join(input.runtimeRoot, AGENT_RUNTIME_METADATA_FILENAME);

  input.signal?.throwIfAborted();
  if (!(await fs.lstat(metadataPath).catch(() => null))) {
    throw new Error(`Agent runtime is missing or incomplete under ${input.runtimeRoot}`);
  }

  const metadata = await parseBundledRuntimeMetadata(metadataPath);
  if (
    (input.platform !== undefined && metadata.targetPlatform !== input.platform) ||
    (input.architecture !== undefined && metadata.targetArch !== input.architecture)
  )
    throw new Error("Agent runtime target does not match this host.");
  await validateRuntimeArtifacts(input.runtimeRoot, metadata, input.signal);
  await validateRuntimeSearchPaths(input.runtimeRoot, metadata);
  const loadBrowserRuntime = (signal?: AbortSignal) =>
    resolveBrowserRuntimeBundle({
      signal,
      windowsVerifier: input.windowsBrowserRuntimeVerifier,
      appServerIdentity: projectBundledAppServerRuntimeIdentity(metadata),
      platformArtifactVerifier:
        input.browserRuntimePlatformArtifactVerifier ??
        createBrowserRuntimePlatformArtifactVerifier({
          platform: metadata.targetPlatform as NodeJS.Platform,
        }),
      runtimeRoot: input.runtimeRoot,
      targetArch: metadata.targetArch as NodeJS.Architecture,
      targetPlatform: metadata.targetPlatform as NodeJS.Platform,
    });
  const deferred =
    metadata.targetPlatform === "win32" ? input.deferWindowsBrowserRuntime : undefined;
  let browserRuntime: BrowserRuntimeAvailability = deferred
    ? {
        status: "unavailable",
        reason: "platform-verification-failed",
        message: "Windows Desktop Tool verification is pending",
      }
    : await loadBrowserRuntime(input.signal);
  const prepareBrowserRuntime = deferred
    ? async (signal: AbortSignal) => {
        try {
          const result = await loadBrowserRuntime(signal);
          if (result.status === "available") await deferred.verifyTransport(signal);
          signal.throwIfAborted();
          browserRuntime = result;
        } catch (error) {
          signal.throwIfAborted();
          browserRuntime = {
            status: "unavailable",
            reason: "platform-verification-failed",
            message: `Windows Desktop Tools could not initialize: ${String(error)}`,
          };
        }
      }
    : undefined;
  input.signal?.throwIfAborted();
  const primaryBinaryPath = path.join(input.runtimeRoot, ...metadata.entrypoint.split("/"));
  const nodeRuntime = await resolveNodeExecutionRuntime({
    platform: metadata.targetPlatform,
    architecture: metadata.targetArch,
    directory:
      input.source === "staged"
        ? path.join(input.nodeRuntimeRoot, `win32-${metadata.targetArch}`)
        : input.nodeRuntimeRoot,
    browserRuntime,
    signal: input.signal,
  });

  return {
    source: input.source,
    binaryPath: primaryBinaryPath,
    get browserRuntime() {
      return browserRuntime;
    },
    prepareBrowserRuntime: prepareBrowserRuntime
      ? runRuntimeResolution(prepareBrowserRuntime)
      : undefined,
    nodeRuntime,
    additionalSearchPaths: metadata.searchPaths.map((searchPath) =>
      path.join(input.runtimeRoot, ...searchPath.split("/")),
    ),
    appServerRuntimeVersion: metadata.appServerRuntimeVersion,
    runtimeFamily: metadata.runtimeFamily,
    version: metadata.appServerRuntimeVersion,
    metadataPath,
    missingBinaryMessage: input.missingBinaryMessage,
    rootPath: input.runtimeRoot,
  };
}

async function parseBundledRuntimeMetadata(
  metadataPath: string,
): Promise<BundledAgentRuntimeMetadata> {
  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch {
    throw new Error(`Invalid bundled Agent runtime metadata at ${metadataPath}`);
  }
  const parsed = parseBundledAgentRuntimeMetadata(rawMetadata);
  if (!parsed) {
    throw new Error(`Invalid bundled Agent runtime metadata at ${metadataPath}`);
  }
  return parsed;
}

export async function resolveCodexRuntime(
  options: ResolveCodexRuntimeOptions,
): Promise<ResolvedCodexRuntime> {
  options.signal?.throwIfAborted();
  if (!options.isPackaged) {
    const projectRootPath = options.projectRootPath?.trim();
    if (!projectRootPath) {
      throw new Error("Unpackaged Agent runtime resolution requires a project root path");
    }

    return resolveRuntimeFromRoot({
      platform: options.platform,
      architecture: options.architecture,
      browserRuntimePlatformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
      windowsBrowserRuntimeVerifier: options.windowsBrowserRuntimeVerifier,
      deferWindowsBrowserRuntime: options.deferWindowsBrowserRuntime,
      signal: options.signal,
      source: "staged",
      runtimeRoot: path.join(projectRootPath, ".generated", "codex-runtime", "agent-runtime"),
      nodeRuntimeRoot: path.join(projectRootPath, ".generated", "node-runtime"),
      missingBinaryMessage:
        "Pinned agent runtime is missing or incomplete. Prepare the Agent runtime for this host.",
    });
  }

  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath) {
    throw new Error("Packaged Agent runtime resolution requires process.resourcesPath");
  }

  return resolveRuntimeFromRoot({
    platform: options.platform,
    architecture: options.architecture,
    browserRuntimePlatformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
    windowsBrowserRuntimeVerifier: options.windowsBrowserRuntimeVerifier,
    deferWindowsBrowserRuntime: options.deferWindowsBrowserRuntime,
    signal: options.signal,
    source: "bundled",
    runtimeRoot: resourcesPath,
    nodeRuntimeRoot: path.join(resourcesPath, "node-runtime"),
    missingBinaryMessage: "Bundled agent runtime is missing or corrupted. Reinstall Nodex.",
  });
}

/** Cancellation waits for opened files and native inspectors to close. */
const runRuntimeResolution = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, Cause.UnknownError> =>
  Effect.callback((resume, signal) => {
    const pending = operation(signal);
    pending.then(
      (result) => resume(Effect.succeed(result)),
      (cause) => resume(Effect.fail(new Cause.UnknownError(cause))),
    );
    return Effect.promise(() =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
  });

export const resolveCodexRuntimeEffect = (
  options: Omit<ResolveCodexRuntimeOptions, "signal">,
): Effect.Effect<ResolvedCodexRuntime, Cause.UnknownError> =>
  runRuntimeResolution((signal) => resolveCodexRuntime({ ...options, signal }));
