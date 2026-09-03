import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  RemoteHostedPipHostLayout,
  RemoteHostedPipTaskStateSnapshot,
} from "../../shared/remote-hosted-pip";
import type { BrowserSidebarEventHubService } from "../browser/BrowserSidebarEventHub";
import {
  RemoteHostedPipDiagnostics,
  type RemoteHostedPipDiagnosticEntry,
} from "../diagnostics/RemoteHostedPipDiagnostics";
import {
  admitBrowserPipResource,
  emptyBrowserPipResourceState,
  releaseBrowserPipResources,
  validateBrowserPipImage,
  type BrowserPipResourceState,
} from "../browser-use/browser-pip-image-resource-governor";
import {
  parseRemoteHostedPipNotification,
  type BrowserUsePipSurface,
} from "../browser-use/browser-use-pip-metadata";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { getLogger } from "../logging/logger";
import {
  makeRemoteHostedPipPreferences,
  type RemoteHostedPipPreferencesAdapter,
  type RemoteHostedPipTaskVisibility,
} from "../remote-hosted-pip-preference-store";
import {
  RemoteHostedPipNativePlatform,
  type RemoteHostedPipNativePlatformError,
  type RemoteHostedPipNativePlatformService,
} from "../platform/electron/RemoteHostedPipNativePlatform";
import { WindowRuntime, type WindowRuntimeService } from "../window-runtime/WindowRuntime";
import {
  makeRemoteHostedPipHostCoordinator,
  type RemoteHostedPipHostCoordinator,
} from "./remote-hosted-pip-host-coordinator";
import { ChromeControlRuntime } from "./ChromeControlRuntime";

const MAX_PENDING_IMAGE_COUNT = 64;
const MAX_PENDING_IMAGE_WIRE_BYTES = 64 * 1024 * 1024;
const MAX_ADMITTED_THREADS = 1_024;
const MAX_BROWSER_SESSIONS = 256;
const MAX_COMPUTER_USE_ITEMS_PER_THREAD = 256;
const MAX_COMPUTER_USE_THREADS = 512;
const logger = getLogger({ subsystem: "remote-hosted-pip" });

export interface RemoteHostedPipCodexOccurrence {
  readonly generation: number;
  readonly hostId: string;
  readonly notification: CodexServerNotification;
  readonly occurrenceId: string;
  readonly occurrenceToken: number;
}

export interface RemoteHostedPipCodexLifecycleSettlement {
  readonly action: "archive" | "delete";
  readonly threadIds: readonly string[];
}

export type { RemoteHostedPipTaskStateSnapshot } from "../../shared/remote-hosted-pip";

/** Transport-neutral identity used to route a native Browser PiP click to its owning backend. */
export interface RemoteHostedPipBrowserPresentationTarget {
  readonly backend: BrowserUsePipSurface["backend"];
  readonly browserFamily: string | null;
  readonly browserId: string;
  readonly extensionInstanceId: string | null;
  readonly presentationId: string;
  readonly tabId: string;
  readonly threadId: string;
}

interface RemoteHostedPipLegacyPort {
  readonly getAlwaysHide: () => boolean;
  readonly handleBrowserUseStateSnapshot: () => void;
  readonly setAlwaysHide: (value: boolean) => void;
}

