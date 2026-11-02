import { hostCapabilities } from "../../shared/host-capabilities";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { BrowserWindow, DesktopCapturerSource } from "electron";
import type {
  CodexComposerAppshotContext,
  CodexComposerAppshotTarget,
  CodexComposerAppshotTargetResult,
} from "../../shared/types";
import { MainConfig } from "../app/MainConfig";
import {
  createComposerAppshotImageName,
  findComposerAppshotSource,
  makeComposerAppshotLivePlatform,
  resolveComposerAppshotCaptureSize,
  resolveComposerAppshotWindowTitle,
  type ComposerAppshotHelperTarget,
  type ComposerAppshotPlatform,
} from "../composer-appshot-platform";
import { getLogger } from "../logging/logger";

const TARGET_HANDLE_LIMIT = 8;

interface StoredComposerAppshotTarget {
  readonly id: string;
  readonly target: ComposerAppshotHelperTarget;
  readonly iconSmallDataUrl: string | null;
}

interface ComposerAppshotState {
  readonly closed: boolean;
  readonly focusedWindowIds: ReadonlySet<number>;
  readonly latestTarget: StoredComposerAppshotTarget | null;
  readonly targets: ReadonlyMap<string, StoredComposerAppshotTarget>;
}

type RefreshEffect = Effect.Effect<StoredComposerAppshotTarget | null, ComposerAppshotRuntimeError>;

interface RefreshSelection {
  readonly effect: RefreshEffect;
  readonly owner: boolean;
}

export interface ComposerAppshotTiming {
  readonly trackingIntervalMs: number;
  readonly trackingStartDelayMs: number;
}

const defaultTiming: ComposerAppshotTiming = {
  trackingIntervalMs: 750,
  trackingStartDelayMs: 120,
};

