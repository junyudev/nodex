import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  parseBrowserRuntimeManifest,
  type BrowserRuntimeArtifact,
  type BrowserRuntimeManifest,
} from "../../shared/browser-runtime-metadata";
import {
  isTestedBrowserAppServerPair,
  type AppServerRuntimeIdentity,
  type BrowserPeerRuntimeIdentity,
  type TestedBrowserAppServerPair,
} from "../../shared/browser-app-server-compatibility";

export type BrowserRuntimeUnavailableReason =
  | "artifact-integrity"
  | "artifact-invalid"
  | "artifact-missing"
  | "backend-unavailable"
  | "untested-runtime-pair"
  | "invalid-manifest"
  | "manifest-missing"
  | "module-directory-invalid"
  | "platform-verification-failed"
  | "target-mismatch";

export type VerifiedBrowserRuntimeBundle = {
  identity: BrowserPeerRuntimeIdentity;
  browserPluginMarketplaceRoot: string;
  browserPluginRoot: string;
  manifest: BrowserRuntimeManifest;
  manifestPath: string;
  nodeModuleDirs: string[];
  paths: {
    browserPluginClient: string;
    browserPluginDocs: string;
    browserPluginManifest: string;
    browserPluginService: string;
    chromeFamilyDescriptor: string | null;
    chromeInstallManifest: string | null;
    chromeNativeHost: string | null;
    chromePluginManifest: string | null;
    chromePluginRoot: string | null;
    codexCli: string;
    computerUseApp: string | null;
    computerUseClient: string | null;
    computerUsePluginRoot: string | null;
    computerUseRpcService: string | null;
    computerUseService: string | null;
    node: string;
    nodeRepl: string;
    peerAuthorization: string;
    skyNativeAddon: string;
  };
  rootPath: string;
};

export type BrowserRuntimeAvailability =
  | {
      message: string;
      reason: BrowserRuntimeUnavailableReason;
      status: "unavailable";
    }
  | {
      bundle: VerifiedBrowserRuntimeBundle;
      status: "available";
    };

type ResolveBrowserRuntimeBundleOptions = {
  appServerIdentity: AppServerRuntimeIdentity;
  platformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  runtimeRoot: string;
  targetArch?: NodeJS.Architecture;
  targetPlatform?: NodeJS.Platform;
  testedPairs?: readonly TestedBrowserAppServerPair[];
};

export type BrowserRuntimePlatformArtifactVerifier = (input: {
  artifact: BrowserRuntimeArtifact;
  artifactPath: string;
  manifest: BrowserRuntimeManifest;
}) => string | null;

function unavailable(
  reason: BrowserRuntimeUnavailableReason,
  message: string,
): BrowserRuntimeAvailability {
  return { message, reason, status: "unavailable" };
}

function resolveRelativePath(rootPath: string, relativePath: string): string {
  return path.join(rootPath, ...relativePath.split("/"));
}

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