export interface RemoteHostedPipNativePort {
  readonly completeThread: (
    threadId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly invalidateBrowserPresentation: (
    presentationId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly invalidateTurn: (
    threadId: string,
    turnId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly upsertBrowserPresentation: (input: {
    readonly appIconPath: string | null;
    readonly backend: BrowserUsePipSurface["backend"];
    readonly browserFamily: string | null;
    readonly dataUrl: string;
    readonly presentationId: string;
    readonly threadId: string;
  }) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
}

interface BrowserPresentation {
  readonly presentationId: string;
  readonly tabId: string;
}

interface BrowserSession {
  readonly backend: BrowserUsePipSurface["backend"];
  readonly browserFamily: string | null;
  readonly browserId: string;
  readonly extensionInstanceId: string | null;
  readonly generation: number;
  hasOpenTabs: boolean;
  readonly key: string;
  readonly presentations: Map<string, BrowserPresentation>;
  readonly threadId: string;
}

interface PendingImage {
  readonly backend: BrowserUsePipSurface["backend"];
  readonly browserFamily: string | null;
  readonly dataUrl: string;
  readonly extensionInstanceId: string | null;
  readonly generation: number;
  readonly presentationId: string;
  readonly sequence: number;
  readonly sessionKey: string;
  readonly tabId: string;
  readonly threadId: string;
  readonly wireBytes: number;
}

interface RuntimeState {
  readonly admittedThreadGenerations: Map<string, number>;
  readonly browserSessions: Map<string, BrowserSession>;
  readonly computerUseItemsByThread: Map<string, Set<string>>;
  currentGeneration: number | null;
  nextImageSequence: number;
  pendingImageBytes: number;
  readonly pendingImages: Map<string, PendingImage>;
  readonly presentationTargets: Map<string, RemoteHostedPipBrowserPresentationTarget>;
  readonly presentationSequences: Map<string, number>;
  resourceState: BrowserPipResourceState;
  retiredGeneration: number;
  revision: number;
}

export class RemoteHostedPipRuntime extends Context.Service<
  RemoteHostedPipRuntime,
  {
    readonly deleteTaskVisibility: (
      taskId: string,
    ) => Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly diagnosticSnapshot: Effect.Effect<readonly RemoteHostedPipDiagnosticEntry[]>;
    readonly getAlwaysHide: () => boolean;
    readonly observeCodexOccurrence: (
      occurrence: RemoteHostedPipCodexOccurrence,
    ) => Effect.Effect<void>;
    readonly refresh: Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly releaseChromeExtensionInstance: (input: {
      readonly browserFamily: string;
      readonly extensionInstanceId: string;
    }) => Effect.Effect<void>;
    readonly reportHostLayout: (
      webContentsId: number,
      layout: RemoteHostedPipHostLayout | null,
    ) => Effect.Effect<boolean>;
    readonly resolveBrowserPresentation: (
      presentationId: string,
    ) => Effect.Effect<RemoteHostedPipBrowserPresentationTarget | null>;
    readonly retireCodexThreads: (
      settlement: RemoteHostedPipCodexLifecycleSettlement,
    ) => Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly retireLocalCodexHost: (reason: "connection-lost" | "shutdown") => Effect.Effect<void>;
    readonly revisions: Stream.Stream<number>;
    readonly setAlwaysHide: (value: boolean) => Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly setMaxDisplaySize: (value: number) => Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly setTaskVisibilities: (
      taskIds: readonly string[],
      visibility: RemoteHostedPipTaskVisibility,
    ) => Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly setTaskVisibility: (
      taskId: string,
      visibility: RemoteHostedPipTaskVisibility,
    ) => Effect.Effect<void, RemoteHostedPipRuntimeError>;
    readonly snapshot: Effect.Effect<RemoteHostedPipTaskStateSnapshot>;
  }
>()("nodex/main/host-runtime/RemoteHostedPipRuntime") {}

export class RemoteHostedPipRuntimeError extends Schema.TaggedError<RemoteHostedPipRuntimeError>()(
  "RemoteHostedPipRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class RemoteHostedPipThreadHostResolutionError extends Schema.TaggedError<RemoteHostedPipThreadHostResolutionError>()(
  "RemoteHostedPipThreadHostResolutionError",
  { cause: Schema.Defect() },
) {}

export interface RemoteHostedPipRuntimeOptions {
  readonly browserSidebarEvents: BrowserSidebarEventHubService;
  readonly isThreadSurfacePresented: (threadId: string, ownerWebContentsId?: number) => boolean;
  readonly platform: NodeJS.Platform;
  readonly preferenceFilePath: string;
}

interface RuntimePorts {
  readonly browserUseStateSignals: Stream.Stream<unknown>;
  readonly host?: {
    readonly isThreadSurfacePresented: (threadId: string, ownerWebContentsId?: number) => boolean;
    readonly native: RemoteHostedPipNativePlatformService;
    readonly windows: WindowRuntimeService;
  };
  readonly legacy: RemoteHostedPipLegacyPort;
  readonly isChromeExtensionConnected: (
    browserFamily: string,
    extensionInstanceId: string,
  ) => boolean;
  readonly localHostId: string;
  readonly native: RemoteHostedPipNativePort;
  readonly diagnostics: RemoteHostedPipDiagnostics;
  readonly preferences: RemoteHostedPipPreferencesAdapter;
  readonly resolveChromeBrowserIconPath: (browserFamily: string) => string | null;
  readonly resolveThreadHost: (
    threadId: string,
  ) => Effect.Effect<string, RemoteHostedPipThreadHostResolutionError>;
}

const runtimeError = (operation: string, cause: unknown) =>
  new RemoteHostedPipRuntimeError({ operation, cause });

const sessionKey = (
  hostId: string,
  generation: number,
  threadId: string,
  surface: BrowserUsePipSurface,
): string => JSON.stringify([hostId, generation, threadId, surface.browserId]);

const presentationId = (threadId: string, surface: BrowserUsePipSurface, tabId: string): string =>
  `browser:${JSON.stringify([threadId, surface.browserId, tabId])}`;

const makeRuntime = (
  ports: RuntimePorts,
): Effect.Effect<RemoteHostedPipRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const initialPreferences = ports.preferences.readSnapshot();
    const state: RuntimeState = {
      admittedThreadGenerations: new Map(),
      browserSessions: new Map(),
      computerUseItemsByThread: new Map(),
      currentGeneration: null,
      nextImageSequence: 1,
      pendingImageBytes: 0,
      pendingImages: new Map(),
      presentationTargets: new Map(),
      presentationSequences: new Map(),
      resourceState: emptyBrowserPipResourceState(),
      retiredGeneration: 0,
      revision: initialPreferences.revision,
    };
    const lock = yield* Semaphore.make(1);
    const imageWake = yield* Queue.sliding<void>(1);
    const snapshotRef = yield* SubscriptionRef.make<RemoteHostedPipTaskStateSnapshot>({
      activeTaskIds: [],
      alwaysHidden: initialPreferences.alwaysHide,
      retainedPresentationCount: 0,
      revision: state.revision,
      taskVisibilityActionAvailable: false,
      taskVisibilities: initialPreferences.taskVisibilities,
    });
    let hostCoordinator: RemoteHostedPipHostCoordinator | null = null;
    const taskVisibilityActionAvailable =
      ports.host?.native.availability.status === "available" &&
      ports.host.native.availability.capabilities.hostLayout &&
      ports.host.native.availability.capabilities.presentation;

    const activeTaskIds = (): readonly string[] => {
      const active = new Set<string>();
      for (const session of state.browserSessions.values()) active.add(session.threadId);
      for (const [threadId, items] of state.computerUseItemsByThread) {
        if (items.size > 0) active.add(threadId);
      }
      return [...active].sort();
    };

    const publishSnapshot = Effect.fn("RemoteHostedPipRuntime.publishSnapshot")(function* () {
      const preferences = ports.preferences.readSnapshot();
      const current = yield* SubscriptionRef.get(snapshotRef);
      const nextActiveTaskIds = activeTaskIds();
      const nextRetainedPresentationCount = state.resourceState.leases.size;
      const currentVisibilityEntries = Object.entries(current.taskVisibilities).sort(
        ([left], [right]) => left.localeCompare(right),
      );
      const nextVisibilityEntries = Object.entries(preferences.taskVisibilities).sort(
        ([left], [right]) => left.localeCompare(right),
      );
      const contentUnchanged =
        current.activeTaskIds.length === nextActiveTaskIds.length &&
        current.activeTaskIds.every((taskId, index) => taskId === nextActiveTaskIds[index]) &&
        current.alwaysHidden === preferences.alwaysHide &&
        current.retainedPresentationCount === nextRetainedPresentationCount &&
        current.taskVisibilityActionAvailable === taskVisibilityActionAvailable &&
        currentVisibilityEntries.length === nextVisibilityEntries.length &&
        currentVisibilityEntries.every(
          ([taskId, visibility], index) =>
            taskId === nextVisibilityEntries[index]?.[0] &&
            visibility === nextVisibilityEntries[index]?.[1],
        );
      if (contentUnchanged) return;
      state.revision = Math.max(state.revision + 1, preferences.revision);
      yield* SubscriptionRef.set(snapshotRef, {
        activeTaskIds: nextActiveTaskIds,
        alwaysHidden: preferences.alwaysHide,
        retainedPresentationCount: nextRetainedPresentationCount,
        revision: state.revision,
        taskVisibilityActionAvailable,
        taskVisibilities: preferences.taskVisibilities,
      });
      if (hostCoordinator) yield* hostCoordinator.refresh;
    });

    if (ports.host) {
      hostCoordinator = yield* makeRemoteHostedPipHostCoordinator({
        isThreadSurfacePresented: ports.host.isThreadSurfacePresented,
        native: ports.host.native,
        preferences: ports.preferences,
        readSnapshot: () => SubscriptionRef.getUnsafe(snapshotRef),
        windows: ports.host.windows,
      });
    }

    const safeNative = <A>(
      operation: string,
      effect: Effect.Effect<A, RemoteHostedPipNativePlatformError>,
    ): Effect.Effect<void> =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            ports.diagnostics.record({
              operation,
              result: "failed",
              revision: state.revision,
              source: "native-host",
            });
            logger.warn("Remote Hosted PiP native projection failed", { operation, cause });
          }),
        ),
        Effect.asVoid,
      );

    const pruneEmptyBrowserSession = (key: string): void => {
      const session = state.browserSessions.get(key);
      if (!session || session.hasOpenTabs || session.presentations.size > 0) return;
      for (const pending of state.pendingImages.values()) {
        if (pending.sessionKey === key) return;
      }
      for (const lease of state.resourceState.leases.values()) {
        if (lease.sessionKey === key) return;
      }
      state.browserSessions.delete(key);
    };

    const releaseFailedImage = (job: PendingImage): boolean => {
      if (state.presentationSequences.get(job.presentationId) === job.sequence) {
        state.presentationSequences.delete(job.presentationId);
      }
      const hadSession = state.browserSessions.has(job.sessionKey);
      pruneEmptyBrowserSession(job.sessionKey);
      return hadSession && !state.browserSessions.has(job.sessionKey);
    };

    const discardFailedImage = (job: PendingImage) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (releaseFailedImage(job)) yield* publishSnapshot();
        }),
      );

    const invalidatePresentations = Effect.fn("RemoteHostedPipRuntime.invalidatePresentations")(
      function* (presentationIds: Iterable<string>) {
        for (const id of presentationIds) {
          yield* safeNative(
            "invalidate-browser-presentation",
            ports.native.invalidateBrowserPresentation(id),
          );
          state.pendingImageBytes -= state.pendingImages.get(id)?.wireBytes ?? 0;
          state.pendingImages.delete(id);
          state.presentationTargets.delete(id);
          state.presentationSequences.delete(id);
        }
        state.pendingImageBytes = Math.max(0, state.pendingImageBytes);
      },
    );

    const releaseSessions = Effect.fn("RemoteHostedPipRuntime.releaseSessions")(function* (
      predicate: (session: BrowserSession) => boolean,
    ) {
      const presentationIds: string[] = [];
      const releasedSessionKeys = new Set<string>();
      for (const [key, session] of state.browserSessions) {
        if (!predicate(session)) continue;
        releasedSessionKeys.add(key);
        for (const presentation of session.presentations.values()) {
          presentationIds.push(presentation.presentationId);
        }
        state.browserSessions.delete(key);
      }
      for (const pending of state.pendingImages.values()) {
        if (releasedSessionKeys.has(pending.sessionKey)) {
          presentationIds.push(pending.presentationId);
        }
      }
      yield* invalidatePresentations(presentationIds);
      const released = releaseBrowserPipResources(state.resourceState, (lease) =>
        releasedSessionKeys.has(lease.sessionKey),
      );
      state.resourceState = released.state;
      return releasedSessionKeys.size > 0 || released.released.length > 0;
    });

    const chromeSurfaceIsConnected = (surface: BrowserUsePipSurface): boolean => {
      if (surface.backend !== "chrome") return true;
      if (!surface.browserFamily || !surface.extensionInstanceId) return false;
      return ports.isChromeExtensionConnected(surface.browserFamily, surface.extensionInstanceId);
    };

    const chromeImageSourceIsConnected = (job: PendingImage): boolean => {
      if (job.backend !== "chrome") return true;
      if (!job.browserFamily || !job.extensionInstanceId) return false;
      return ports.isChromeExtensionConnected(job.browserFamily, job.extensionInstanceId);
    };

    const hasSameBrowserSource = (
      session: BrowserSession,
      source: {
        readonly backend: BrowserUsePipSurface["backend"];
        readonly browserFamily?: string | null;
        readonly extensionInstanceId?: string | null;
      },
    ): boolean =>
      session.backend === source.backend &&
      session.browserFamily === (source.browserFamily ?? null) &&
      session.extensionInstanceId === (source.extensionInstanceId ?? null);

    const retireGeneration = Effect.fn("RemoteHostedPipRuntime.retireGeneration")(function* (
      generation: number,
    ) {
      const browserChanged = yield* releaseSessions((session) => session.generation === generation);
      let computerChanged = false;
      for (const threadId of state.computerUseItemsByThread.keys()) {
        if (state.admittedThreadGenerations.get(threadId) !== generation) continue;
        state.computerUseItemsByThread.delete(threadId);
        computerChanged = true;
      }
      for (const [threadId, admittedGeneration] of state.admittedThreadGenerations) {
        if (admittedGeneration === generation) state.admittedThreadGenerations.delete(threadId);
      }
      return browserChanged || computerChanged;
    });

    const advanceGeneration = Effect.fn("RemoteHostedPipRuntime.advanceGeneration")(function* (
      generation: number,
    ) {
      if (!Number.isSafeInteger(generation) || generation <= state.retiredGeneration) return false;
      if (state.currentGeneration === null) {
        state.currentGeneration = generation;
        return true;
      }
      if (generation < state.currentGeneration) return false;
      if (generation === state.currentGeneration) return true;
      const changed = yield* retireGeneration(state.currentGeneration);
      state.retiredGeneration = state.currentGeneration;
      state.currentGeneration = generation;
      if (changed) yield* publishSnapshot();
      return true;
    });

    const admitThread = Effect.fn("RemoteHostedPipRuntime.admitThread")(function* (
      generation: number,
      threadId: string,
    ) {
      if (state.admittedThreadGenerations.get(threadId) === generation) return true;
      if (
        !state.admittedThreadGenerations.has(threadId) &&
        state.admittedThreadGenerations.size >= MAX_ADMITTED_THREADS
      ) {
        return false;
      }
      const resolved = yield* ports.resolveThreadHost(threadId).pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (hostId) => hostId,
        }),
      );
      if (resolved !== ports.localHostId) return false;
      state.admittedThreadGenerations.set(threadId, generation);
      return true;
    });

    const queueImage = Effect.fn("RemoteHostedPipRuntime.queueImage")(function* (
      occurrence: RemoteHostedPipCodexOccurrence,
      threadId: string,
      surface: BrowserUsePipSurface,
      key: string,
    ) {
      const screenshot = surface.screenshot;
      if (!screenshot) return;
      const id = presentationId(threadId, surface, screenshot.tabId);
      const previous = state.pendingImages.get(id);
      if (previous) state.pendingImageBytes -= previous.wireBytes;
      const job: PendingImage = {
        backend: surface.backend,
        browserFamily: surface.browserFamily ?? null,
        dataUrl: screenshot.url,
        extensionInstanceId: surface.extensionInstanceId ?? null,
        generation: occurrence.generation,
        presentationId: id,
        sequence: state.nextImageSequence,
        sessionKey: key,
        tabId: screenshot.tabId,
        threadId,
        wireBytes: Buffer.byteLength(screenshot.url, "utf8"),
      };
      state.nextImageSequence += 1;
      state.presentationSequences.set(id, job.sequence);
      state.pendingImages.delete(id);
      state.pendingImages.set(id, job);
      state.pendingImageBytes += job.wireBytes;
      while (
        state.pendingImages.size > MAX_PENDING_IMAGE_COUNT ||
        state.pendingImageBytes > MAX_PENDING_IMAGE_WIRE_BYTES
      ) {
        const oldest = state.pendingImages.entries().next().value as
          | [string, PendingImage]
          | undefined;
        if (!oldest) break;
        state.pendingImages.delete(oldest[0]);
        state.pendingImageBytes -= oldest[1].wireBytes;
        if (!state.resourceState.leases.has(oldest[0])) {
          state.presentationSequences.delete(oldest[0]);
        }
        const removedSession = releaseFailedImage(oldest[1]);
        if (removedSession) yield* publishSnapshot();
      }
      yield* Queue.offer(imageWake, undefined);
    });

    const applyBrowserSurface = Effect.fn("RemoteHostedPipRuntime.applyBrowserSurface")(function* (
      occurrence: RemoteHostedPipCodexOccurrence,
      threadId: string,
      surface: BrowserUsePipSurface,
    ) {
      const key = sessionKey(occurrence.hostId, occurrence.generation, threadId, surface);
      if (surface.sessionEnded === true || surface.openTabIds?.length === 0) {
        const changed = yield* releaseSessions((session) => session.key === key);
        if (changed) yield* publishSnapshot();
        return;
      }
      if (!chromeSurfaceIsConnected(surface)) return;

      let session = state.browserSessions.get(key);
      if (session && !hasSameBrowserSource(session, surface)) {
        const changed = yield* releaseSessions((candidate) => candidate.key === key);
        if (changed) yield* publishSnapshot();
        session = undefined;
      }
      if (!session && (surface.screenshot || surface.openTabIds)) {
        if (state.browserSessions.size >= MAX_BROWSER_SESSIONS) {
          ports.diagnostics.record({
            backend: surface.backend,
            ...(surface.browserFamily ? { browserFamily: surface.browserFamily } : {}),
            operation: "admit-session",
            result: "session-quota",
            revision: state.revision,
            source: surface.backend === "chrome" ? "chrome-control" : "browser-use",
            taskId: threadId,
          });
          return;
        }
        session = {
          backend: surface.backend,
          browserFamily: surface.browserFamily ?? null,
          browserId: surface.browserId,
          extensionInstanceId: surface.extensionInstanceId ?? null,
          generation: occurrence.generation,
          hasOpenTabs: (surface.openTabIds?.length ?? 0) > 0,
          key,
          presentations: new Map(),
          threadId,
        };
        state.browserSessions.set(key, session);
        yield* publishSnapshot();
      }
      if (session && surface.openTabIds) session.hasOpenTabs = surface.openTabIds.length > 0;
      yield* queueImage(occurrence, threadId, surface, key);
      if (!session || !surface.openTabIds) return;
      const openTabIds = new Set(surface.openTabIds);
      const invalidated: string[] = [];
      for (const [tabId, presentation] of session.presentations) {
        if (openTabIds.has(tabId)) continue;
        session.presentations.delete(tabId);
        invalidated.push(presentation.presentationId);
      }
      for (const pending of state.pendingImages.values()) {
        if (pending.sessionKey !== key || openTabIds.has(pending.tabId)) continue;
        invalidated.push(pending.presentationId);
      }
      if (invalidated.length === 0) return;
      yield* invalidatePresentations(invalidated);
      state.resourceState = releaseBrowserPipResources(state.resourceState, (lease) =>
        invalidated.includes(lease.presentationId),
      ).state;
      yield* publishSnapshot();
    });

    const retireCodexThreadsUnlocked = Effect.fn(
      "RemoteHostedPipRuntime.retireCodexThreadsUnlocked",
    )(function* (
      settlement: RemoteHostedPipCodexLifecycleSettlement,
    ): Effect.fn.Return<void, RemoteHostedPipRuntimeError> {
      const threadIds = new Set(
        settlement.threadIds.map((threadId) => threadId.trim()).filter(Boolean),
      );
      if (threadIds.size === 0) return;

      // Browser content is invalidated by releaseSessions; publishing the canonical removal below
      // drives the native host refresh/stop. completeThread remains reserved for successful turns.
      let changed = yield* releaseSessions((session) => threadIds.has(session.threadId));
      for (const threadId of threadIds) {
        if (state.computerUseItemsByThread.delete(threadId)) changed = true;
        state.admittedThreadGenerations.delete(threadId);
      }

      const preferenceFailures: RemoteHostedPipRuntimeError[] = [];
      if (settlement.action === "delete") {
        for (const threadId of threadIds) {
          const preferenceChanged = yield* Effect.try({
            try: () => ports.preferences.deleteTaskVisibility(threadId),
            catch: (cause) => runtimeError("delete-task-visibility", cause),
          }).pipe(
            Effect.match({
              onFailure: (cause) => {
                preferenceFailures.push(cause);
                return false;
              },
              onSuccess: (deleted) => deleted,
            }),
          );
          if (preferenceChanged) changed = true;
        }
      }
      if (changed) yield* publishSnapshot();
      const preferenceFailure = preferenceFailures[0];
      if (preferenceFailure) return yield* Effect.fail(preferenceFailure);
    });

    const observeUnlocked = Effect.fn("RemoteHostedPipRuntime.observeUnlocked")(function* (
      occurrence: RemoteHostedPipCodexOccurrence,
    ) {
      if (occurrence.hostId !== ports.localHostId) return;
      if (!(yield* advanceGeneration(occurrence.generation))) return;
      const consequence = parseRemoteHostedPipNotification(occurrence.notification);
      if (!consequence) return;
      const admittedGeneration = state.admittedThreadGenerations.get(consequence.threadId);
      if (
        admittedGeneration !== occurrence.generation &&
        consequence.kind !== "browser-use" &&
        consequence.kind !== "computer-use"
      ) {
        return;
      }
      if (
        (consequence.kind === "browser-use" || consequence.kind === "computer-use") &&
        !(yield* admitThread(occurrence.generation, consequence.threadId))
      ) {
        return;
      }

      if (consequence.kind === "browser-use") {
        yield* applyBrowserSurface(occurrence, consequence.threadId, consequence.surface);
        return;
      }
      if (consequence.kind === "computer-use") {
        const before = activeTaskIds();
        const items = state.computerUseItemsByThread.get(consequence.threadId) ?? new Set<string>();
        if (
          consequence.active &&
          (items.has(consequence.itemId) || items.size < MAX_COMPUTER_USE_ITEMS_PER_THREAD) &&
          (state.computerUseItemsByThread.has(consequence.threadId) ||
            state.computerUseItemsByThread.size < MAX_COMPUTER_USE_THREADS)
        ) {
          items.add(consequence.itemId);
        } else items.delete(consequence.itemId);
        if (items.size === 0) state.computerUseItemsByThread.delete(consequence.threadId);
        else state.computerUseItemsByThread.set(consequence.threadId, items);
        if (before.join("\0") !== activeTaskIds().join("\0")) yield* publishSnapshot();
        return;
      }

      if (consequence.kind === "thread-ended") {
        yield* retireCodexThreadsUnlocked({
          action: consequence.deleted ? "delete" : "archive",
          threadIds: [consequence.threadId],
        });
        return;
      }

      const before = activeTaskIds();
      yield* releaseSessions(
        (session) =>
          session.threadId === consequence.threadId && session.generation === occurrence.generation,
      );
      state.computerUseItemsByThread.delete(consequence.threadId);
      if (consequence.kind === "turn-ended") {
        // Native completion is a turn outcome, not a generic presentation teardown signal.
        yield* safeNative(
          consequence.completed ? "complete-thread" : "invalidate-turn",
          consequence.completed
            ? ports.native.completeThread(consequence.threadId)
            : ports.native.invalidateTurn(consequence.threadId, consequence.turnId),
        );
        state.admittedThreadGenerations.delete(consequence.threadId);
      }
      if (before.join("\0") !== activeTaskIds().join("\0")) yield* publishSnapshot();
    });

    const observeCodexOccurrence = (occurrence: RemoteHostedPipCodexOccurrence) =>
      lock
        .withPermits(1)(observeUnlocked(occurrence))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Remote Hosted PiP occurrence was ignored").pipe(
              Effect.annotateLogs({
                generation: occurrence.generation,
                hostId: occurrence.hostId,
                method: occurrence.notification.method,
                cause,
              }),
            ),
          ),
        );

    const takeNextImage = lock.withPermits(1)(
      Effect.sync(() => {
        const oldest = state.pendingImages.entries().next().value as
          | [string, PendingImage]
          | undefined;
        if (!oldest) return null;
        state.pendingImages.delete(oldest[0]);
        state.pendingImageBytes = Math.max(0, state.pendingImageBytes - oldest[1].wireBytes);
        return oldest[1];
      }),
    );

    const processImage = Effect.fn("RemoteHostedPipRuntime.processImage")(function* (
      job: PendingImage,
    ) {
      const validation = yield* Effect.sync(() => validateBrowserPipImage(job.dataUrl));
      if (!validation.accepted) {
        ports.diagnostics.record({
          backend: job.backend,
          ...(job.browserFamily ? { browserFamily: job.browserFamily } : {}),
          operation: "validate-image",
          result: validation.reason,
          revision: state.revision,
          source: job.backend === "chrome" ? "chrome-control" : "browser-use",
          taskId: job.threadId,
        });
        yield* discardFailedImage(job);
        return;
      }
      const candidate = {
        compressedBytes: validation.image.compressedBytes,
        estimatedDecodedBytes: validation.image.estimatedDecodedBytes,
        presentationId: job.presentationId,
        sessionKey: job.sessionKey,
        taskId: job.threadId,
        updatedAt: job.sequence,
      };
      const reservation = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = state.browserSessions.get(job.sessionKey);
          if (
            state.currentGeneration !== job.generation ||
            state.presentationSequences.get(job.presentationId) !== job.sequence ||
            state.admittedThreadGenerations.get(job.threadId) !== job.generation ||
            !session ||
            !hasSameBrowserSource(session, job) ||
            !chromeImageSourceIsConnected(job)
          ) {
            return null;
          }
          const previousLease = state.resourceState.leases.get(job.presentationId) ?? null;
          const admission = admitBrowserPipResource(state.resourceState, candidate);
          if (!admission.admitted) return null;

          const evicted = admission.evicted.map((lease) => ({
            presentationId: lease.presentationId,
            sequence: state.presentationSequences.get(lease.presentationId) ?? null,
          }));
          state.resourceState = admission.state;
          for (const lease of admission.evicted) {
            state.presentationSequences.delete(lease.presentationId);
            state.presentationTargets.delete(lease.presentationId);
            const pending = state.pendingImages.get(lease.presentationId);
            if (pending) state.pendingImageBytes -= pending.wireBytes;
            state.pendingImages.delete(lease.presentationId);
            for (const browserSession of state.browserSessions.values()) {
              for (const [tabId, presentation] of browserSession.presentations) {
                if (presentation.presentationId === lease.presentationId) {
                  browserSession.presentations.delete(tabId);
                }
              }
            }
          }
          state.pendingImageBytes = Math.max(0, state.pendingImageBytes);
          for (const key of [...state.browserSessions.keys()]) pruneEmptyBrowserSession(key);
          if (admission.evicted.length > 0) yield* publishSnapshot();
          return { evicted, previousLease };
        }),
      );
      if (!reservation) {
        ports.diagnostics.record({
          backend: job.backend,
          ...(job.browserFamily ? { browserFamily: job.browserFamily } : {}),
          operation: "admit-image",
          result: "rejected",
          revision: state.revision,
          source: job.backend === "chrome" ? "chrome-control" : "browser-use",
          taskId: job.threadId,
        });
        yield* discardFailedImage(job);
        return;
      }

      // The single image worker establishes native projection order: every selected victim is
      // invalidated before the new image can allocate/decode in the addon.
      for (const evicted of reservation.evicted) {
        yield* safeNative(
          "evict-browser-presentation",
          ports.native.invalidateBrowserPresentation(evicted.presentationId),
        );
      }

      // Native image decode may be expensive; it deliberately runs outside the causal state lock.
      const inserted = yield* ports.native
        .upsertBrowserPresentation({
          appIconPath:
            job.backend === "chrome" && job.browserFamily
              ? ports.resolveChromeBrowserIconPath(job.browserFamily)
              : null,
          backend: job.backend,
          browserFamily: job.browserFamily,
          dataUrl: validation.image.dataUrl,
          presentationId: job.presentationId,
          threadId: job.threadId,
        })
        .pipe(Effect.orElseSucceed(() => false));
      if (!inserted) {
        ports.diagnostics.record({
          backend: job.backend,
          ...(job.browserFamily ? { browserFamily: job.browserFamily } : {}),
          operation: "upsert-image",
          result: "failed",
          revision: state.revision,
          source: job.backend === "chrome" ? "chrome-control" : "browser-use",
          taskId: job.threadId,
        });
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const lease = state.resourceState.leases.get(job.presentationId);
            if (lease?.updatedAt === job.sequence) {
              const leases = new Map(state.resourceState.leases);
              if (reservation.previousLease) {
                leases.set(job.presentationId, reservation.previousLease);
              } else leases.delete(job.presentationId);
              state.resourceState = { leases };
            }
            const snapshotChanged = releaseFailedImage(job);
            if (snapshotChanged || lease?.updatedAt === job.sequence) yield* publishSnapshot();
          }),
        );
        yield* safeNative(
          "discard-failed-browser-presentation",
          ports.native.invalidateBrowserPresentation(job.presentationId),
        );
        return;
      }

      const commit = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const session = state.browserSessions.get(job.sessionKey);
          const reservedLease = state.resourceState.leases.get(job.presentationId);
          if (
            !session ||
            state.currentGeneration !== job.generation ||
            state.presentationSequences.get(job.presentationId) !== job.sequence ||
            state.admittedThreadGenerations.get(job.threadId) !== job.generation ||
            !hasSameBrowserSource(session, job) ||
            !chromeImageSourceIsConnected(job)
          ) {
            if (reservedLease?.updatedAt === job.sequence) {
              const leases = new Map(state.resourceState.leases);
              if (reservation.previousLease) {
                leases.set(job.presentationId, reservation.previousLease);
              } else {
                leases.delete(job.presentationId);
              }
              state.resourceState = { leases };
            }
            const snapshotChanged = releaseFailedImage(job);
            if (snapshotChanged || reservedLease?.updatedAt === job.sequence) {
              yield* publishSnapshot();
            }
            return false;
          }

          if (reservedLease?.updatedAt !== job.sequence) {
            const snapshotChanged = releaseFailedImage(job);
            if (snapshotChanged) yield* publishSnapshot();
            return false;
          }
          if (job.backend !== "cdp") {
            state.presentationTargets.set(job.presentationId, {
              backend: job.backend,
              browserFamily: job.browserFamily,
              browserId: session.browserId,
              extensionInstanceId: job.extensionInstanceId,
              presentationId: job.presentationId,
              tabId: job.tabId,
              threadId: job.threadId,
            });
          }
          session.presentations.set(job.tabId, {
            presentationId: job.presentationId,
            tabId: job.tabId,
          });
          for (const key of [...state.browserSessions.keys()]) pruneEmptyBrowserSession(key);
          yield* publishSnapshot();
          ports.diagnostics.record({
            backend: job.backend,
            ...(job.browserFamily ? { browserFamily: job.browserFamily } : {}),
            operation: "upsert-image",
            result: "committed",
            revision: state.revision,
            source: job.backend === "chrome" ? "chrome-control" : "browser-use",
            taskId: job.threadId,
          });
          return true;
        }),
      );
      if (!commit) {
        yield* safeNative(
          "discard-stale-browser-presentation",
          ports.native.invalidateBrowserPresentation(job.presentationId),
        );
      }
    });

    yield* Effect.forever(
      Queue.take(imageWake).pipe(
        Effect.andThen(
          Effect.forever(
            takeNextImage.pipe(
              Effect.flatMap((job) => (job ? processImage(job) : Effect.fail(null))),
            ),
          ).pipe(Effect.catch(() => Effect.void)),
        ),
      ),
    ).pipe(Effect.forkScoped({ startImmediately: true }));

    const refresh = Effect.try({
      try: ports.legacy.handleBrowserUseStateSnapshot,
      catch: (cause) => runtimeError("refresh", cause),
    }).pipe(Effect.andThen(hostCoordinator?.refresh ?? Effect.void));
    yield* Stream.concat(Stream.make(undefined), ports.browserUseStateSignals).pipe(
      Stream.runForEach(() => refresh.pipe(Effect.catch(() => Effect.void))),
      Effect.forkScoped({ startImmediately: true }),
    );

    const retireLocalCodexHost = (_reason: "connection-lost" | "shutdown") =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const generation = state.currentGeneration;
            if (generation === null) return;
            const changed = yield* retireGeneration(generation);
            state.retiredGeneration = Math.max(state.retiredGeneration, generation);
            state.currentGeneration = null;
            if (changed) yield* publishSnapshot();
          }),
        )
        .pipe(Effect.catchCause(() => Effect.void));

    const releaseChromeExtensionInstance = (input: {
      readonly browserFamily: string;
      readonly extensionInstanceId: string;
    }): Effect.Effect<void> => {
      if (
        input.browserFamily.length === 0 ||
        input.browserFamily.length > 1_024 ||
        input.browserFamily.includes("\0") ||
        input.extensionInstanceId.length === 0 ||
        input.extensionInstanceId.length > 1_024 ||
        input.extensionInstanceId.includes("\0")
      ) {
        return Effect.void;
      }
      return lock.withPermits(1)(
        Effect.gen(function* () {
          const changed = yield* releaseSessions(
            (session) =>
              session.backend === "chrome" &&
              session.browserFamily === input.browserFamily &&
              session.extensionInstanceId === input.extensionInstanceId,
          );
          if (changed) yield* publishSnapshot();
        }),
      );
    };

    yield* Effect.addFinalizer(() => retireLocalCodexHost("shutdown"));

    const mutatePreference = (
      operation: string,
      mutate: () => boolean,
    ): Effect.Effect<void, RemoteHostedPipRuntimeError> =>
      lock.withPermits(1)(
        Effect.try({ try: mutate, catch: (cause) => runtimeError(operation, cause) }).pipe(
          Effect.flatMap((changed) => (changed ? publishSnapshot() : Effect.void)),
        ),
      );

    return RemoteHostedPipRuntime.of({
      deleteTaskVisibility: (taskId) =>
        mutatePreference("delete-task-visibility", () =>
          ports.preferences.deleteTaskVisibility(taskId),
        ),
      diagnosticSnapshot: Effect.sync(() => ports.diagnostics.snapshot()),
      getAlwaysHide: ports.legacy.getAlwaysHide,
      observeCodexOccurrence,
      refresh,
      releaseChromeExtensionInstance,
      reportHostLayout: (webContentsId, layout) =>
        hostCoordinator?.reportLayout(webContentsId, layout) ?? Effect.succeed(false),
      resolveBrowserPresentation: (id) =>
        lock.withPermits(1)(
          Effect.sync(() => {
            if (id.length === 0 || id.length > 8_192) return null;
            return state.presentationTargets.get(id) ?? null;
          }),
        ),
      retireCodexThreads: (settlement) =>
        lock.withPermits(1)(retireCodexThreadsUnlocked(settlement)),
      retireLocalCodexHost,
      revisions: SubscriptionRef.changes(snapshotRef).pipe(
        Stream.map((snapshot) => snapshot.revision),
      ),
      setAlwaysHide: (value) =>
        Effect.suspend(() => {
          const before = ports.preferences.readAlwaysHide();
          return Effect.try({
            try: () => ports.legacy.setAlwaysHide(value),
            catch: (cause) => runtimeError("set-always-hide", cause),
          }).pipe(
            Effect.flatMap(() =>
              before === ports.preferences.readAlwaysHide()
                ? Effect.void
                : lock.withPermits(1)(publishSnapshot()),
            ),
          );
        }),
      setMaxDisplaySize: (value) =>
        mutatePreference("set-max-display-size", () =>
          ports.preferences.writeMaxDisplaySize(value),
        ).pipe(Effect.andThen(hostCoordinator?.refresh ?? Effect.void)),
      setTaskVisibilities: (taskIds, visibility) =>
        mutatePreference("set-task-visibilities", () =>
          ports.preferences.setTaskVisibilities(taskIds, visibility),
        ),
      setTaskVisibility: (taskId, visibility) =>
        mutatePreference("set-task-visibility", () =>
          ports.preferences.setTaskVisibility(taskId, visibility),
        ),
      snapshot: SubscriptionRef.get(snapshotRef),
    });
  });

