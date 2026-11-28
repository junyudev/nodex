import release from "../../../resources/agent-runtime/codex-app-server.lock.json";
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
import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import {
  AGENT_RUNTIME_METADATA_FILENAME,
  parseBundledAgentRuntimeMetadata,
  type BundledAgentRuntimeMetadata,
} from "../../shared/codex-runtime-metadata";
import {
  projectBundledAppServerRuntimeIdentity,
  type AppServerRuntimeIdentity,
  type TestedBrowserAppServerPair,
} from "../../shared/browser-app-server-compatibility";
import {
  resolveBrowserRuntimeBundle,
  type BrowserRuntimeAvailability,
  type BrowserRuntimePlatformArtifactVerifier,
  type VerifiedBrowserRuntimeBundle,
} from "./browser-runtime-bundle";
import { createBrowserRuntimePlatformArtifactVerifier } from "./browser-runtime-platform-verifier";
import {
  codexCrtDirectories,
  codexPackageFileMode,
  windowsCodexCrtFiles,
  verifyCodexPackageMetadataPin,
  type CodexPackagePin,
} from "../platform/node/stage-codex-package";
import { inventoryRegularFiles, sha256File } from "../platform/node/pinned-tar-archive";
import { appComponentDefinition, appComponentHome } from "../app-components/AppComponentCatalog";
import {
  appComponentRoot,
  hasAppComponentTombstone,
  installedAppComponentRoot,
  verifyAppComponentDirectory,
} from "../app-components/AppComponentStore";

export type CodexRuntimeSource = "bundled" | "staged" | "component";

export type VerifiedCodexPackage = {
  additionalSearchPaths: string[];
  binaryPath: string;
  readonly appServerIdentity: AppServerRuntimeIdentity;
  appServerRuntimeVersion: string;
  metadataPath: string;
  missingBinaryMessage: string;
  rootPath: string;
  runtimeFamily: "codex";
  source: CodexRuntimeSource;
  version: string;
};

export type DesktopToolsRuntime = {
  readonly browserRuntime: BrowserRuntimeAvailability;
  /** The one activation lane and readiness signal for runtimes that can appear after startup. */
  readonly browserRuntimeActivation?: {
    readonly source: "component" | "runtime-root";
    readonly activate: Effect.Effect<BrowserRuntimeAvailability, Cause.UnknownError>;
    readonly available: Effect.Effect<VerifiedBrowserRuntimeBundle>;
  };
};

export type ResolvedCodexRuntime = VerifiedCodexPackage & DesktopToolsRuntime;

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
  readonly verifyTransport: (signal?: AbortSignal) => Promise<void>;
}

type ResolveCodexRuntimeOptions = {
  /** Explicit pair for the live conformance probe. Normal application resolution uses the catalog. */
  conformanceCandidatePair?: TestedBrowserAppServerPair;
  deferWindowsBrowserRuntime?: DeferredWindowsBrowserRuntime;
  platform?: string;
  architecture?: string;
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  windowsBrowserRuntimeVerifier?: WindowsBrowserRuntimeVerifierPort;
  windowsComponentBrowserRuntimeVerifier?: WindowsBrowserRuntimeVerifierPort;
  signal?: AbortSignal;
  isPackaged: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  nodexHome?: string;
  headless?: boolean;
  appBuildVersion?: string;
  projectRootPath?: string;
  resourcesPath?: string;
};

export function pinnedCodexAppServerIdentity(
  platform: string,
  arch: string,
): AppServerRuntimeIdentity | undefined {
  const target = `${platform}-${arch}`;
  if (target !== "darwin-arm64" && target !== "win32-arm64" && target !== "win32-x64")
    return undefined;
  return {
    entrypointSha256: release.builds[target].entrypointSha256,
    protocolSchemaFingerprint: release.protocolSchema.sha256,
    runtimeVersion: release.appServerRuntimeVersion,
    sourceCommit: release.upstream.commit,
    targetPlatform: platform,
    targetArch: arch,
  };
}