function validateDirectoryPath(rootPath: string, relativePath: string): boolean {
  let currentPath = rootPath;
  for (const segment of relativePath.split("/")) {
    currentPath = path.join(currentPath, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch {
      return false;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  }
  return true;
}

function validateArtifact(
  rootPath: string,
  artifact: BrowserRuntimeArtifact,
): BrowserRuntimeAvailability | null {
  const segments = artifact.path.split("/");
  if (segments.length > 1 && !validateDirectoryPath(rootPath, segments.slice(0, -1).join("/"))) {
    return unavailable(
      "artifact-invalid",
      `Browser runtime artifact has an invalid parent directory: ${artifact.path}`,
    );
  }

  const artifactPath = resolveRelativePath(rootPath, artifact.path);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(artifactPath);
  } catch {
    return unavailable("artifact-missing", `Browser runtime artifact is missing: ${artifact.path}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return unavailable(
      "artifact-invalid",
      `Browser runtime artifact is not a regular file: ${artifact.path}`,
    );
  }
  if (artifact.executable && (stats.mode & 0o111) === 0) {
    return unavailable(
      "artifact-invalid",
      `Browser runtime artifact is not executable: ${artifact.path}`,
    );
  }
  if (stats.size !== artifact.size || readSha256(artifactPath) !== artifact.sha256) {
    return unavailable(
      "artifact-integrity",
      `Browser runtime artifact does not match its manifest: ${artifact.path}`,
    );
  }
  return null;
}

function readManifest(manifestPath: string): BrowserRuntimeManifest | null {
  try {
    return parseBrowserRuntimeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch {
    return null;
  }
}

export function resolveBrowserRuntimeBundle(
  options: ResolveBrowserRuntimeBundleOptions,
): BrowserRuntimeAvailability {
  const rootPath = path.join(options.runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifestPath = path.join(rootPath, BROWSER_RUNTIME_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return unavailable(
      "manifest-missing",
      `Browser runtime bundle is unavailable: ${BROWSER_RUNTIME_MANIFEST_FILENAME} is missing`,
    );
  }

  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(rootPath);
  } catch {
    return unavailable("manifest-missing", "Browser runtime bundle directory is missing");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return unavailable("invalid-manifest", "Browser runtime bundle directory is invalid");
  }
  let manifestStats: fs.Stats;
  try {
    manifestStats = fs.lstatSync(manifestPath);
  } catch {
    return unavailable("manifest-missing", "Browser runtime bundle manifest is missing");
  }
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    return unavailable("invalid-manifest", "Browser runtime bundle manifest is not a regular file");
  }

  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return unavailable("invalid-manifest", "Browser runtime bundle manifest is invalid");
  }
  if (
    manifest.targetPlatform !== (options.targetPlatform ?? process.platform) ||
    manifest.targetArch !== (options.targetArch ?? process.arch)
  ) {
    return unavailable(
      "target-mismatch",
      "Browser runtime bundle does not match the active platform and architecture",
    );
  }

  const browserIdentity: BrowserPeerRuntimeIdentity = {
    browserPluginVersion: manifest.browserPlugin.version,
    manifestSha256: readSha256(manifestPath),
    peerCliVersion: manifest.runtimeVersions.codexCli,
    targetArch: manifest.targetArch,
    targetPlatform: manifest.targetPlatform,
  };
  if (
    !isTestedBrowserAppServerPair(options.appServerIdentity, browserIdentity, options.testedPairs)
  ) {
    return unavailable(
      "untested-runtime-pair",
      `Browser runtime pair has no conformance record: app-server ${options.appServerIdentity.runtimeVersion}/${options.appServerIdentity.targetArch} (${options.appServerIdentity.entrypointSha256}), Browser ${browserIdentity.browserPluginVersion}/${browserIdentity.targetArch} (${browserIdentity.manifestSha256})`,
    );
  }

  for (const artifact of manifest.artifacts) {
    const failure = validateArtifact(rootPath, artifact);
    if (failure) return failure;
    if (artifact.kind === "data" || !options.platformArtifactVerifier) continue;
    let verificationMessage: string | null;
    try {
      verificationMessage = options.platformArtifactVerifier({
        artifact,
        artifactPath: resolveRelativePath(rootPath, artifact.path),
        manifest,
      });
    } catch (error) {
      verificationMessage = error instanceof Error ? error.message : String(error);
    }
    if (verificationMessage) {
      return unavailable(
        "platform-verification-failed",
        `Browser runtime platform verification failed for ${artifact.path}: ${verificationMessage}`,
      );
    }
  }
  for (const nodeModuleDir of manifest.browserPlugin.nodeModuleDirs) {
    if (!validateDirectoryPath(rootPath, nodeModuleDir)) {
      return unavailable(
        "module-directory-invalid",
        `Browser runtime Node module directory is invalid: ${nodeModuleDir}`,
      );
    }
  }
  if (manifest.capabilities.computerUse.status === "available") {
    for (const nodeModuleDir of manifest.capabilities.computerUse.plugin.nodeModuleDirs) {
      if (validateDirectoryPath(rootPath, nodeModuleDir)) continue;
      return unavailable(
        "module-directory-invalid",
        `Computer Use runtime Node module directory is invalid: ${nodeModuleDir}`,
      );
    }
  }

  const resolve = (relativePath: string): string => resolveRelativePath(rootPath, relativePath);
  const chrome = manifest.capabilities.browserUse.backends.chrome;
  return {
    status: "available",
    bundle: {
      identity: browserIdentity,
      browserPluginMarketplaceRoot: resolve(manifest.browserPlugin.marketplaceRoot),
      browserPluginRoot: resolve(manifest.browserPlugin.root),
      manifest,
      manifestPath,
      nodeModuleDirs: [
        ...new Set([
          ...manifest.browserPlugin.nodeModuleDirs,
          ...(manifest.capabilities.computerUse.status === "available"
            ? manifest.capabilities.computerUse.plugin.nodeModuleDirs
            : []),
        ]),
      ].map(resolve),
      paths: {
        browserPluginClient: resolve(manifest.browserPlugin.client),
        browserPluginDocs: resolve(manifest.browserPlugin.docs),
        browserPluginManifest: resolve(manifest.browserPlugin.manifest),
        browserPluginService: resolve(manifest.browserPlugin.service),
        chromeFamilyDescriptor:
          chrome.status === "available" ? resolve(chrome.familyDescriptor) : null,
        chromeInstallManifest:
          chrome.status === "available" ? resolve(chrome.installManifest) : null,
        chromeNativeHost: chrome.status === "available" ? resolve(chrome.nativeHost.path) : null,
        chromePluginManifest:
          chrome.status === "available" ? resolve(chrome.plugin.manifest) : null,
        chromePluginRoot: chrome.status === "available" ? resolve(chrome.plugin.root) : null,
        codexCli: resolve(manifest.entrypoints.codexCli),
        computerUseApp:
          manifest.capabilities.computerUse.status === "available"
            ? resolve(manifest.capabilities.computerUse.appBundle)
            : null,
        computerUseClient:
          manifest.capabilities.computerUse.status === "available"
            ? resolve(manifest.capabilities.computerUse.client)
            : null,
        computerUsePluginRoot:
          manifest.capabilities.computerUse.status === "available"
            ? resolve(manifest.capabilities.computerUse.plugin.root)
            : null,
        computerUseRpcService:
          manifest.capabilities.computerUse.status === "available"
            ? resolve(manifest.capabilities.computerUse.rpcService)
            : null,
        computerUseService:
          manifest.capabilities.computerUse.status === "available"
            ? resolve(manifest.capabilities.computerUse.serviceExecutable)
            : null,
        node: resolve(manifest.entrypoints.node),
        nodeRepl: resolve(manifest.entrypoints.nodeRepl),
        peerAuthorization: resolve(manifest.entrypoints.peerAuthorization),
        skyNativeAddon: resolve(manifest.capabilities.nativePip.addon),
      },
      rootPath,
    },
  };
}
