import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import { resolveBrowserUseHostCapability } from "../../shared/browser-use-host-capability";
import type { BrowserSidebarEvent } from "../browser/BrowserSidebarEventHub";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { makeBrowserUseIabApi } from "../browser-use/browser-use-iab-api";
import { makeBrowserUseNativePipeServer } from "../browser-use/browser-use-native-pipe-server";
import { createBrowserUsePeerAuthorizer } from "../browser-use/browser-use-peer-authorizer";
import {
  makeBrowserUseSessionRuntime,
  type BrowserUseCursorArrivalInput,
  type BrowserUseRouteCapture,
  type BrowserUseSessionRuntime,
} from "../browser-use/browser-use-session-runtime";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import { getLogger } from "../logging/logger";
import { BrowserProfileRuntime } from "./BrowserProfileRuntime";
import { ChromeControlRuntime } from "./ChromeControlRuntime";

export class BrowserUseRuntimeError extends Schema.TaggedError<BrowserUseRuntimeError>()(
  "BrowserUseRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class BrowserUseRuntime extends Context.Service<
  BrowserUseRuntime,
  {
    readonly availableBackends: () => readonly BrowserRuntimeBackend[];
    readonly captureRoute: (
      input: BrowserUseRouteCapture,
    ) => Effect.Effect<void, BrowserUseRuntimeError>;
    readonly focusPresentation: (input: {
      readonly sessionId: string;
      readonly tabId: number;
    }) => Effect.Effect<boolean, BrowserUseRuntimeError>;
    readonly promoteRoute: (input: {
      readonly browserConversationId: string;
      readonly browserViewScopeId: string;
      readonly codexSessionId: string;
      readonly projectId: string | null;
    }) => Effect.Effect<void, BrowserUseRuntimeError>;
    readonly releaseSession: (sessionId: string) => Effect.Effect<void, BrowserUseRuntimeError>;
    readonly turnEnded: (input: {
      readonly sessionId: string;
      readonly turnId: string;
    }) => Effect.Effect<void, BrowserUseRuntimeError>;
    readonly turnStarted: (input: {
      readonly sessionId: string;
      readonly turnId: string;
    }) => Effect.Effect<void, BrowserUseRuntimeError>;
  }
>()("nodex/main/host-runtime/BrowserUseRuntime") {}

interface BrowserUseRegistryPort {
  readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  readonly captureRoute: (
    input: BrowserUseRouteCapture,
  ) => Effect.Effect<unknown, BrowserUseRuntimeError>;
  readonly focusPresentation: (input: {
    readonly sessionId: string;
    readonly tabId: number;
  }) => Effect.Effect<boolean, BrowserUseRuntimeError>;
  readonly notifyCursorArrived: (
    input: BrowserUseCursorArrivalInput,
  ) => Effect.Effect<void, BrowserUseRuntimeError>;
  readonly releaseOwner: (
    ownerWebContentsId: number,
  ) => Effect.Effect<void, BrowserUseRuntimeError>;
  readonly releaseSession: (sessionId: string) => Effect.Effect<void, BrowserUseRuntimeError>;
  readonly turnEnded: (input: {
    sessionId: string;
    turnId: string;
  }) => Effect.Effect<void, BrowserUseRuntimeError>;
  readonly turnStarted: (input: {
    sessionId: string;
    turnId: string;
  }) => Effect.Effect<void, BrowserUseRuntimeError>;
}

export interface BrowserUseRuntimePorts {
  readonly browserEvents: Stream.Stream<BrowserSidebarEvent>;
  readonly chromeProviderReady?: () => boolean;
  readonly makeRegistry: Effect.Effect<BrowserUseRegistryPort, BrowserUseRuntimeError, Scope.Scope>;
  readonly releaseCredentialOwner: (ownerWebContentsId: number) => Effect.Effect<void>;
}

const adaptSessionRuntime = (runtime: BrowserUseSessionRuntime): BrowserUseRegistryPort => {
  const adapt = <A>(effect: Effect.Effect<A, { readonly operation: string }>) =>
    effect.pipe(
      Effect.mapError((cause) => new BrowserUseRuntimeError({ operation: cause.operation, cause })),
    );
  return {
    availableBackends: runtime.availableBackends,
    captureRoute: (input) => adapt(runtime.captureRoute(input)),
    focusPresentation: (input) => adapt(runtime.focusPresentation(input)),
    notifyCursorArrived: (input) => adapt(runtime.notifyCursorArrived(input)),
    releaseOwner: (ownerWebContentsId) => adapt(runtime.releaseOwner(ownerWebContentsId)),
    releaseSession: (sessionId) => adapt(runtime.releaseSession(sessionId)),
    turnEnded: (input) => adapt(runtime.turnEnded(input)),
    turnStarted: (input) => adapt(runtime.turnStarted(input)),
  };
};

const logFailure = (operation: string, cause: unknown): Effect.Effect<void> =>
  Effect.logWarning("Browser Use runtime operation failed").pipe(
    Effect.annotateLogs({ operation, error: String(cause) }),
  );

const make = (
  ports: BrowserUseRuntimePorts,
): Effect.Effect<BrowserUseRuntime["Service"], BrowserUseRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* ports.makeRegistry;
    const capturedRoutes = yield* Ref.make<ReadonlyMap<string, BrowserUseRouteCapture>>(new Map());
    const routeLock = yield* Semaphore.make(1);

    const captureRouteUnlocked = Effect.fn("BrowserUseRuntime.captureRouteUnlocked")(function* (
      input: BrowserUseRouteCapture,
    ) {
      if (registry.availableBackends().length === 0) return;
      yield* registry.captureRoute(input).pipe(Effect.asVoid);
      yield* Ref.update(capturedRoutes, (current) =>
        new Map(current).set(input.browserViewScopeId, input),
      );
    });

    const captureRoute = (input: BrowserUseRouteCapture) =>
      routeLock.withPermits(1)(captureRouteUnlocked(input));

    const promoteRoute = Effect.fn("BrowserUseRuntime.promoteRoute")(
      (input: {
        readonly browserConversationId: string;
        readonly browserViewScopeId: string;
        readonly codexSessionId: string;
        readonly projectId: string | null;
      }) =>
        routeLock.withPermits(1)(
          Effect.gen(function* () {
            const captured = (yield* Ref.get(capturedRoutes)).get(input.browserViewScopeId);
            if (!captured) {
              return yield* new BrowserUseRuntimeError({
                operation: "promote-route",
                cause: new Error("Browser Use route is unavailable"),
              });
            }
            if (captured.browserConversationId !== input.browserConversationId) {
              return yield* new BrowserUseRuntimeError({
                operation: "promote-route",
                cause: new Error("Browser Use route belongs to another presentation surface"),
              });
            }
            yield* captureRouteUnlocked({ ...captured, ...input });
          }),
        ),
    );

    yield* ports.browserEvents.pipe(
      Stream.runForEach((event) => {
        if (event.kind === "browserUseOwnerReleased") {
          return ports.releaseCredentialOwner(event.value.ownerWebContentsId).pipe(
            Effect.andThen(registry.releaseOwner(event.value.ownerWebContentsId)),
            Effect.ensuring(
              routeLock.withPermits(1)(
                Ref.update(
                  capturedRoutes,
                  (current) =>
                    new Map(
                      [...current].filter(
                        ([, route]) => route.ownerWebContentsId !== event.value.ownerWebContentsId,
                      ),
                    ),
                ),
              ),
            ),
            Effect.catch((error) => logFailure(error.operation, error.cause)),
          );
        }
        if (event.kind !== "browserUseCursorArrived" || event.value.ownerWebContentsId === null) {
          return Effect.void;
        }
        return registry
          .notifyCursorArrived({
            ...event.value,
            ownerWebContentsId: event.value.ownerWebContentsId,
          })
          .pipe(Effect.catch((error) => logFailure(error.operation, error.cause)));
      }),
      Effect.forkScoped({ startImmediately: true }),
    );

    const availableBackends = (): readonly BrowserRuntimeBackend[] => {
      const backends = registry.availableBackends().filter((backend) => backend !== "chrome");
      if (ports.chromeProviderReady?.()) return [...backends, "chrome"];
      return backends;
    };

    return BrowserUseRuntime.of({
      availableBackends,
      captureRoute,
      focusPresentation: registry.focusPresentation,
      promoteRoute,
      releaseSession: registry.releaseSession,
      turnEnded: registry.turnEnded,
      turnStarted: registry.turnStarted,
    });
  });