export function matchesPinnedCodexAppServerIdentity(
  actual: AppServerRuntimeIdentity | undefined,
  platform: string,
  arch: string,
): boolean {
  const pin = pinnedCodexAppServerIdentity(platform, arch);
  return (
    !!pin &&
    !!actual &&
    actual.entrypointSha256 === pin.entrypointSha256 &&
    actual.protocolSchemaFingerprint === pin.protocolSchemaFingerprint &&
    actual.runtimeVersion === pin.runtimeVersion &&
    actual.sourceCommit === pin.sourceCommit &&
    actual.targetPlatform === pin.targetPlatform &&
    actual.targetArch === pin.targetArch
  );
}

export function localCodexPackageLocation(options: ResolveCodexRuntimeOptions) {
  if (!options.isPackaged) {
    const projectRootPath = options.projectRootPath?.trim();
    if (!projectRootPath)
      throw new Error("Unpackaged Agent runtime resolution requires a project root path");
    return {
      rootPath: path.resolve(projectRootPath, ".generated", "codex-runtime", "agent-runtime"),
      source: "staged" as const,
      missingBinaryMessage:
        "Pinned agent runtime is missing or incomplete. Prepare the Agent runtime for this host.",
    };
  }
  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath)
    throw new Error("Packaged Agent runtime resolution requires process.resourcesPath");
  return {
    rootPath: path.resolve(resourcesPath),
    source: "bundled" as const,
    missingBinaryMessage: "Bundled agent runtime is missing or corrupted. Reinstall Nodex.",
  };
}

export type CodexPackageLocation = {
  readonly rootPath: string;
  readonly source: CodexRuntimeSource;
  readonly missingBinaryMessage: string;
  readonly pin?: CodexPackagePin;
  readonly crtDirectories?: readonly string[];
  readonly verifyRoot?: (directory: string) => Promise<void>;
};

/** Choose the package source for this target and the selected Profile. */
export function codexPackageLocation(options: ResolveCodexRuntimeOptions): CodexPackageLocation {
  const target = {
    ...options,
    platform: options.platform ?? "",
    arch: options.architecture ?? "",
  };
  const definition = appComponentDefinition(target, "codex");
  if (definition?.payload.kind !== "codex") return localCodexPackageLocation(options);
  if (!options.nodexHome) throw new Error("Resolving the Codex Component requires a Profile.");
  const home = appComponentHome({ ...options, nodexHome: options.nodexHome });
  return {
    rootPath: appComponentRoot(home, definition),
    source: "component",
    missingBinaryMessage: "Codex is not installed.",
    pin: definition.payload,
    crtDirectories: codexCrtDirectories(options),
    verifyRoot: (directory) => verifyAppComponentDirectory({ home, target }, directory),
  };
}

