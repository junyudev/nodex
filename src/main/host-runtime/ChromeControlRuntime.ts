import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserUsePeerAuthorizationMode } from "../../shared/browser-use-host-capability";
import { BROWSER_PLUGIN_NODE_MODULE_DIR } from "../../shared/browser-runtime-metadata";
import type { ChromeControlRuntimeSnapshot } from "../../shared/chrome-control-settings";
import {
  loadChromeBrowserAuthority,
  type ChromeBrowserAuthority,
} from "../browser-use/chrome/ChromeBrowserFamilyRegistry";
import {
  ChromeExtensionPipeRegistry,
  type ChromeExtensionFocusInput,
  type ChromeExtensionInstanceSnapshot,
  type ChromeExtensionPipeRegistrySnapshot,
  type ChromeNativeHostPeerIdentity,
} from "../browser-use/chrome/ChromeExtensionPipeRegistry";
import {
  installChromeNativeHost,
  readChromeNativeHostIdentity,
  type ChromeNativeHostInstallResult,
} from "../browser-use/chrome/ChromeNativeHostInstaller";
import { createBrowserUsePeerAuthorizer } from "../browser-use/browser-use-peer-authorizer";
import type {
  BrowserRuntimeAvailability,
  VerifiedBrowserRuntimeBundle,
} from "../codex/browser-runtime-bundle";
import { createBrowserRuntimePlatformArtifactVerifier } from "../codex/browser-runtime-platform-verifier";
import { getLogger } from "../logging/logger";

export type {
  ChromeControlRuntimeSnapshot,
  ChromeControlRuntimeStatus,
} from "../../shared/chrome-control-settings";

export interface ChromeControlRuntimeChange {
  readonly connectedInstances: readonly ChromeExtensionInstanceSnapshot[];
  readonly disconnectedInstances: readonly ChromeExtensionInstanceSnapshot[];
  readonly snapshot: ChromeControlRuntimeSnapshot;
}

export class ChromeControlRuntimeError extends Schema.TaggedError<ChromeControlRuntimeError>()(
  "ChromeControlRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ChromeControlRuntime extends Context.Service<
  ChromeControlRuntime,
  {
    readonly available: () => boolean;
    readonly changes: Stream.Stream<ChromeControlRuntimeChange>;
    readonly focusPresentation: (
      input: ChromeExtensionFocusInput,
    ) => Effect.Effect<void, ChromeControlRuntimeError>;
    readonly isConnectedInstance: (family: string, extensionInstanceId: string) => boolean;
    readonly refresh: Effect.Effect<ChromeControlRuntimeSnapshot, ChromeControlRuntimeError>;
    readonly resolveBrowserIconPath: (family: string) => string | null;
    readonly snapshot: () => ChromeControlRuntimeSnapshot;
  }
>()("nodex/main/host-runtime/ChromeControlRuntime") {}

export interface ChromeControlExtensionRegistryPort {
  readonly focusPresentation: (input: ChromeExtensionFocusInput) => Promise<void>;
  readonly refresh: () => Promise<ChromeExtensionPipeRegistrySnapshot>;
  readonly snapshot: () => ChromeExtensionPipeRegistrySnapshot;
  readonly start: () => Promise<ChromeExtensionPipeRegistrySnapshot>;
  readonly stop: () => void;
  readonly subscribe: (
    listener: (snapshot: ChromeExtensionPipeRegistrySnapshot) => void,
  ) => () => void;
}

export interface ChromeControlRuntimePorts {
  readonly browserIconPaths?: ReadonlyMap<string, string>;
  readonly bundleSupported: boolean;
  readonly installNativeHost: () => Promise<ChromeNativeHostInstallResult>;
  readonly makeRegistry: (
    peerIdentity: ChromeNativeHostPeerIdentity,
  ) => ChromeControlExtensionRegistryPort;
  readonly requested: boolean;
  readonly runtimeUnavailableReason: string | null;
}

export function resolveChromeNativeHostNodeModuleDirs(
  runtimeRoot: string,
  relativePaths: readonly string[],
): readonly string[] {
  return relativePaths
    .filter((relativePath) => relativePath !== BROWSER_PLUGIN_NODE_MODULE_DIR)
    .map((relativePath) => path.join(runtimeRoot, ...relativePath.split("/")));
}

const EMPTY_REGISTRY_SNAPSHOT: ChromeExtensionPipeRegistrySnapshot = {
  instances: [],
  providerReady: false,
  revision: 0,
};

function boundedReason(error: unknown): string {
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? Reflect.get(error, "cause")
      : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 512);
}

