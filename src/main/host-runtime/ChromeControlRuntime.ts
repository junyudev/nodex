import type { ChromeHostRegistration } from "../browser-use/chrome/ChromeHostRegistrationPolicy";
import { hostCapabilities } from "../../shared/host-capabilities";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserUsePeerAuthorizationMode } from "../../shared/browser-use-host-capability";
import { BROWSER_PLUGIN_NODE_MODULE_DIR } from "../../shared/browser-runtime-metadata";
import type {
  ChromeControlRuntimeSnapshot,
  ChromeControlSettingsAction,
} from "../../shared/chrome-control-settings";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { WindowsDesktopTools } from "../platform/node/WindowsDesktopTools";
import {
  createWindowsChromeRegistration,
  windowsChromeStatePath,
  type WindowsChromeRegistrationState,
} from "../browser-use/chrome/WindowsChromeRegistration";
import {
  createWindowsChromeNativeHost,
  windowsChromeFileSecurity,
} from "../browser-use/chrome/WindowsChromeNativeHost";
import { createWindowsChromePipeTransport } from "../browser-use/chrome/WindowsChromePipeTransport";
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
  ChromeHostRegistrationInUse,
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
    readonly updateWindowsRegistration?: (
      action: ChromeControlSettingsAction,
    ) => Effect.Effect<ChromeControlRuntimeSnapshot, ChromeControlRuntimeError>;
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
  readonly registrationKind: ChromeHostRegistration["kind"];
  readonly browserIconPaths?: ReadonlyMap<string, string>;
  readonly bundleSupported: boolean;
  readonly installNativeHost: () => Promise<ChromeNativeHostInstallResult>;
  readonly makeRegistry: (
    peerIdentity: ChromeNativeHostPeerIdentity,
  ) => ChromeControlExtensionRegistryPort;
  readonly requested: boolean;
  readonly runtimeUnavailableReason: string | null;
  readonly windows?: {
    readonly reconcile: (
      action?: ChromeControlSettingsAction,
    ) => Promise<WindowsChromeRegistrationState>;
    readonly makeRegistry: () => ChromeControlExtensionRegistryPort;
    readonly releaseRegistration?: () => Promise<void>;
  };
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
  readonly registrationKind: ChromeHostRegistration["kind"];
  readonly bundleSupported: boolean;
  readonly installFailure: ChromeControlRuntimeError | null;
  readonly nativeHostInstalled: boolean;
  readonly registry: ChromeExtensionPipeRegistrySnapshot;
  readonly registryFailure: string | null;
  readonly requested: boolean;
  readonly runtimeUnavailableReason: string | null;
}): ChromeControlRuntimeSnapshot {
  if (input.registrationKind === "disabled") {
    return {
      bundleSupported: input.bundleSupported,
      extensionConnected: false,
      nativeHostInstalled: false,
      providerReady: false,
      reason: "To register with your browsers, launch with vp run dev --register-browser-host.",
      requested: input.requested,
      revision: input.registry.revision,
      status: "registration-disabled",
    };
  }
  const registrationNote =
    input.registrationKind === "development" ? "Registered for this development instance." : null;
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
      reason: input.installFailure
        ? boundedReason(input.installFailure)
        : (input.registryFailure ?? "Chrome native host installation failed"),
      requested: input.requested,
      revision: input.registry.revision,
      status:
        input.installFailure?.cause instanceof ChromeHostRegistrationInUse
          ? "registration-in-use"
          : "faulted",
    };
  }
  if (!input.registry.providerReady) {
    return {
      bundleSupported: true,
      extensionConnected: false,
      nativeHostInstalled: true,
      providerReady: false,
      reason: registrationNote ?? "Waiting for a supported ChatGPT browser extension",
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
    reason: registrationNote,
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
): Effect.Effect<ChromeControlRuntime["Service"], never, Scope.Scope> => {
  if (ports.windows && ports.registrationKind !== "disabled")
    return makeWindowsChromeControlRuntime(ports, ports.windows);
  return Effect.gen(function* () {
    let installFailure: ChromeControlRuntimeError | null = null;
    let nativeHostInstalled = false;
    let registry: ChromeControlExtensionRegistryPort | null = null;
    let registryFailure: string | null = null;

    if (ports.bundleSupported && ports.registrationKind !== "disabled") {
      const installResult = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => ports.installNativeHost(),
          catch: (cause) =>
            new ChromeControlRuntimeError({ operation: "install-native-host", cause }),
        }),
        (result) =>
          Effect.promise(() => result.releaseRegistration?.() ?? Promise.resolve()).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not restore Chrome registration", cause),
            ),
          ),
      ).pipe(
        Effect.match({
          onFailure: (error) => {
            installFailure = error;
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
        registrationKind: ports.registrationKind,
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
                  registrationKind: ports.registrationKind,
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
};

function makeWindowsChromeControlRuntime(
  ports: ChromeControlRuntimePorts,
  windows: NonNullable<ChromeControlRuntimePorts["windows"]>,
): Effect.Effect<ChromeControlRuntime["Service"], never, Scope.Scope> {
  return Effect.gen(function* () {
    const lane = yield* Semaphore.make(1);
    let registry: ChromeControlExtensionRegistryPort | null = null;
    let unsubscribe: (() => void) | undefined;
    let registration: WindowsChromeRegistrationState | null = null;
    let failure: string | null = null;
    let revision = 0;
    let previous = EMPTY_REGISTRY_SNAPSHOT.instances;
    const listeners = new Set<(change: ChromeControlRuntimeChange) => void>();
    const snapshot = (): ChromeControlRuntimeSnapshot => {
      const current = registry?.snapshot() ?? EMPTY_REGISTRY_SNAPSHOT;
      const inUse = registration?.status === "registration-in-use" ? registration : null;
      const disabled = registration?.status === "disabled";
      const ready = !failure && registration?.status === "owned" && current.providerReady;
      return {
        bundleSupported: ports.bundleSupported,
        extensionConnected: ready,
        nativeHostInstalled: registration?.status === "owned",
        providerReady: ready,
        reason:
          failure ??
          (ports.registrationKind === "development" && registration?.status === "owned"
            ? "Registered for this development instance."
            : null),
        requested: !disabled,
        revision,
        status: failure
          ? "faulted"
          : inUse
            ? "registration-in-use"
            : disabled
              ? "disabled"
              : ready
                ? "ready"
                : "extension-disconnected",
        windows: {
          owner: inUse?.owner ?? null,
          manifestPaths: inUse?.manifestPaths ?? [],
          takeoverToken: inUse?.takeoverToken ?? null,
          canGiveBack: registration?.status === "owned" && registration.canGiveBack,
        },
      };
    };
    const publish = () => {
      const current = registry?.snapshot().instances ?? [];
      const delta = diffInstances(previous, current);
      previous = current;
      revision += 1;
      for (const listener of listeners) listener({ ...delta, snapshot: snapshot() });
    };
    const stopRegistry = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      registry?.stop();
      registry = null;
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopRegistry();
        const release = windows.releaseRegistration;
        if (!release) return;
        yield* Effect.tryPromise(release).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not restore Chrome registration", cause),
          ),
        );
      }).pipe(lane.withPermit),
    );

    const reconcile = (action?: ChromeControlSettingsAction) =>
      Effect.tryPromise(async () => {
        if (action?.kind === "disable" || action?.kind === "repair") stopRegistry();
        registration = await windows.reconcile(action);
        failure = null;
        if (registration.status !== "owned") stopRegistry();
        else if (!registry) {
          registry = windows.makeRegistry();
          await registry.start();
          unsubscribe = registry.subscribe(publish);
        }
        publish();
        return snapshot();
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            stopRegistry();
            getLogger({ component: "chrome-control-runtime" }).warn(
              "Browser control setup failed",
              {
                reason: boundedReason(error),
              },
            );
            failure = "Nodex couldn’t set up browser control.";
            publish();
            return snapshot();
          }),
        ),
        // Registry writes and their recovery receipts must finish before shutdown or the next command.
        Effect.uninterruptible,
        lane.withPermit,
      );
    yield* reconcile();
    return ChromeControlRuntime.of({
      available: () => snapshot().providerReady,
      changes: Stream.callback(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const listener = (change: ChromeControlRuntimeChange) =>
                Queue.offerUnsafe(queue, change);
              listeners.add(listener);
              return listener;
            }),
            (listener) => Effect.sync(() => listeners.delete(listener)),
          ),
        { bufferSize: 64, strategy: "sliding" },
      ),
      focusPresentation: (input) =>
        Effect.tryPromise({
          try: () => {
            if (!registry || !snapshot().providerReady)
              throw new Error("Browser control is unavailable");
            return registry.focusPresentation(input);
          },
          catch: (cause) =>
            new ChromeControlRuntimeError({ operation: "focus-presentation", cause }),
        }),
      isConnectedInstance: (family, extensionInstanceId) =>
        snapshot().providerReady &&
        (registry
          ?.snapshot()
          .instances.some(
            (instance) =>
              instance.family === family && instance.extensionInstanceId === extensionInstanceId,
          ) ??
          false),
      refresh: reconcile(),
      updateWindowsRegistration: reconcile,
      resolveBrowserIconPath: (family) => ports.browserIconPaths?.get(family) ?? null,
      snapshot,
    });
  });
}