export async function verifyCodexPackage(
  location: CodexPackageLocation,
  input: Pick<ResolveCodexRuntimeOptions, "platform" | "architecture" | "signal">,
): Promise<VerifiedCodexPackage> {
  const metadataPath = path.join(location.rootPath, AGENT_RUNTIME_METADATA_FILENAME);
  input.signal?.throwIfAborted();
  if (!(await fs.lstat(metadataPath).catch(() => null)))
    throw new Error(
      location.source === "component"
        ? location.missingBinaryMessage
        : `Agent runtime is missing or incomplete under ${location.rootPath}`,
    );
  if (location.pin && !(await fs.lstat(location.rootPath)).isDirectory())
    throw new Error("Installed Codex package root must be a directory.");
  await location.verifyRoot?.(location.rootPath);
  const metadata = await parseBundledRuntimeMetadata(metadataPath);
  if (
    (input.platform !== undefined && metadata.targetPlatform !== input.platform) ||
    (input.architecture !== undefined && metadata.targetArch !== input.architecture)
  )
    throw new Error("Agent runtime target does not match this host.");
  if (location.pin) {
    verifyCodexPackageMetadataPin(metadata, location.pin);
    const windows = metadata.targetPlatform === "win32";
    const files = await inventoryRegularFiles(
      location.rootPath,
      input.signal,
      metadata.artifacts.map(({ path }) => path),
    );
    const document = files.get(AGENT_RUNTIME_METADATA_FILENAME);
    const receipt = files.get(".installed-size");
    files.delete(AGENT_RUNTIME_METADATA_FILENAME);
    files.delete(".installed-size");
    if (
      !document ||
      !receipt ||
      receipt.size !== 8 ||
      (!windows && ((document.mode & 0o7777) !== 0o644 || (receipt.mode & 0o7777) !== 0o600))
    ) {
      throw new Error("Installed Codex package has an unexpected metadata file or receipt.");
    }
    for (const { path, executable } of metadata.artifacts) {
      const file = files.get(path);
      if (!file || (!windows && (file.mode & 0o7777) !== codexPackageFileMode(executable))) {
        throw new Error("Installed Codex package has an unexpected file or mode.");
      }
      files.delete(path);
    }
    await validateRuntimeArtifacts(location.rootPath, metadata, input.signal);
    for (const { source, destination } of windowsCodexCrtFiles(
      location.rootPath,
      metadata,
      location.crtDirectories ?? [],
    )) {
      if (
        !files.delete(destination) ||
        (await sha256File(path.join(location.rootPath, destination), input.signal)) !==
          (await sha256File(source, input.signal))
      ) {
        throw new Error("Installed Codex package has an invalid Windows runtime library.");
      }
    }
    if (files.size !== 0) throw new Error("Installed Codex package has unexpected files.");
  } else {
    await validateRuntimeArtifacts(location.rootPath, metadata, input.signal);
  }
  await validateRuntimeSearchPaths(location.rootPath, metadata);
  input.signal?.throwIfAborted();
  const { pin: _, ...resolved } = location;
  return {
    ...resolved,
    binaryPath: path.join(location.rootPath, ...metadata.entrypoint.split("/")),
    appServerIdentity: {
      ...projectBundledAppServerRuntimeIdentity(metadata),
      // Pair Desktop Tools with the digest we verified, even in a disposable staged runtime.
      entrypointSha256: metadata.artifacts.find(({ path }) => path === metadata.entrypoint)!.sha256,
    },
    additionalSearchPaths: metadata.searchPaths.map((searchPath) =>
      path.join(location.rootPath, ...searchPath.split("/")),
    ),
    appServerRuntimeVersion: metadata.appServerRuntimeVersion,
    runtimeFamily: metadata.runtimeFamily,
    version: metadata.appServerRuntimeVersion,
    metadataPath,
  };
}