function makeSnapshot(input: {
  readonly bundleSupported: boolean;
  readonly installFailure: string | null;
  readonly nativeHostInstalled: boolean;
  readonly registry: ChromeExtensionPipeRegistrySnapshot;
  readonly registryFailure: string | null;
  readonly requested: boolean;
  readonly runtimeUnavailableReason: string | null;
}): ChromeControlRuntimeSnapshot {
  if (!input.bundleSupported) {
    return {
      bundleSupported: false,
      extensionConnected: false,
      nativeHostInstalled: false,
      providerReady: false,
      reason: input.runtimeUnavailableReason ?? "Chrome runtime is not bundled",
      requested: input.requested,
      revision: input.registry.revision,
      status: "runtime-unavailable",
    };
  }
  if (!input.nativeHostInstalled || input.registryFailure) {
    return {
      bundleSupported: true,
      extensionConnected: false,
      nativeHostInstalled: input.nativeHostInstalled,
      providerReady: false,
      reason:
        input.installFailure ?? input.registryFailure ?? "Chrome native host installation failed",
      requested: input.requested,
      revision: input.registry.revision,
      status: "faulted",
    };
  }
  if (!input.registry.providerReady) {
    return {
      bundleSupported: true,
      extensionConnected: false,
      nativeHostInstalled: true,
      providerReady: false,
      reason: "Waiting for a supported ChatGPT browser extension",
      requested: input.requested,
      revision: input.registry.revision,
      status: "extension-disconnected",
    };
  }
  return {
    bundleSupported: true,
    extensionConnected: true,
    nativeHostInstalled: true,
    providerReady: true,
    reason: null,
    requested: input.requested,
    revision: input.registry.revision,
    status: "ready",
  };
}

function sameInstance(
  left: ChromeExtensionInstanceSnapshot,
  right: ChromeExtensionInstanceSnapshot,
): boolean {
  return (
    left.extensionId === right.extensionId &&
    left.extensionInstanceId === right.extensionInstanceId &&
    left.family === right.family
  );
}

function diffInstances(
  previous: readonly ChromeExtensionInstanceSnapshot[],
  next: readonly ChromeExtensionInstanceSnapshot[],
): Pick<ChromeControlRuntimeChange, "connectedInstances" | "disconnectedInstances"> {
  return {
    connectedInstances: next.filter(
      (candidate) => !previous.some((existing) => sameInstance(existing, candidate)),
    ),
    disconnectedInstances: previous.filter(
      (candidate) => !next.some((existing) => sameInstance(existing, candidate)),
    ),
  };
}