export const live = (
  options: RemoteHostedPipRuntimeOptions,
): Layer.Layer<
  RemoteHostedPipRuntime,
  never,
  | ChromeControlRuntime
  | CodexGateway
  | CodexThreadHostResolver
  | RemoteHostedPipNativePlatform
  | WindowRuntime
> =>
  Layer.effect(
    RemoteHostedPipRuntime,
    Effect.gen(function* () {
      const chrome = yield* ChromeControlRuntime;
      const gateway = yield* CodexGateway;
      const resolver = yield* CodexThreadHostResolver;
      const native = yield* RemoteHostedPipNativePlatform;
      const windows = yield* WindowRuntime;
      const preferences = makeRemoteHostedPipPreferences(options.preferenceFilePath);
      return yield* makeRuntime({
        browserUseStateSignals: options.browserSidebarEvents.events.pipe(
          Stream.filter((event) => event.kind === "browserUseState"),
        ),
        host: {
          isThreadSurfacePresented: options.isThreadSurfacePresented,
          native,
          windows,
        },
        legacy: {
          getAlwaysHide: preferences.readAlwaysHide,
          handleBrowserUseStateSnapshot: () => undefined,
          setAlwaysHide: (value) => void preferences.writeAlwaysHide(value),
        },
        isChromeExtensionConnected: chrome.isConnectedInstance,
        diagnostics: new RemoteHostedPipDiagnostics({ salt: options.preferenceFilePath }),
        localHostId: gateway.localHostId,
        native: {
          completeThread: native.completeThread,
          invalidateBrowserPresentation: native.invalidateBrowserContent,
          invalidateTurn: native.invalidateTurn,
          upsertBrowserPresentation: (input) =>
            native.upsertBrowserContent({
              appIconPath: input.appIconPath,
              imageDataUrl: input.dataUrl,
              presentationId: input.presentationId,
              threadId: input.threadId,
            }),
        },
        preferences,
        resolveChromeBrowserIconPath: chrome.resolveBrowserIconPath,
        resolveThreadHost: (threadId) =>
          resolver
            .resolve(threadId)
            .pipe(
              Effect.mapError((cause) => new RemoteHostedPipThreadHostResolutionError({ cause })),
            ),
      });
    }),
  );