async function resolveDesktopTools(
  input: ResolveCodexRuntimeOptions & {
    readonly runtimeRoot: string;
    readonly appServerIdentity: AppServerRuntimeIdentity | undefined;
  },
): Promise<DesktopToolsRuntime> {
  const { appServerIdentity } = input;
  if (!appServerIdentity)
    return {
      browserRuntime: {
        status: "unavailable",
        reason: "target-mismatch",
        message: "Desktop Tools are unavailable on this host.",
      },
    };
  const loadBrowserRuntime = (
    runtimeRoot: string,
    signal?: AbortSignal,
    source?: { readonly manifestSha256: string },
  ) =>
    resolveBrowserRuntimeBundle({
      signal,
      expectedManifestSha256: source?.manifestSha256,
      windowsVerifier: source
        ? input.windowsComponentBrowserRuntimeVerifier
        : input.windowsBrowserRuntimeVerifier,
      verifyWindowsTransport: input.deferWindowsBrowserRuntime?.verifyTransport,
      appServerIdentity,
      platformArtifactVerifier:
        input.browserRuntimePlatformArtifactVerifier ??
        createBrowserRuntimePlatformArtifactVerifier({
          platform: appServerIdentity.targetPlatform as NodeJS.Platform,
        }),
      runtimeRoot,
      targetArch: appServerIdentity.targetArch as NodeJS.Architecture,
      targetPlatform: appServerIdentity.targetPlatform as NodeJS.Platform,
      testedPairs: input.conformanceCandidatePair ? [input.conformanceCandidatePair] : undefined,
    });
  const target = {
    platform: appServerIdentity.targetPlatform,
    arch: appServerIdentity.targetArch,
    isPackaged: input.isPackaged,
    headless: input.headless,
    environment: input.environment,
    resourcesPath: input.resourcesPath,
    projectRootPath: input.projectRootPath,
  };
  const component = appComponentDefinition(target, "desktop-tools");
  const componentPin = component?.payload.kind === "desktop-tools" ? component.payload : undefined;
  const store = input.nodexHome ? { home: input.nodexHome, target } : null;
  const notInstalled = {
    status: "unavailable",
    reason: "not-installed",
    message: "Install Desktop Tools to use Browser and Computer Use.",
  } as const;
  const loadComponent = async (signal?: AbortSignal): Promise<BrowserRuntimeAvailability> => {
    if (!store || !componentPin) return notInstalled;
    const root = await installedAppComponentRoot({ ...store, id: "desktop-tools", signal });
    return root ? loadBrowserRuntime(root, signal, componentPin) : notInstalled;
  };
  const deferredWindows =
    appServerIdentity.targetPlatform === "win32" ? input.deferWindowsBrowserRuntime : undefined;
  const loadRuntimeRoot = async (signal?: AbortSignal): Promise<BrowserRuntimeAvailability> => {
    try {
      return await loadBrowserRuntime(input.runtimeRoot, signal);
    } catch (error) {
      if (!deferredWindows) throw error;
      signal?.throwIfAborted();
      return {
        status: "unavailable",
        reason: "platform-verification-failed",
        message: `Windows Desktop Tools could not initialize: ${String(error)}`,
      };
    }
  };
  let browserRuntime: BrowserRuntimeAvailability = component
    ? deferredWindows
      ? notInstalled
      : await loadComponent(input.signal)
    : deferredWindows
      ? {
          status: "unavailable",
          reason: "platform-verification-failed",
          message: "Windows Desktop Tool verification is pending",
        }
      : await loadRuntimeRoot(input.signal);
  const available = Deferred.makeUnsafe<VerifiedBrowserRuntimeBundle>();
  if (browserRuntime.status === "available")
    Deferred.doneUnsafe(available, Effect.succeed(browserRuntime.bundle));
  const activationGate = Semaphore.makeUnsafe(1);
  const browserRuntimeActivation: ResolvedCodexRuntime["browserRuntimeActivation"] =
    component || deferredWindows
      ? {
          source: component ? "component" : "runtime-root",
          activate: activationGate.withPermits(1)(
            Effect.gen(function* () {
              if (browserRuntime.status === "available") return browserRuntime;
              const result = yield* runRuntimeResolution(
                component ? loadComponent : loadRuntimeRoot,
              );
              if (result.status === "available" || !component) browserRuntime = result;
              if (result.status === "available")
                Deferred.doneUnsafe(available, Effect.succeed(result.bundle));
              return result;
            }),
          ),
          available: Deferred.await(available),
        }
      : undefined;
  input.signal?.throwIfAborted();
  return {
    get browserRuntime() {
      return browserRuntime;
    },
    browserRuntimeActivation,
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

/** Conformance tools explicitly require both the executable package and its Desktop Tools pair. */
export async function resolveCodexRuntime(
  options: ResolveCodexRuntimeOptions,
): Promise<ResolvedCodexRuntime> {
  const location = codexPackageLocation(options);
  if (
    location.source === "component" &&
    (await hasAppComponentTombstone(
      appComponentHome({ ...options, nodexHome: options.nodexHome! }),
      "codex",
    ))
  )
    throw new Error("Codex is turned off in Settings → General → Add-ons.");
  const runtime = await verifyCodexPackage(location, options);
  const desktop = await resolveDesktopTools({
    ...options,
    runtimeRoot: localCodexPackageLocation(options).rootPath,
    appServerIdentity: runtime.appServerIdentity,
  });
  return {
    ...runtime,
    get browserRuntime() {
      return desktop.browserRuntime;
    },
    browserRuntimeActivation: desktop.browserRuntimeActivation,
  };
}

export const resolveDesktopToolsEffect = (options: Omit<ResolveCodexRuntimeOptions, "signal">) =>
  runRuntimeResolution((signal) =>
    resolveDesktopTools({
      ...options,
      signal,
      runtimeRoot: localCodexPackageLocation(options).rootPath,
      appServerIdentity: pinnedCodexAppServerIdentity(
        options.platform ?? "",
        options.architecture ?? "",
      ),
    }),
  );

/** Cancellation waits for opened files and native inspectors to close. */
export const runRuntimeResolution = <A>(
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