export const makeChromeControlRuntime = (
  ports: ChromeControlRuntimePorts,
): Effect.Effect<ChromeControlRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    let installFailure: string | null = null;
    let nativeHostInstalled = false;
    let registry: ChromeControlExtensionRegistryPort | null = null;
    let registryFailure: string | null = null;

    if (ports.bundleSupported) {
      const installResult = yield* Effect.tryPromise({
        try: () => ports.installNativeHost(),
        catch: (cause) =>
          new ChromeControlRuntimeError({ operation: "install-native-host", cause }),
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            installFailure = boundedReason(error);
            return null;
          },
          onSuccess: (result) => result,
        }),
      );
      if (installResult) {
        nativeHostInstalled = true;
        registry = ports.makeRegistry(installResult.peerIdentity);
        yield* Effect.tryPromise({
          try: () => registry!.start(),
          catch: (cause) => new ChromeControlRuntimeError({ operation: "start-registry", cause }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              registryFailure = boundedReason(error);
            }),
          ),
        );
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => registry?.stop()));

    const registrySnapshot = (): ChromeExtensionPipeRegistrySnapshot =>
      registry?.snapshot() ?? EMPTY_REGISTRY_SNAPSHOT;
    const snapshot = (): ChromeControlRuntimeSnapshot =>
      makeSnapshot({
        bundleSupported: ports.bundleSupported,
        installFailure,
        nativeHostInstalled,
        registry: registrySnapshot(),
        registryFailure,
        requested: ports.requested,
        runtimeUnavailableReason: ports.runtimeUnavailableReason,
      });

    const rawChanges = registry
      ? Stream.callback<ChromeExtensionPipeRegistrySnapshot>(
          (queue) =>
            Effect.acquireRelease(
              Effect.sync(() => registry!.subscribe((next) => Queue.offerUnsafe(queue, next))),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          { bufferSize: 64, strategy: "sliding" },
        )
      : Stream.empty;
    const changes = rawChanges.pipe(
      Stream.mapAccum(
        () => registrySnapshot().instances,
        (previous, next) => {
          const delta = diffInstances(previous, next.instances);
          if (delta.connectedInstances.length === 0 && delta.disconnectedInstances.length === 0) {
            return [next.instances, []] as const;
          }
          return [
            next.instances,
            [
              {
                ...delta,
                snapshot: makeSnapshot({
                  bundleSupported: ports.bundleSupported,
                  installFailure,
                  nativeHostInstalled,
                  registry: next,
                  registryFailure,
                  requested: ports.requested,
                  runtimeUnavailableReason: ports.runtimeUnavailableReason,
                }),
              },
            ],
          ] as const;
        },
      ),
    );

    return ChromeControlRuntime.of({
      available: () => snapshot().providerReady,
      changes,
      focusPresentation: (input) => {
        if (!snapshot().providerReady || !registry) {
          return Effect.fail(
            new ChromeControlRuntimeError({
              operation: "focus-presentation",
              cause: new Error("Chrome provider is unavailable"),
            }),
          );
        }
        return Effect.tryPromise({
          try: () => registry.focusPresentation(input),
          catch: (cause) =>
            new ChromeControlRuntimeError({ operation: "focus-presentation", cause }),
        });
      },
      isConnectedInstance: (family, extensionInstanceId) => {
        if (!snapshot().providerReady || !family || !extensionInstanceId) return false;
        return registrySnapshot().instances.some(
          (instance) =>
            instance.family === family && instance.extensionInstanceId === extensionInstanceId,
        );
      },
      refresh: registry
        ? Effect.tryPromise({
            try: () => registry!.refresh(),
            catch: (cause) => new ChromeControlRuntimeError({ operation: "refresh", cause }),
          }).pipe(Effect.asVoid, Effect.map(snapshot))
        : Effect.succeed(snapshot()),
      resolveBrowserIconPath: (family) => ports.browserIconPaths?.get(family) ?? null,
      snapshot,
    });
  });

export interface ChromeControlRuntimeOptions {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly homeDirectory: string;
  readonly peerAuthorizationMode: BrowserUsePeerAuthorizationMode;
  readonly platform: NodeJS.Platform;
  readonly runtimeStateHome: string;
}

async function verifyAttestedIconPaths(
  bundle: VerifiedBrowserRuntimeBundle,
  authority: ChromeBrowserAuthority,
): Promise<ReadonlyMap<string, string>> {
  const chrome = bundle.manifest.capabilities.browserUse.backends.chrome;
  if (chrome.status !== "available") return new Map();
  const result = new Map<string, string>();
  for (const family of authority.families) {
    const artifactRelativePath = `${chrome.plugin.root}/${family.browserIconAssetPath}`;
    const artifact = bundle.manifest.artifacts.find(
      (candidate) => candidate.path === artifactRelativePath && candidate.kind === "data",
    );
    if (!artifact) continue;
    const artifactPath = path.join(bundle.rootPath, ...artifact.path.split("/"));
    const handle = await fs.open(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== artifact.size) continue;
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) continue;
      result.set(family.family, artifactPath);
    } finally {
      await handle.close();
    }
  }
  return result;
}

