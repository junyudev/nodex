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

export type CodexRuntimeSource = "bundled" | "staged";

export type ResolvedCodexRuntime = {
  additionalSearchPaths: string[];
  binaryPath: string;
  browserRuntime: BrowserRuntimeAvailability;
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
      if (artifact.executable && (stats.mode & 0o111) === 0) {
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

type ResolveCodexRuntimeOptions = {
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  signal?: AbortSignal;
  isPackaged: boolean;
  projectRootPath?: string;
  resourcesPath?: string;
};

async function resolveRuntimeFromRoot(input: {
  signal?: AbortSignal;
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  missingBinaryMessage: string;
  runtimeRoot: string;
  source: CodexRuntimeSource;
}): Promise<ResolvedCodexRuntime> {
  const metadataPath = path.join(input.runtimeRoot, AGENT_RUNTIME_METADATA_FILENAME);

  input.signal?.throwIfAborted();
  if (!(await fs.lstat(metadataPath).catch(() => null))) {
    throw new Error(`Agent runtime is missing or incomplete under ${input.runtimeRoot}`);
  }

  const metadata = await parseBundledRuntimeMetadata(metadataPath);
  await validateRuntimeArtifacts(input.runtimeRoot, metadata, input.signal);
  await validateRuntimeSearchPaths(input.runtimeRoot, metadata);
  const browserRuntime = await resolveBrowserRuntimeBundle({
    signal: input.signal,
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
  input.signal?.throwIfAborted();
  const primaryBinaryPath = path.join(input.runtimeRoot, ...metadata.entrypoint.split("/"));

  return {
    source: input.source,
    binaryPath: primaryBinaryPath,
    browserRuntime,
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
      browserRuntimePlatformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
      signal: options.signal,
      source: "staged",
      runtimeRoot: path.join(projectRootPath, ".generated", "codex-runtime", "agent-runtime"),
      missingBinaryMessage:
        "Pinned agent runtime is missing or incomplete. Run `pnpm run stage:codex-runtime:mac`.",
    });
  }

  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath) {
    throw new Error("Packaged Agent runtime resolution requires process.resourcesPath");
  }

  return resolveRuntimeFromRoot({
    browserRuntimePlatformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
    signal: options.signal,
    source: "bundled",
    runtimeRoot: resourcesPath,
    missingBinaryMessage: "Bundled agent runtime is missing or corrupted. Reinstall Nodex.",
  });
}

/** Startup cancellation waits for all file handles and native inspectors to close. */
export const resolveCodexRuntimeEffect = (
  options: Omit<ResolveCodexRuntimeOptions, "signal">,
): Effect.Effect<ResolvedCodexRuntime, Cause.UnknownError> =>
  Effect.callback((resume, signal) => {
    const pending = resolveCodexRuntime({ ...options, signal });
    pending.then(
      (runtime) => resume(Effect.succeed(runtime)),
      (cause) => resume(Effect.fail(new Cause.UnknownError(cause))),
    );
    return Effect.promise(() =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
  });