export interface ChromeControlRuntimeOptions {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly windowsBrowserReady?: Effect.Effect<void>;
  readonly registration: ChromeHostRegistration;
  readonly peerAuthorizationMode: BrowserUsePeerAuthorizationMode;
  readonly platform: NodeJS.Platform;
  readonly architecture?: string;
  readonly localAppData?: string;
  readonly runtimeStateHome: string;
  readonly windowsInstallationDirectory?: string;
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

const chromeControlLayer = (
  options: ChromeControlRuntimeOptions,
): Layer.Layer<ChromeControlRuntime, never, WindowsDesktopTools | ScopedCallbackRuntime> =>
  Layer.effect(
    ChromeControlRuntime,
    Effect.gen(function* () {
      const logger = getLogger({ component: "chrome-control-runtime" });
      const bundle =
        options.browserRuntime.status === "available" ? options.browserRuntime.bundle : null;
      const chromeCapability = bundle?.manifest.capabilities.browserUse.backends.chrome ?? null;
      const platformSupported = hostCapabilities(options.platform, options.architecture, {
        browserReady: options.windowsBrowserReady !== undefined && bundle !== null,
      }).browserControl;
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
                platform: options.platform,
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
        const registration = options.registration;
        if (registration.kind === "disabled") throw new Error("Chrome registration is disabled");
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
        if (
          bundle.manifest.targetPlatform !== "darwin" ||
          !bundle.manifest.trust.chromeSigningTeamId
        ) {
          throw new Error("The macOS native host signing policy is unavailable");
        }
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
            signingTeamId: bundle.manifest.trust.chromeSigningTeamId,
            size: nativeHostArtifact.size,
          },
          homeDirectory: registration.homeDirectory,
          temporaryRegistration: registration.kind === "development",
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
            const failure = await verifier({
              artifact: nativeHostArtifact,
              artifactPath: candidatePath,
              manifest: bundle.manifest,
            });
            if (failure) throw new Error(failure);
            return readChromeNativeHostIdentity(candidatePath);
          },
        });
      };

      const runtimeUnavailableReason =
        options.browserRuntime.status === "unavailable"
          ? options.browserRuntime.message
          : !platformSupported
            ? "Existing browser control is unavailable on this platform"
            : chromeCapability?.status === "unavailable"
              ? chromeCapability.reason
              : authorityResult.error
                ? `Chrome runtime descriptor was rejected: ${authorityResult.error}`
                : "Chrome runtime bundle is unsupported";
      const manifest = bundle?.manifest;
      const registrationPolicy = options.registration;
      const windows =
        options.platform === "win32" &&
        (registrationPolicy.kind === "production" || registrationPolicy.kind === "development") &&
        bundleSupported &&
        bundle &&
        manifest?.targetPlatform === "win32" &&
        chromeCapability?.status === "available" &&
        authority
          ? yield* Effect.gen(function* () {
              const native = yield* WindowsDesktopTools;
              const callbacks = yield* ScopedCallbackRuntime;
              const artifact = bundle.manifest.artifacts.find(
                ({ path }) => path === chromeCapability.nativeHost.path,
              );
              const nativeHostPath = bundle.paths.chromeNativeHost;
              if (!artifact || !nativeHostPath || !Object.hasOwn(manifest.trust.pe, artifact.path))
                return undefined;
              const security = windowsChromeFileSecurity((candidate) =>
                callbacks.runPromise(native.inspectPath(candidate)),
              );
              const statePath = windowsChromeStatePath(options.runtimeStateHome);
              const browsers = authority.families.flatMap(({ windows }) =>
                windows?.registrationBrowser ? [windows.registrationBrowser] : [],
              );
              if (!browsers.includes("chrome") || !browsers.includes("edge")) return undefined;
              const verifier = createBrowserRuntimePlatformArtifactVerifier({
                platform: "win32",
                windowsVerifier: {
                  verifyClosurePaths: async () => ({
                    ok: false,
                    reason: "Expected a single native host executable",
                  }),
                  verifyAuthenticode: async (candidate, policy) => {
                    const signature = await callbacks.runPromise(
                      native.verifyAuthenticode(candidate),
                    );
                    if (
                      signature.status !== "verified" ||
                      !signature.codeSigningEku ||
                      signature.revocation !== "cacheChecked"
                    ) {
                      return {
                        ok: false,
                        reason: "Browser native host signature could not be verified",
                      };
                    }
                    const signer = signature.chain[0];
                    if (signer?.subject !== policy.subject || signer.issuer !== policy.issuer) {
                      return { ok: false, reason: "Browser native host publisher did not match" };
                    }
                    return { ok: true, value: signer };
                  },
                },
              });
              const installer = createWindowsChromeNativeHost({
                authority,
                channel:
                  bundle.manifest.buildFlavor === "production"
                    ? "prod"
                    : bundle.manifest.buildFlavor === "internal"
                      ? "internal"
                      : "dev",
                expectedNativeHost: artifact,
                localAppData:
                  options.localAppData ??
                  path.join(registrationPolicy.homeDirectory, "AppData", "Local"),
                runtimeStateHome: options.runtimeStateHome,
                statePath,
                runtimeVersion: chromeCapability.plugin.version,
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
                security,
                verifyPlatformArtifact: async (candidate) => {
                  const failure = await verifier({
                    artifact,
                    artifactPath: candidate,
                    manifest: bundle.manifest,
                  });
                  if (failure) throw new Error(failure);
                },
              });
              const registration = createWindowsChromeRegistration({
                statePath,
                host: authority.hostName,
                installationDirectory: options.windowsInstallationDirectory,
                browsers,
                security,
                releaseResources: installer.releaseResources,
                registry: {
                  readRegistration: (key) => callbacks.runPromise(native.readRegistration(key)),
                  writeRegistration: (key, expected, manifest) =>
                    callbacks.runPromise(native.writeRegistration(key, expected, manifest)),
                  restoreRegistration: (key, receipt) =>
                    callbacks.runPromise(native.restoreRegistration(key, receipt)),
                },
              });
              const transport = createWindowsChromePipeTransport({
                callbacks,
                native,
                nativeHostPath: installer.nativeHostPath,
                ownsRegistration: registration.ownsRegistration,
                verifyHost: installer.verify,
              });
              let published = false;
              return {
                releaseRegistration:
                  registrationPolicy.kind === "development" ? registration.release : undefined,
                reconcile: async (action?: ChromeControlSettingsAction) => {
                  const state = await registration.reconcile(async (target, repair) => {
                    if (repair || !published) await installer.install(target);
                    else await installer.checkInstallation(target);
                    return async () => {
                      if (repair || !published) await installer.publish();
                      published = true;
                    };
                  }, action);
                  if (state.status !== "owned") published = false;
                  return state;
                },
                makeRegistry: () =>
                  new ChromeExtensionPipeRegistry({
                    authority,
                    windows: transport,
                    requestTimeoutMs: 4000,
                    onDiagnostic: (diagnostic) =>
                      logger.warn("Chrome provider diagnostic", diagnostic),
                  }),
              };
            })
          : undefined;

      return yield* makeChromeControlRuntime({
        browserIconPaths,
        bundleSupported:
          bundleSupported &&
          (options.platform !== "win32" ||
            registrationPolicy.kind === "disabled" ||
            windows !== undefined),
        windows,
        installNativeHost,
        registrationKind: options.registration.kind,
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
          options.platform === "win32"
            ? "Browser control isn’t available on this installation."
            : runtimeUnavailableReason,
      });
    }),
  );

