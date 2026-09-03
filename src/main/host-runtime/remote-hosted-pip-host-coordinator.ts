import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { BrowserWindow } from "electron";
import type {
  RemoteHostedPipHostLayout,
  RemoteHostedPipTaskStateSnapshot,
} from "../../shared/remote-hosted-pip";
import { REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID } from "../../shared/remote-hosted-pip";
import type { RemoteHostedPipPreferencesAdapter } from "../remote-hosted-pip-preference-store";
import type {
  RemoteHostedPipNativePlatformError,
  RemoteHostedPipNativePlatformService,
} from "../platform/electron/RemoteHostedPipNativePlatform";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import { selectPreferredWindowRuntimeWindow } from "../window-runtime/window-runtime-lifecycle";
import { getLogger } from "../logging/logger";

const logger = getLogger({ subsystem: "remote-hosted-pip-hosts" });
const AVATAR_HOST_ID = "avatar-overlay";

interface HostedLayout {
  readonly hostId: string;
  readonly layout: RemoteHostedPipHostLayout;
}

interface NativeVisibilityProjection {
  readonly activeTaskIds: readonly string[];
  readonly alwaysHidden: boolean;
  readonly taskVisibilities: Readonly<Record<string, "hidden" | "shown">>;
}

export interface RemoteHostedPipHostCoordinator {
  readonly reportLayout: (
    webContentsId: number,
    layout: RemoteHostedPipHostLayout | null,
  ) => Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<void>;
}

export interface RemoteHostedPipHostCoordinatorOptions {
  readonly isThreadSurfacePresented: (threadId: string, ownerWebContentsId?: number) => boolean;
  readonly native: RemoteHostedPipNativePlatformService;
  readonly preferences: RemoteHostedPipPreferencesAdapter;
  readonly readSnapshot: () => RemoteHostedPipTaskStateSnapshot;
  readonly windows: WindowRuntimeService;
}

function registrationIdentity(window: BrowserWindow, hosted: HostedLayout): string {
  const bounds = window.getContentBounds();
  return JSON.stringify({
    bounds,
    hostId: hosted.hostId,
    layout: hosted.layout,
    title: window.getTitle(),
  });
}

/**
 * Owns the native host lifecycle and window registry projection. Renderer geometry is only an
 * input: canonical focus, task identity and native handles always come from WindowRuntime/Main.
 */