export class ComposerAppshotRuntimeError extends Schema.TaggedError<ComposerAppshotRuntimeError>()(
  "ComposerAppshotRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ComposerAppshotRuntime extends Context.Service<
  ComposerAppshotRuntime,
  {
    readonly readTarget: Effect.Effect<
      CodexComposerAppshotTargetResult,
      ComposerAppshotRuntimeError
    >;
    readonly capture: (
      targetId: string,
    ) => Effect.Effect<CodexComposerAppshotContext, ComposerAppshotRuntimeError>;
    /** Registers a Window-owned observation with the process-scoped Appshot owner. */
    readonly observeWindow: (window: BrowserWindow) => void;
  }
>()("nodex/main/host-runtime/ComposerAppshotRuntime") {}

const initialState = (): ComposerAppshotState => ({
  closed: false,
  focusedWindowIds: new Set(),
  latestTarget: null,
  targets: new Map(),
});

const toPublicTarget = (stored: StoredComposerAppshotTarget): CodexComposerAppshotTarget => ({
  id: stored.id,
  appName: stored.target.name,
  bundleIdentifier: stored.target.bundleIdentifier,
  windowTitle: stored.target.windowTitle,
  iconSmallDataUrl: stored.iconSmallDataUrl,
});

export const liveWithPlatform = (
  platform: ComposerAppshotPlatform,
  timing: ComposerAppshotTiming = defaultTiming,
): Layer.Layer<ComposerAppshotRuntime> =>
  Layer.effect(
    ComposerAppshotRuntime,
    Effect.gen(function* () {
      const logger = getLogger({ subsystem: "composer", component: "appshot-runtime" });
      const state = yield* Ref.make<ComposerAppshotState>(initialState());
      const refreshInFlight = yield* Ref.make<RefreshEffect | null>(null);
      const focusLock = yield* Semaphore.make(1);
      const callbackFibers = yield* FiberSet.make();
      const runCallback = yield* FiberSet.runtime(callbackFibers)();
      const trackingFiber = yield* FiberHandle.make<void, never>();
      const observerReleases = new Set<() => void>();
      let acceptingCallbacks = true;

      const error = (operation: string, cause: unknown) =>
        new ComposerAppshotRuntimeError({ operation, cause });
      const fromPlatformPromise = <A>(
        operation: string,
        run: (signal: AbortSignal) => Promise<A>,
      ) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => error(operation, cause),
        });
      const available = Effect.gen(function* () {
        if ((yield* Ref.get(state)).closed || !hostCapabilities(platform.platform).appshot)
          return false;
        return yield* Effect.try({
          try: platform.helperAvailable,
          catch: (cause) => error("check-availability", cause),
        });
      });

      const readAndStoreTarget: RefreshEffect = fromPlatformPromise(
        "read-frontmost-window",
        platform.readFrontmostWindow,
      ).pipe(
        Effect.flatMap((candidate) =>
          Ref.modify(
            state,
            (current): readonly [StoredComposerAppshotTarget | null, ComposerAppshotState] => {
              if (current.closed) return [null, current];
              if (!candidate || candidate.processIdentifier === platform.processIdentifier) {
                return [current.latestTarget, current];
              }
              const existing = current.latestTarget;
              const id =
                existing &&
                existing.target.processIdentifier === candidate.processIdentifier &&
                existing.target.windowId === candidate.windowId
                  ? existing.id
                  : platform.createId();
              const stored: StoredComposerAppshotTarget = {
                id,
                target: candidate,
                iconSmallDataUrl: existing?.id === id ? existing.iconSmallDataUrl : null,
              };
              const targets = new Map(current.targets);
              targets.delete(id);
              targets.set(id, stored);
              while (targets.size > TARGET_HANDLE_LIMIT) {
                const oldest = targets.keys().next().value;
                if (typeof oldest !== "string") break;
                targets.delete(oldest);
              }
              return [stored, { ...current, latestTarget: stored, targets }];
            },
          ),
        ),
      );

      const refresh: RefreshEffect = Effect.gen(function* () {
        const candidate = yield* Effect.cached(readAndStoreTarget);
        const selection = yield* Ref.modify<RefreshEffect | null, RefreshSelection>(
          refreshInFlight,
          (current) =>
            current === null
              ? [{ effect: candidate, owner: true }, candidate]
              : [{ effect: current, owner: false }, current],
        );
        if (!selection.owner) return yield* selection.effect;
        return yield* selection.effect.pipe(
          Effect.ensuring(
            Ref.update(refreshInFlight, (current) =>
              current === selection.effect ? null : current,
            ),
          ),
        );
      });

      const listWindowSources = (
        thumbnailSize: { readonly width: number; readonly height: number },
        operation: string,
      ): Effect.Effect<readonly DesktopCapturerSource[], ComposerAppshotRuntimeError> =>
        fromPlatformPromise(operation, () => platform.listWindowSources(thumbnailSize));

      const hydrateTargetIcon = (
        stored: StoredComposerAppshotTarget,
      ): Effect.Effect<StoredComposerAppshotTarget> => {
        if (stored.iconSmallDataUrl) return Effect.succeed(stored);
        return Effect.gen(function* () {
          const sources = yield* listWindowSources({ width: 0, height: 0 }, "read-target-icon");
          const source = findComposerAppshotSource(sources, stored.target);
          const iconSmallDataUrl =
            source?.appIcon && !source.appIcon.isEmpty()
              ? source.appIcon.resize({ width: 32, height: 32 }).toDataURL()
              : null;
          if (!iconSmallDataUrl) return stored;
          return yield* Ref.modify(state, (current) => {
            const currentTarget = current.targets.get(stored.id);
            if (current.closed || !currentTarget) return [stored, current] as const;
            const hydrated = { ...currentTarget, iconSmallDataUrl };
            const targets = new Map(current.targets);
            targets.set(hydrated.id, hydrated);
            return [
              hydrated,
              {
                ...current,
                latestTarget:
                  current.latestTarget?.id === hydrated.id ? hydrated : current.latestTarget,
                targets,
              },
            ] as const;
          });
        }).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              logger.debug("Could not resolve the Appshot target icon", { error: failure.cause });
              return stored;
            }),
          ),
        );
      };

      const readTarget = Effect.gen(function* () {
        if (!(yield* available)) return { available: false, target: null } as const;
        const target = yield* refresh;
        if (!target) return { available: true, target: null } as const;
        const hydrated = yield* hydrateTargetIcon(target);
        return { available: true, target: toPublicTarget(hydrated) } as const;
      });

      const capture = Effect.fn("ComposerAppshotRuntime.capture")(function* (targetId: string) {
        const current = yield* Ref.get(state);
        if (current.closed) {
          return yield* error(
            "capture",
            new Error("Appshots are unavailable while Nodex is closing"),
          );
        }
        if (!(yield* available)) {
          return yield* error("capture", new Error("Appshots are unavailable on this device"));
        }
        const stored = current.targets.get(targetId);
        if (!stored) {
          return yield* error("capture", new Error("The Appshot target is no longer available"));
        }
        const thumbnailSize = yield* Effect.try({
          try: () =>
            resolveComposerAppshotCaptureSize({
              bounds: stored.target.bounds,
              scaleFactor: platform.displayScaleFactor(stored.target.bounds),
            }),
          catch: (cause) => error("resolve-capture-size", cause),
        });
        const sources = yield* listWindowSources(thumbnailSize, "capture-window");
        const source = findComposerAppshotSource(sources, stored.target);
        if (!source || source.thumbnail.isEmpty()) {
          return yield* error(
            "capture-window",
            new Error(
              "Unable to capture this window. Allow Screen Recording for Nodex and try again.",
            ),
          );
        }
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: (): CodexComposerAppshotContext => {
            const imageDataUrl = source.thumbnail.toDataURL();
            if (!imageDataUrl.startsWith("data:image/")) {
              throw new Error("The Appshot capture returned an invalid image");
            }
            const appIconDataUrl =
              source.appIcon && !source.appIcon.isEmpty()
                ? source.appIcon.toDataURL()
                : stored.iconSmallDataUrl;
            return {
              id: platform.createId(),
              appName: stored.target.name,
              bundleIdentifier: stored.target.bundleIdentifier,
              windowTitle: resolveComposerAppshotWindowTitle({
                axTree: stored.target.axTree,
                fallback: stored.target.windowTitle,
              }),
              axTree: stored.target.axTree,
              imageName: createComposerAppshotImageName(stored.target.name, now),
              imageDataUrl,
              appIconDataUrl,
            };
          },
          catch: (cause) => error("build-capture", cause),
        });
      });

      const logTrackingFailure = (message: string) =>
        Effect.catch((failure: ComposerAppshotRuntimeError) =>
          Effect.sync(() => logger.debug(message, { error: failure.cause })),
        );
      const trackingProgram = Effect.sleep(Math.max(0, timing.trackingStartDelayMs)).pipe(
        Effect.andThen(
          refresh.pipe(logTrackingFailure("Foreground Appshot target refresh failed")),
        ),
        Effect.andThen(
          Effect.forever(
            Effect.sleep(Math.max(1, timing.trackingIntervalMs)).pipe(
              Effect.andThen(
                refresh.pipe(logTrackingFailure("Foreground Appshot target tracking failed")),
              ),
            ),
          ),
        ),
        Effect.asVoid,
      );

      const setWindowFocused = (windowId: number, focused: boolean): Effect.Effect<void> =>
        focusLock
          .withPermits(1)(
            Effect.gen(function* () {
              const shouldTrack = yield* Ref.modify(state, (current) => {
                if (current.closed) return [false, current] as const;
                const focusedWindowIds = new Set(current.focusedWindowIds);
                if (focused) focusedWindowIds.add(windowId);
                else focusedWindowIds.delete(windowId);
                return [focusedWindowIds.size === 0, { ...current, focusedWindowIds }] as const;
              });
              if (!shouldTrack) return yield* FiberHandle.clear(trackingFiber);
              const isAvailable = yield* Effect.result(available);
              if (Result.isFailure(isAvailable) || !isAvailable.success) {
                if (Result.isFailure(isAvailable)) {
                  logger.debug("Could not determine Appshot tracking availability", {
                    error: isAvailable.failure.cause,
                  });
                }
                return yield* FiberHandle.clear(trackingFiber);
              }
              yield* FiberHandle.run(trackingFiber, trackingProgram, { onlyIfMissing: true });
            }),
          )
          .pipe(Effect.asVoid);

      const observeWindow = (window: BrowserWindow): void => {
        if (!acceptingCallbacks) return;
        const windowId = window.webContents.id;
        let released = false;
        const scheduleFocus = (focused: boolean) => {
          if (!acceptingCallbacks) return;
          void runCallback(setWindowFocused(windowId, focused));
        };
        const handleFocus = () => scheduleFocus(true);
        const handleBlur = () => scheduleFocus(false);
        const release = () => {
          if (released) return;
          released = true;
          window.off("focus", handleFocus);
          window.off("blur", handleBlur);
          window.off("closed", handleClosed);
          observerReleases.delete(release);
          scheduleFocus(false);
        };
        const handleClosed = () => release();
        window.on("focus", handleFocus);
        window.on("blur", handleBlur);
        window.on("closed", handleClosed);
        observerReleases.add(release);
        scheduleFocus(window.isFocused());
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          acceptingCallbacks = false;
          for (const release of [...observerReleases]) release();
          observerReleases.clear();
        }).pipe(
          Effect.andThen(
            Ref.set(state, {
              closed: true,
              focusedWindowIds: new Set<number>(),
              latestTarget: null,
              targets: new Map(),
            }),
          ),
        ),
      );

      return ComposerAppshotRuntime.of({ capture, observeWindow, readTarget });
    }),
  );

export const live: Layer.Layer<ComposerAppshotRuntime, never, MainConfig> = Layer.unwrap(
  MainConfig.use((config) =>
    Effect.succeed(
      liveWithPlatform(
        makeComposerAppshotLivePlatform({
          configuredHelperPath: config.composerAppshotHelperPath,
          isPackaged: config.isPackaged,
          platform: config.platform,
          projectRootPath: config.projectRootPath,
          resourcesPath: config.resourcesPath,
        }),
      ),
    ),
  ),
);