export const live = (options: ChromeControlRuntimeOptions): Layer.Layer<ChromeControlRuntime> =>
  Layer.effect(
    ChromeControlRuntime,
    Effect.gen(function* () {
      const logger = getLogger({ component: "chrome-control-runtime" });
      const bundle =
        options.browserRuntime.status === "available" ? options.browserRuntime.bundle : null;
      const chromeCapability = bundle?.manifest.capabilities.browserUse.backends.chrome ?? null;
      const platformSupported = options.platform === "darwin";
      const descriptorArtifact =
        bundle && chromeCapability?.status === "available"
          ? bundle.manifest.artifacts.find(
              (artifact) => artifact.path === chromeCapability.familyDescriptor,
            )
          : null;
      const authorityResult =
        platformSupported &&
        bundle &&
        chromeCapability?.status === "available" &&
        bundle.paths.chromeFamilyDescriptor &&
        descriptorArtifact
          ? yield* Effect.tryPromise(() =>
              loadChromeBrowserAuthority({
                descriptorPath: bundle.paths.chromeFamilyDescriptor!,
                expectedExtensionIds: chromeCapability.extensionIds,
                expectedHostName: chromeCapability.nativeHost.hostName,
                expectedSha256: descriptorArtifact.sha256,
                expectedSize: descriptorArtifact.size,
              }),
            ).pipe(
              Effect.match({
                onFailure: (error) => ({ error: boundedReason(error), value: null }),
                onSuccess: (value) => ({ error: null, value }),
              }),
            )
          : { error: null, value: null };
      const authority = authorityResult.value;
      const bundleSupported =
        platformSupported &&
        bundle !== null &&
        chromeCapability?.status === "available" &&
        authority !== null;
      const requested = platformSupported && chromeCapability?.status === "available";
      const browserIconPaths =
        bundleSupported && bundle && authority
          ? yield* Effect.tryPromise(() => verifyAttestedIconPaths(bundle, authority)).pipe(
              Effect.orElseSucceed(() => new Map<string, string>()),
            )
          : new Map<string, string>();

      const installNativeHost = async (): Promise<ChromeNativeHostInstallResult> => {
        if (!bundleSupported || !bundle || chromeCapability?.status !== "available" || !authority) {
          throw new Error("Chrome native host is unavailable on this runtime");
        }
        const nativeHostPath = bundle.paths.chromeNativeHost;
        if (!nativeHostPath) throw new Error("Verified Chrome native host path is unavailable");
        const nativeHostArtifact = bundle.manifest.artifacts.find(
          (artifact) => artifact.path === chromeCapability.nativeHost.path,
        );
        if (!nativeHostArtifact) {
          throw new Error("Verified Chrome native host artifact is unavailable");
        }
        const verifier = createBrowserRuntimePlatformArtifactVerifier({
          platform: options.platform,
        });
        return await installChromeNativeHost({
          authority,
          channel:
            bundle.manifest.buildFlavor === "production"
              ? "prod"
              : bundle.manifest.buildFlavor === "internal"
                ? "internal"
                : "dev",
          expectedNativeHost: {
            sha256: nativeHostArtifact.sha256,
            signingTeamId: chromeCapability.nativeHost.signingTeamId,
            size: nativeHostArtifact.size,
          },
          homeDirectory: options.homeDirectory,
          runtimePaths: {
            browserClientPath: bundle.paths.browserPluginClient,
            browserServicePath: bundle.paths.browserPluginService,
            codexCliPath: bundle.paths.codexCli,
            nativeHostPath,
            nodePath: bundle.paths.node,
            nodeModuleDirs: resolveChromeNativeHostNodeModuleDirs(
              bundle.rootPath,
              bundle.manifest.browserPlugin.nodeModuleDirs,
            ),
            nodeReplPath: bundle.paths.nodeRepl,
            resourcesPath: bundle.rootPath,
          },
          runtimeStateHome: options.runtimeStateHome,
          runtimeVersion: chromeCapability.plugin.version,
          verifyNativeHost: async (candidatePath) => {
            const failure = verifier({
              artifact: nativeHostArtifact,
              artifactPath: candidatePath,
              manifest: bundle.manifest,
            });
            if (failure) throw new Error(failure);
            return readChromeNativeHostIdentity(candidatePath);
          },
        });
      };

      return yield* makeChromeControlRuntime({
        browserIconPaths,
        bundleSupported,
        installNativeHost,
        makeRegistry: (peerIdentity) => {
          if (!authority || !bundle) throw new Error("Chrome authority is unavailable");
          return new ChromeExtensionPipeRegistry({
            authority,
            expectedPeerIdentity: peerIdentity,
            onDiagnostic: (diagnostic) => logger.warn("Chrome provider diagnostic", diagnostic),
            onSnapshot: (snapshot) =>
              logger.info("Chrome provider connection changed", {
                connectedInstances: snapshot.instances.length,
                providerReady: snapshot.providerReady,
                revision: snapshot.revision,
              }),
            socketPeerAuthorizer: createBrowserUsePeerAuthorizer({
              addonPath: bundle.paths.peerAuthorization,
              mode: options.peerAuthorizationMode,
              platform: options.platform,
            }),
          });
        },
        requested,
        runtimeUnavailableReason:
          options.browserRuntime.status === "unavailable"
            ? options.browserRuntime.message
            : !platformSupported
              ? "Chrome native control requires macOS"
              : chromeCapability?.status === "unavailable"
                ? chromeCapability.reason
                : authorityResult.error
                  ? `Chrome runtime descriptor was rejected: ${authorityResult.error}`
                  : "Chrome runtime bundle is unsupported",
      });
    }),
  );

export const testLayer = (ports: ChromeControlRuntimePorts): Layer.Layer<ChromeControlRuntime> =>
  Layer.effect(ChromeControlRuntime, makeChromeControlRuntime(ports));
