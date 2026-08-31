import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
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
  runtimeFamily: "codex-app-server";
  source: CodexRuntimeSource;
  version: string | null;
};

function readSha256(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fileDescriptor = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function validateRuntimeArtifacts(
  runtimeRoot: string,
  metadata: BundledAgentRuntimeMetadata,
): void {
  for (const artifact of metadata.artifacts) {
    const artifactPath = path.join(runtimeRoot, ...artifact.path.split("/"));
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(artifactPath);
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
    if (readSha256(artifactPath) !== artifact.sha256) {
      throw new Error(`Agent runtime artifact checksum does not match metadata: ${artifact.path}`);
    }
  }
}

function validateRuntimeSearchPaths(
  runtimeRoot: string,
  metadata: BundledAgentRuntimeMetadata,
): void {
  for (const searchPath of metadata.searchPaths) {
    const searchPathRoot = path.join(runtimeRoot, ...searchPath.split("/"));
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(searchPathRoot);
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
  isPackaged: boolean;
  projectRootPath?: string;
  resourcesPath?: string;
};

function resolveRuntimeFromRoot(input: {
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  missingBinaryMessage: string;
  runtimeRoot: string;
  source: CodexRuntimeSource;
}): ResolvedCodexRuntime {
  const metadataPath = path.join(input.runtimeRoot, AGENT_RUNTIME_METADATA_FILENAME);

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Agent runtime is missing or incomplete under ${input.runtimeRoot}`);
  }

  const metadata = parseBundledRuntimeMetadata(metadataPath);
  validateRuntimeArtifacts(input.runtimeRoot, metadata);
  validateRuntimeSearchPaths(input.runtimeRoot, metadata);
  const browserRuntime = resolveBrowserRuntimeBundle({
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

function parseBundledRuntimeMetadata(metadataPath: string): BundledAgentRuntimeMetadata {
  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error(`Invalid bundled Agent runtime metadata at ${metadataPath}`);
  }
  const parsed = parseBundledAgentRuntimeMetadata(rawMetadata);
  if (!parsed) {
    throw new Error(`Invalid bundled Agent runtime metadata at ${metadataPath}`);
  }
  return parsed;
}

export function resolveCodexRuntime(options: ResolveCodexRuntimeOptions): ResolvedCodexRuntime {
  if (!options.isPackaged) {
    const projectRootPath = options.projectRootPath?.trim();
    if (!projectRootPath) {
      throw new Error("Unpackaged Agent runtime resolution requires a project root path");
    }

    return resolveRuntimeFromRoot({
      browserRuntimePlatformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
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
    source: "bundled",
    runtimeRoot: resourcesPath,
    missingBinaryMessage: "Bundled agent runtime is missing or corrupted. Reinstall Nodex.",
  });
}