export function makeRemoteHostedPipHostCoordinator(
  options: RemoteHostedPipHostCoordinatorOptions,
): Effect.Effect<RemoteHostedPipHostCoordinator, never, Scope.Scope> {
  return Effect.gen(function* () {
    const layouts = new Map<number, HostedLayout>();
    const registered = new Map<number, { readonly hostId: string; readonly identity: string }>();
    const signal = yield* Queue.sliding<void>(1);
    const lock = yield* Semaphore.make(1);
    let started = false;
    let visibilityProjection: NativeVisibilityProjection | null = null;

    const logFailure = (operation: string, cause: unknown): Effect.Effect<void> =>
      Effect.sync(() => logger.warn("Native PiP host projection failed", { cause, operation }));

    const bestEffort = <A>(
      operation: string,
      effect: Effect.Effect<A, RemoteHostedPipNativePlatformError>,
    ): Effect.Effect<A | null> =>
      effect.pipe(
        Effect.matchEffect({
          onFailure: (cause) => logFailure(operation, cause).pipe(Effect.as(null)),
          onSuccess: (value) => Effect.succeed(value),
        }),
      );

    const unregister = Effect.fn("RemoteHostedPipHostCoordinator.unregister")(function* (
      webContentsId: number,
    ) {
      const current = registered.get(webContentsId);
      if (!current) return;
      registered.delete(webContentsId);
      if (!started) return;
      yield* bestEffort("unregister-host", options.native.unregisterHost(current.hostId));
    });

    const stop = Effect.fn("RemoteHostedPipHostCoordinator.stop")(function* () {
      if (!started) return;
      for (const webContentsId of [...registered.keys()]) yield* unregister(webContentsId);
      yield* bestEffort("stop-host", options.native.stopHost);
      started = false;
      visibilityProjection = null;
    });

    const reconcile = lock.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = options.readSnapshot();
        const windowSnapshot = options.windows.snapshot();
        for (const webContentsId of [...layouts.keys()]) {
          const window = options.windows.getRegisteredWindow(webContentsId);
          if (window && !window.isDestroyed()) continue;
          layouts.delete(webContentsId);
          yield* unregister(webContentsId);
        }

        const preferredPrimary = selectPreferredWindowRuntimeWindow(
          windowSnapshot,
          (window) => window.kind === "primary" && layouts.has(window.webContentsId),
        );
        const eligibleWebContentsIds = new Set<number>();
        if (preferredPrimary?.kind === "primary") {
          eligibleWebContentsIds.add(preferredPrimary.webContentsId);
        }
        for (const window of windowSnapshot.windows) {
          if (
            window.kind === "auxiliary" &&
            window.role === "avatar-overlay" &&
            layouts.has(window.webContentsId)
          ) {
            eligibleWebContentsIds.add(window.webContentsId);
          }
        }
        const hasEligibleHost = eligibleWebContentsIds.size > 0;
        const shouldStart =
          options.native.availability.status === "available" &&
          snapshot.activeTaskIds.length > 0 &&
          hasEligibleHost;
        if (!shouldStart) {
          yield* stop();
          return;
        }

        if (!started) {
          const didStart = yield* bestEffort(
            "start-host",
            options.native.startHost({
              closeTooltip: "Return Picture-in-Picture to Nodex",
              hide: "Hide",
              hideForAllActiveTasks: "Hide for all active tasks",
              hideForTask: "Hide for this task",
              placementTooltip: "Send Picture-in-Picture to Pet",
            }),
          );
          if (didStart !== true) return;
          started = true;
        }

        for (const webContentsId of [...registered.keys()]) {
          if (!eligibleWebContentsIds.has(webContentsId)) yield* unregister(webContentsId);
        }

        const maxDisplaySize = options.preferences.readMaxDisplaySize();
        if (maxDisplaySize !== null) {
          yield* bestEffort(
            "set-max-display-size",
            options.native.setMaxDisplaySize(maxDisplaySize),
          );
        }

        for (const webContentsId of eligibleWebContentsIds) {
          const hosted = layouts.get(webContentsId);
          if (!hosted) continue;
          const window = options.windows.getRegisteredWindow(webContentsId);
          if (!window || window.isDestroyed()) continue;
          const identity = registrationIdentity(window, hosted);
          if (registered.get(webContentsId)?.identity === identity) continue;
          const previous = registered.get(webContentsId);
          if (previous && previous.hostId !== hosted.hostId) yield* unregister(webContentsId);
          const spring = hosted.layout.animationSpring;
          const hasPresentation = hosted.layout.animated
            ? yield* bestEffort("has-any-presentation", options.native.hasAnyPresentation)
            : false;
          const didRegister = yield* bestEffort(
            "register-host",
            options.native.registerHost({
              anchors: hosted.layout.anchors,
              anchorRect: hosted.layout.anchorRect,
              animated: hosted.layout.animated && hasPresentation === true,
              animationSpring: spring
                ? {
                    damping: spring.damping,
                    initialVelocity: spring.initialVelocity,
                    mass: spring.mass,
                    stiffness: spring.stiffness,
                  }
                : null,
              contentBounds: window.getContentBounds(),
              id: hosted.hostId,
              interactionPassthroughRect: hosted.layout.interactionPassthroughRect ?? null,
              isCodexHomeAvailable: hosted.layout.isCodexHomeAvailable ?? false,
              nativeWindowHandle: window.getNativeWindowHandle(),
              presentationScope: hosted.layout.presentationScope,
              title: window.getTitle(),
            }),
          );
          if (didRegister === true)
            registered.set(webContentsId, { hostId: hosted.hostId, identity });
        }

        const hidden = Object.entries(snapshot.taskVisibilities)
          .filter(([, visibility]) => visibility === "hidden")
          .map(([taskId]) => taskId);
        const preferredOwnerWebContentsId =
          preferredPrimary?.kind === "primary" ? preferredPrimary.webContentsId : undefined;
        const surfaceSuppressed =
          preferredOwnerWebContentsId === undefined
            ? []
            : snapshot.activeTaskIds.filter((taskId) =>
                options.isThreadSurfacePresented(taskId, preferredOwnerWebContentsId),
              );
        const suppressed = [...new Set([...hidden, ...surfaceSuppressed])].sort();
        yield* bestEffort(
          "set-suppressed-threads",
          options.native.setSuppressedThreadIds(suppressed),
        );

        const activeThreadId =
          preferredPrimary?.kind === "primary" &&
          registered.has(preferredPrimary.webContentsId) &&
          preferredPrimary.activeSessionId &&
          snapshot.activeTaskIds.includes(preferredPrimary.activeSessionId) &&
          !options.isThreadSurfacePresented(
            preferredPrimary.activeSessionId,
            preferredPrimary.webContentsId,
          )
            ? preferredPrimary.activeSessionId
            : null;
        yield* bestEffort("set-active-thread", options.native.setActiveThreadId(activeThreadId));

        const nextVisibilityProjection: NativeVisibilityProjection = {
          activeTaskIds: [...snapshot.activeTaskIds],
          alwaysHidden: snapshot.alwaysHidden,
          taskVisibilities: { ...snapshot.taskVisibilities },
        };
        if (visibilityProjection?.alwaysHidden !== snapshot.alwaysHidden) {
          const refreshed = yield* bestEffort(
            "refresh-visibility",
            visibilityProjection === null
              ? options.native.refreshVisibility(snapshot.activeTaskIds)
              : options.native.refreshVisibility(),
          );
          if (refreshed === true) visibilityProjection = nextVisibilityProjection;
          return;
        }

        const changedTaskIds = new Set<string>();
        const previousActiveTaskIds = new Set(visibilityProjection.activeTaskIds);
        const nextActiveTaskIds = new Set(snapshot.activeTaskIds);
        for (const taskId of new Set([...previousActiveTaskIds, ...nextActiveTaskIds])) {
          if (previousActiveTaskIds.has(taskId) !== nextActiveTaskIds.has(taskId)) {
            changedTaskIds.add(taskId);
          }
        }
        for (const taskId of new Set([
          ...Object.keys(visibilityProjection.taskVisibilities),
          ...Object.keys(snapshot.taskVisibilities),
        ])) {
          if (visibilityProjection.taskVisibilities[taskId] !== snapshot.taskVisibilities[taskId]) {
            changedTaskIds.add(taskId);
          }
        }
        if (changedTaskIds.size === 0) return;
        const refreshed = yield* bestEffort(
          "refresh-visibility",
          options.native.refreshVisibility([...changedTaskIds].sort()),
        );
        if (refreshed === true) visibilityProjection = nextVisibilityProjection;
      }),
    );

    options.native.setShouldShowTask((taskId) => {
      const snapshot = options.readSnapshot();
      return (
        started &&
        !snapshot.alwaysHidden &&
        snapshot.activeTaskIds.includes(taskId) &&
        snapshot.taskVisibilities[taskId] !== "hidden"
      );
    });

    yield* Effect.forever(Queue.take(signal).pipe(Effect.andThen(reconcile))).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* options.windows.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.kind === "released") layouts.delete(event.window.webContentsId);
        }).pipe(Effect.andThen(Queue.offer(signal, undefined))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.addFinalizer(() =>
      lock
        .withPermits(1)(stop())
        .pipe(Effect.andThen(Queue.shutdown(signal))),
    );

    return {
      refresh: Queue.offer(signal, undefined).pipe(Effect.asVoid),
      reportLayout: (webContentsId, layout) =>
        Effect.sync(() => {
          const window = options.windows.getRegisteredWindow(webContentsId);
          if (!window || window.isDestroyed()) return false;
          const registeredWindow = options.windows
            .snapshot()
            .windows.find((candidate) => candidate.webContentsId === webContentsId);
          if (!registeredWindow) return false;
          if (!layout || layout.anchors === null || layout.anchorRect === null) {
            layouts.delete(webContentsId);
          } else if (registeredWindow.kind === "primary") {
            layouts.set(webContentsId, {
              hostId: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
              layout: {
                ...layout,
                animationSpring: undefined,
                hostId: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
                interactionPassthroughRect: null,
                presentationScope: "thread",
              },
            });
          } else if (registeredWindow.role === "avatar-overlay") {
            layouts.set(webContentsId, {
              hostId: AVATAR_HOST_ID,
              layout: { ...layout, hostId: AVATAR_HOST_ID, presentationScope: "all" },
            });
          } else {
            return false;
          }
          return true;
        }).pipe(Effect.tap(() => Queue.offer(signal, undefined))),
    };
  });
}