export interface RemoteHostedPipRuntimeTestOptions {
  readonly browserUseStateSignals?: Stream.Stream<unknown>;
  readonly legacy: RemoteHostedPipLegacyPort;
  readonly localHostId?: string;
  readonly isChromeExtensionConnected?: (
    browserFamily: string,
    extensionInstanceId: string,
  ) => boolean;
  readonly native?: Partial<RemoteHostedPipNativePort>;
  readonly preferences: RemoteHostedPipPreferencesAdapter;
  readonly resolveChromeBrowserIconPath?: (browserFamily: string) => string | null;
  readonly resolveThreadHost?: (
    threadId: string,
  ) => Effect.Effect<string, RemoteHostedPipThreadHostResolutionError>;
}

export const testLayer = (
  options: RemoteHostedPipRuntimeTestOptions,
): Layer.Layer<RemoteHostedPipRuntime> =>
  Layer.effect(
    RemoteHostedPipRuntime,
    makeRuntime({
      browserUseStateSignals: options.browserUseStateSignals ?? Stream.empty,
      isChromeExtensionConnected: options.isChromeExtensionConnected ?? (() => true),
      legacy: options.legacy,
      diagnostics: new RemoteHostedPipDiagnostics({ salt: "remote-hosted-pip-test" }),
      localHostId: options.localHostId ?? "local",
      native: {
        completeThread: options.native?.completeThread ?? (() => Effect.succeed(true)),
        invalidateBrowserPresentation:
          options.native?.invalidateBrowserPresentation ?? (() => Effect.succeed(true)),
        invalidateTurn: options.native?.invalidateTurn ?? (() => Effect.succeed(true)),
        upsertBrowserPresentation:
          options.native?.upsertBrowserPresentation ?? (() => Effect.succeed(true)),
      },
      preferences: options.preferences,
      resolveChromeBrowserIconPath: options.resolveChromeBrowserIconPath ?? (() => null),
      resolveThreadHost:
        options.resolveThreadHost ?? (() => Effect.succeed(options.localHostId ?? "local")),
    }),
  );