export const live = (
  options: ChromeControlRuntimeOptions,
): Layer.Layer<ChromeControlRuntime, never, WindowsDesktopTools | ScopedCallbackRuntime> => {
  const windowsBrowserReady = options.windowsBrowserReady;
  if (!windowsBrowserReady) return chromeControlLayer(options);
  return Layer.effect(
    ChromeControlRuntime,
    Effect.gen(function* () {
      // Windows verification and registration may finish after Main starts.
      let current: ChromeControlRuntime["Service"] | undefined;
      const initializing = yield* windowsBrowserReady.pipe(
        Effect.andThen(Layer.build(chromeControlLayer(options))),
        Effect.map((context) => Context.get(context, ChromeControlRuntime)),
        Effect.tap((service) =>
          Effect.sync(() => {
            current = service;
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const ready = Fiber.join(initializing);
      return ChromeControlRuntime.of({
        available: () => current?.available() ?? false,
        changes: Stream.unwrap(ready.pipe(Effect.map((service) => service.changes))),
        focusPresentation: (input) =>
          ready.pipe(Effect.flatMap((service) => service.focusPresentation(input))),
        isConnectedInstance: (family, id) => current?.isConnectedInstance(family, id) ?? false,
        refresh: ready.pipe(Effect.flatMap((service) => service.refresh)),
        resolveBrowserIconPath: (family) => current?.resolveBrowserIconPath(family) ?? null,
        snapshot: () =>
          current?.snapshot() ??
          makeSnapshot({
            registrationKind: options.registration.kind,
            bundleSupported: false,
            installFailure: null,
            nativeHostInstalled: false,
            registry: EMPTY_REGISTRY_SNAPSHOT,
            registryFailure: null,
            requested: false,
            runtimeUnavailableReason:
              options.browserRuntime.status === "unavailable"
                ? options.browserRuntime.message
                : null,
          }),
        updateWindowsRegistration: (action) =>
          ready.pipe(
            Effect.flatMap(
              (service) => service.updateWindowsRegistration?.(action) ?? service.refresh,
            ),
          ),
      });
    }),
  );
};

export const testLayer = (ports: ChromeControlRuntimePorts): Layer.Layer<ChromeControlRuntime> =>
  Layer.effect(ChromeControlRuntime, makeChromeControlRuntime(ports));