export interface BrowserUseRuntimeOptions {
  readonly appVersion: string;
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}

export const live = (
  options: BrowserUseRuntimeOptions,
): Layer.Layer<
  BrowserUseRuntime,
  BrowserUseRuntimeError,
  BrowserApplication | BrowserProfileRuntime | ChromeControlRuntime | ScopedCallbackRuntime
> =>
  Layer.effect(
    BrowserUseRuntime,
    Effect.gen(function* () {
      const browser = yield* BrowserApplication;
      const chrome = yield* ChromeControlRuntime;
      const profile = yield* BrowserProfileRuntime;
      const callbacks = yield* ScopedCallbackRuntime;
      const capability = resolveBrowserUseHostCapability({
        browserRuntimeStatus: options.browserRuntime.status,
        environment: options.environment,
        isPackaged: options.isPackaged,
        platform: options.platform,
      });
      const logger = getLogger({ component: "browser-use-runtime" });
      logger.info("Browser Use host capability resolved", {
        availableBackends: capability.availableBackends,
        peerVerificationMode: capability.peerAuthorizationMode,
        reason: capability.status === "unavailable" ? capability.reason : null,
        runtimeStatus: options.browserRuntime.status,
        status: capability.status,
      });
      const socketPeerAuthorizer = createBrowserUsePeerAuthorizer({
        addonPath:
          capability.status === "available" && options.browserRuntime.status === "available"
            ? options.browserRuntime.bundle.paths.peerAuthorization
            : null,
        mode: capability.peerAuthorizationMode,
        platform: options.platform,
      });
      return yield* make({
        browserEvents: browser.events.events,
        chromeProviderReady: chrome.available,
        releaseCredentialOwner: profile.credentials.releaseOwner,
        makeRegistry: (() => {
          const appSessionId = randomUUID();
          const runtime = makeBrowserUseSessionRuntime(capability.status === "available", {
            createApi: (route, asyncRuntime) =>
              makeBrowserUseIabApi({
                appSessionId,
                appVersion: options.appVersion,
                applyCommand: (command) => callbacks.runPromise(browser.applyCommand(command)),
                asyncRuntime,
                browser: browser.automation,
                subscribeWebviewAttached: (listener) =>
                  browser.events.subscribeWebviewAttached(listener),
                buildFlavor:
                  options.browserRuntime.status === "available"
                    ? options.browserRuntime.bundle.manifest.buildFlavor
                    : "unavailable",
                grantDownload: profile.download.grantAgentDownload,
                policyStore: profile.policy,
                route,
              }),
            createServer: (handler) =>
              makeBrowserUseNativePipeServer({
                events: {
                  onAuthorizationError: (error) =>
                    logger.warn("Browser Use native pipe peer authorization failed", {
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  onInvalidMessage: (error) =>
                    logger.warn("Browser Use native pipe received an invalid message", {
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  onListening: () => logger.info("Browser Use native pipe listening"),
                  onRejectedSocket: (result) =>
                    logger.warn("Browser Use native pipe rejected a socket peer", {
                      reason: result.reason ?? "unauthorized",
                    }),
                  onRequestCompleted: (event) =>
                    logger.debug("Browser Use native pipe request completed", event),
                  onRequestStarted: (event) =>
                    logger.debug("Browser Use native pipe request started", event),
                  onSocketError: (error) =>
                    logger.warn("Browser Use native pipe socket failed", {
                      error: error.message,
                    }),
                },
                handler,
                platform: options.platform,
                socketPeerAuthorizer,
              }),
          });
          return runtime.pipe(
            Effect.map((sessionRuntime): BrowserUseRegistryPort =>
              adaptSessionRuntime(sessionRuntime),
            ),
          );
        })(),
      });
    }),
  );

export const testLayer = (
  ports: BrowserUseRuntimePorts,
): Layer.Layer<BrowserUseRuntime, BrowserUseRuntimeError> =>
  Layer.effect(BrowserUseRuntime, make(ports));
