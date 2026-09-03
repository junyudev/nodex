import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RemoteHostedPipPoint } from "../../../shared/remote-hosted-pip";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { MAIN_RELIABLE_COMMAND_CAPACITY } from "../../runtime-limits";
import {
  inspectSkyNativeCapabilities,
  loadSkyNativeAddon,
  type SkyNativeAddon,
  type SkyNativeCapabilityGroup,
  type SkyRemoteHostedPipHostRegistration,
} from "../../sky-native";

export type RemoteHostedPipNativeLayoutState =
  | (Readonly<Record<string, unknown>> & {
      readonly currentHostID: string | null;
      readonly stackDisplayHeight: number;
    })
  | null;

export type RemoteHostedPipNativeEvent =
  | { readonly type: "browser-content-clicked"; readonly presentationId: string }
  | { readonly type: "computer-use-cursor-changed"; readonly point: RemoteHostedPipPoint | null }
  | { readonly type: "host-layout-changed"; readonly layoutState: RemoteHostedPipNativeLayoutState }
  | { readonly type: "max-display-size-changed"; readonly size: number }
  | { readonly type: "pet-wake-requested" }
  | { readonly type: "service-connection-lost" }
  | {
      readonly type: "visibility-requested";
      readonly isVisible: boolean;
      readonly threadIds: readonly string[];
    };

type RemoteHostedPipNativeStateEvent = Extract<
  RemoteHostedPipNativeEvent,
  {
    readonly type:
      | "computer-use-cursor-changed"
      | "host-layout-changed"
      | "max-display-size-changed";
  }
>;

type RemoteHostedPipNativeCommandEvent = Exclude<
  RemoteHostedPipNativeEvent,
  RemoteHostedPipNativeStateEvent
>;

export type RemoteHostedPipNativeAvailability =
  | {
      readonly reason: "addon-invalid" | "addon-missing" | "platform-unsupported";
      readonly status: "unavailable";
    }
  | {
      readonly capabilities: Readonly<Record<SkyNativeCapabilityGroup, true>>;
      readonly status: "available";
    };

export class RemoteHostedPipNativePlatformError extends Data.TaggedError(
  "RemoteHostedPipNativePlatformError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface RemoteHostedPipNativePlatformService {
  readonly availability: RemoteHostedPipNativeAvailability;
  readonly completeThread: (
    threadId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly connectHost: (pid: number) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly events: Stream.Stream<RemoteHostedPipNativeEvent>;
  readonly hasAnyPresentation: Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly invalidateBrowserContent: (
    presentationId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly invalidateTurn: (
    threadId: string,
    turnId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly isPrivacySettingsTerminationRequest: Effect.Effect<
    boolean,
    RemoteHostedPipNativePlatformError
  >;
  readonly readActiveTaskIds: Effect.Effect<readonly string[], RemoteHostedPipNativePlatformError>;
  readonly readLayoutState: Effect.Effect<
    RemoteHostedPipNativeLayoutState,
    RemoteHostedPipNativePlatformError
  >;
  readonly refreshVisibility: (
    threadIds?: readonly string[],
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly registerHost: (
    input: SkyRemoteHostedPipHostRegistration,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly setActiveThreadId: (
    threadId: string | null,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly setMaxDisplaySize: (
    size: number,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly setShouldShowTask: (predicate: (threadId: string) => boolean) => void;
  readonly setSuppressedThreadIds: (
    threadIds: readonly string[],
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly startHost: (tooltips: {
    readonly closeTooltip: string;
    readonly hide: string;
    readonly hideForAllActiveTasks: string;
    readonly hideForTask: string;
    readonly placementTooltip: string;
  }) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly stopHost: Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly unregisterHost: (
    hostId: string,
  ) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
  readonly upsertBrowserContent: (input: {
    readonly appIconPath: string | null;
    readonly imageDataUrl: string;
    readonly presentationId: string;
    readonly threadId: string;
  }) => Effect.Effect<boolean, RemoteHostedPipNativePlatformError>;
}

export class RemoteHostedPipNativePlatform extends Context.Service<
  RemoteHostedPipNativePlatform,
  RemoteHostedPipNativePlatformService
>()("nodex/main/platform/electron/RemoteHostedPipNativePlatform") {}

const nativeError = (operation: string, cause: unknown): RemoteHostedPipNativePlatformError =>
  new RemoteHostedPipNativePlatformError({ operation, cause });

const unavailableOperation = (operation: string): RemoteHostedPipNativePlatformError =>
  nativeError(operation, new Error("Remote Hosted PiP native platform is unavailable"));

const MAX_NATIVE_IDENTIFIER_LENGTH = 1_024;
const MAX_NATIVE_TASK_IDS = 1_024;
const MAX_NATIVE_COORDINATE = 1_000_000;
const MAX_NATIVE_DIMENSION = 100_000;
const MAX_NATIVE_SPRING_VALUE = 10_000;
const MAX_NATIVE_WINDOW_HANDLE_BYTES = 64;
const NATIVE_ANCHOR_ALIGNMENTS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);

function nonEmpty(value: string, name: string): string {
  if (
    value.trim().length > 0 &&
    value.length <= MAX_NATIVE_IDENTIFIER_LENGTH &&
    !value.includes("\0")
  ) {
    return value;
  }
  throw new Error(`${name} must be a bounded non-empty string`);
}

function boundedFinite(value: number, name: string, minimum: number, maximum: number): number {
  if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;
  throw new Error(`${name} is outside its native-safe range`);
}

function coordinate(value: number, name: string): number {
  return boundedFinite(value, name, -MAX_NATIVE_COORDINATE, MAX_NATIVE_COORDINATE);
}

function dimension(value: number, name: string, allowZero = true): number {
  return boundedFinite(value, name, allowZero ? 0 : Number.EPSILON, MAX_NATIVE_DIMENSION);
}

function parsePoint(value: unknown, name: string): RemoteHostedPipPoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a point`);
  }
  return {
    x: coordinate(Reflect.get(value, "x"), `${name}.x`),
    y: coordinate(Reflect.get(value, "y"), `${name}.y`),
  };
}

function validateHostRegistration(input: SkyRemoteHostedPipHostRegistration): void {
  nonEmpty(input.id, "hostId");
  nonEmpty(input.title, "title");
  if (typeof input.animated !== "boolean") throw new Error("animated must be a boolean");
  if (typeof input.isCodexHomeAvailable !== "boolean") {
    throw new Error("isCodexHomeAvailable must be a boolean");
  }
  if (input.presentationScope !== "all" && input.presentationScope !== "thread") {
    throw new Error("presentationScope is invalid");
  }
  coordinate(input.contentBounds.x, "contentBounds.x");
  coordinate(input.contentBounds.y, "contentBounds.y");
  dimension(input.contentBounds.width, "contentBounds.width", false);
  dimension(input.contentBounds.height, "contentBounds.height", false);
  if (
    input.nativeWindowHandle !== null &&
    (!Buffer.isBuffer(input.nativeWindowHandle) ||
      input.nativeWindowHandle.byteLength === 0 ||
      input.nativeWindowHandle.byteLength > MAX_NATIVE_WINDOW_HANDLE_BYTES)
  ) {
    throw new Error("nativeWindowHandle must be a bounded Buffer or null");
  }
  if (input.anchors !== null) {
    if (input.anchors.length > 4) throw new Error("anchors exceeds the native-safe limit");
    const alignments = new Set<string>();
    for (const [index, anchor] of input.anchors.entries()) {
      if (!NATIVE_ANCHOR_ALIGNMENTS.has(anchor.alignment)) {
        throw new Error("anchor alignment is invalid");
      }
      if (alignments.has(anchor.alignment)) throw new Error("anchor alignments must be unique");
      alignments.add(anchor.alignment);
      parsePoint(anchor.point, `anchors[${index}].point`);
    }
  }
  if (input.anchorRect !== null) {
    coordinate(input.anchorRect.x, "anchorRect.x");
    coordinate(input.anchorRect.y, "anchorRect.y");
    dimension(input.anchorRect.width, "anchorRect.width", false);
    dimension(input.anchorRect.height, "anchorRect.height", false);
  }
  if (input.interactionPassthroughRect) {
    coordinate(input.interactionPassthroughRect.x, "interactionPassthroughRect.x");
    coordinate(input.interactionPassthroughRect.y, "interactionPassthroughRect.y");
    dimension(input.interactionPassthroughRect.width, "interactionPassthroughRect.width", false);
    dimension(input.interactionPassthroughRect.height, "interactionPassthroughRect.height", false);
  }
  if (input.animationSpring) {
    boundedFinite(input.animationSpring.mass, "animationSpring.mass", 0, MAX_NATIVE_SPRING_VALUE);
    boundedFinite(
      input.animationSpring.stiffness,
      "animationSpring.stiffness",
      0,
      MAX_NATIVE_SPRING_VALUE,
    );
    boundedFinite(
      input.animationSpring.damping,
      "animationSpring.damping",
      0,
      MAX_NATIVE_SPRING_VALUE,
    );
    boundedFinite(
      input.animationSpring.initialVelocity,
      "animationSpring.initialVelocity",
      -MAX_NATIVE_SPRING_VALUE,
      MAX_NATIVE_SPRING_VALUE,
    );
  }
}

function parseLayoutState(value: unknown): RemoteHostedPipNativeLayoutState {
  if (value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const currentHostID = Reflect.get(value, "currentHostID");
    const stackDisplayHeight = Reflect.get(value, "stackDisplayHeight");
    if (
      (currentHostID === null || typeof currentHostID === "string") &&
      typeof stackDisplayHeight === "number" &&
      Number.isFinite(stackDisplayHeight) &&
      stackDisplayHeight >= 0 &&
      stackDisplayHeight <= MAX_NATIVE_DIMENSION
    ) {
      if (currentHostID !== null) nonEmpty(currentHostID, "currentHostID");
      return value as Exclude<RemoteHostedPipNativeLayoutState, null>;
    }
  }
  throw new Error("Native layout state is invalid");
}

function parseTaskIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_NATIVE_TASK_IDS ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Native active task IDs must be strings");
  }
  return [...new Set(value.map((entry) => nonEmpty(entry, "threadId")))];
}

function attempt<A>(
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, RemoteHostedPipNativePlatformError> {
  return Effect.try({ try: evaluate, catch: (cause) => nativeError(operation, cause) });
}

function makeUnavailable(
  reason: Extract<RemoteHostedPipNativeAvailability, { status: "unavailable" }>["reason"],
): RemoteHostedPipNativePlatformService {
  const fail = <A>(operation: string): Effect.Effect<A, RemoteHostedPipNativePlatformError> =>
    Effect.fail(unavailableOperation(operation));
  return {
    availability: { reason, status: "unavailable" },
    completeThread: () => fail("complete-thread"),
    connectHost: () => fail("connect-host"),
    events: Stream.empty,
    hasAnyPresentation: fail("has-any-presentation"),
    invalidateBrowserContent: () => fail("invalidate-browser-content"),
    invalidateTurn: () => fail("invalidate-turn"),
    isPrivacySettingsTerminationRequest: fail("privacy-settings-termination"),
    readActiveTaskIds: fail("read-active-task-ids"),
    readLayoutState: fail("read-layout-state"),
    refreshVisibility: () => fail("refresh-visibility"),
    registerHost: () => fail("register-host"),
    setActiveThreadId: () => fail("set-active-thread"),
    setMaxDisplaySize: () => fail("set-max-display-size"),
    setShouldShowTask: () => undefined,
    setSuppressedThreadIds: () => fail("set-suppressed-threads"),
    startHost: () => fail("start-host"),
    stopHost: fail("stop-host"),
    unregisterHost: () => fail("unregister-host"),
    upsertBrowserContent: () => fail("upsert-browser-content"),
  };
}

function makeAvailable(
  addon: SkyNativeAddon,
  callbacks: ScopedCallbackRuntime["Service"],
): Effect.Effect<RemoteHostedPipNativePlatformService, never, Scope.Scope> {
  const capabilities = inspectSkyNativeCapabilities(addon);
  if (!Object.values(capabilities).every(Boolean)) {
    return Effect.succeed(makeUnavailable("addon-invalid"));
  }
  return Effect.gen(function* () {
    const commands = yield* Queue.bounded<RemoteHostedPipNativeCommandEvent>(
      MAIN_RELIABLE_COMMAND_CAPACITY,
    );
    const cursorState =
      yield* Queue.sliding<
        Extract<RemoteHostedPipNativeStateEvent, { readonly type: "computer-use-cursor-changed" }>
      >(1);
    const layoutStateEvents =
      yield* Queue.sliding<
        Extract<RemoteHostedPipNativeStateEvent, { readonly type: "host-layout-changed" }>
      >(1);
    const maxDisplaySizeState =
      yield* Queue.sliding<
        Extract<RemoteHostedPipNativeStateEvent, { readonly type: "max-display-size-changed" }>
      >(1);
    let shouldShowTask = (_threadId: string): boolean => true;
    const publishCommand = (event: RemoteHostedPipNativeCommandEvent): void => {
      callbacks.fork(Queue.offer(commands, event).pipe(Effect.asVoid));
    };

    addon.setBrowserUsePIPContentClickHandler((presentationId) => {
      try {
        publishCommand({
          presentationId: nonEmpty(presentationId, "presentationId"),
          type: "browser-content-clicked",
        });
      } catch {
        // Invalid native callback payloads are rejected at the Adapter seam.
      }
    });
    addon.setRemoteHostedPIPContentComputerUseCursorLocationHandler((point) => {
      try {
        Queue.offerUnsafe(cursorState, {
          point: point === null ? null : parsePoint(point, "computerUseCursor"),
          type: "computer-use-cursor-changed",
        });
      } catch {
        // Invalid native callback payloads are rejected at the Adapter seam.
      }
    });
    addon.setRemoteHostedPIPContentLayoutStateChangedHandler((nativeLayoutState) => {
      try {
        Queue.offerUnsafe(layoutStateEvents, {
          layoutState: parseLayoutState(nativeLayoutState),
          type: "host-layout-changed",
        });
      } catch {
        // Invalid native callback payloads are rejected at the Adapter boundary.
      }
    });
    addon.setRemoteHostedPIPContentMaxDisplaySizeChangedHandler((size) => {
      try {
        dimension(size, "size", false);
        Queue.offerUnsafe(maxDisplaySizeState, { size, type: "max-display-size-changed" });
      } catch {
        // Invalid native callback payloads are rejected at the Adapter boundary.
      }
    });
    addon.setRemoteHostedPIPContentPetWakeRequestHandler(() =>
      publishCommand({ type: "pet-wake-requested" }),
    );
    addon.setRemoteHostedPIPContentShouldShowTaskHandler((threadId) => {
      try {
        return shouldShowTask(nonEmpty(threadId, "threadId"));
      } catch {
        return false;
      }
    });
    addon.setRemoteHostedPIPContentVisibilityRequestHandler((isVisible, threadIds) => {
      try {
        if (typeof isVisible !== "boolean") return;
        publishCommand({
          isVisible,
          threadIds: parseTaskIds(threadIds),
          type: "visibility-requested",
        });
      } catch {
        // Invalid native callback payloads are rejected at the Adapter boundary.
      }
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        addon.setBrowserUsePIPContentClickHandler(null);
        addon.setRemoteHostedPIPContentComputerUseCursorLocationHandler(null);
        addon.setRemoteHostedPIPContentLayoutStateChangedHandler(null);
        addon.setRemoteHostedPIPContentMaxDisplaySizeChangedHandler(null);
        addon.setRemoteHostedPIPContentPetWakeRequestHandler(null);
        addon.setRemoteHostedPIPContentShouldShowTaskHandler(null);
        addon.setRemoteHostedPIPContentVisibilityRequestHandler(null);
        addon.stopRemoteHostedPIPContentHost();
      }).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.all(
            [
              Queue.shutdown(commands),
              Queue.shutdown(cursorState),
              Queue.shutdown(layoutStateEvents),
              Queue.shutdown(maxDisplaySizeState),
            ],
            { discard: true },
          ),
        ),
      ),
    );

    const eventStreams: ReadonlyArray<Stream.Stream<RemoteHostedPipNativeEvent>> = [
      Stream.fromQueue(commands),
      Stream.fromQueue(cursorState),
      Stream.fromQueue(layoutStateEvents),
      Stream.fromQueue(maxDisplaySizeState),
    ];
    const events = Stream.mergeAll({
      concurrency: "unbounded",
    })(eventStreams);

    return {
      availability: {
        capabilities: capabilities as Readonly<Record<SkyNativeCapabilityGroup, true>>,
        status: "available",
      },
      completeThread: (threadId) =>
        attempt("complete-thread", () =>
          addon.completeRemoteHostedPIPContentThread(nonEmpty(threadId, "threadId")),
        ),
      connectHost: (pid) =>
        attempt("connect-host", () => {
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be positive");
          return addon.connectRemoteHostedPIPContentHost(pid);
        }),
      events,
      hasAnyPresentation: attempt("has-any-presentation", () =>
        addon.hasRemoteHostedPIPContentAnyPresentation(),
      ),
      invalidateBrowserContent: (presentationId) =>
        attempt("invalidate-browser-content", () =>
          addon.invalidateBrowserUsePIPContent(nonEmpty(presentationId, "presentationId")),
        ),
      invalidateTurn: (threadId, turnId) =>
        attempt("invalidate-turn", () =>
          addon.invalidateRemoteHostedPIPContentTurn(
            nonEmpty(threadId, "threadId"),
            nonEmpty(turnId, "turnId"),
          ),
        ),
      isPrivacySettingsTerminationRequest: attempt("privacy-settings-termination", () =>
        addon.isPrivacySettingsTerminationRequest(),
      ),
      readActiveTaskIds: attempt("read-active-task-ids", () =>
        parseTaskIds(addon.getRemoteHostedPIPContentActiveTaskIDs()),
      ),
      readLayoutState: attempt("read-layout-state", () =>
        parseLayoutState(addon.getRemoteHostedPIPContentLayoutState()),
      ),
      refreshVisibility: (threadIds) =>
        attempt("refresh-visibility", () =>
          addon.refreshRemoteHostedPIPContentVisibility(
            threadIds ? [...parseTaskIds(threadIds)] : undefined,
          ),
        ),
      registerHost: (input) =>
        attempt("register-host", () => {
          validateHostRegistration(input);
          return addon.registerRemoteHostedPIPContentHost(input);
        }),
      setActiveThreadId: (threadId) =>
        attempt("set-active-thread", () =>
          addon.setRemoteHostedPIPContentActiveThreadID(
            threadId === null ? null : nonEmpty(threadId, "threadId"),
          ),
        ),
      setMaxDisplaySize: (size) =>
        attempt("set-max-display-size", () =>
          addon.setRemoteHostedPIPContentMaxDisplaySize(dimension(size, "size", false)),
        ),
      setShouldShowTask: (predicate) => void (shouldShowTask = predicate),
      setSuppressedThreadIds: (threadIds) =>
        attempt("set-suppressed-threads", () =>
          addon.setRemoteHostedPIPContentSuppressedThreadIDs(parseTaskIds(threadIds) as string[]),
        ),
      startHost: (tooltips) =>
        attempt("start-host", () =>
          addon.startRemoteHostedPIPContentHost(
            {
              closeTooltip: nonEmpty(tooltips.closeTooltip, "tooltips.closeTooltip"),
              hide: nonEmpty(tooltips.hide, "tooltips.hide"),
              hideForAllActiveTasks: nonEmpty(
                tooltips.hideForAllActiveTasks,
                "tooltips.hideForAllActiveTasks",
              ),
              hideForTask: nonEmpty(tooltips.hideForTask, "tooltips.hideForTask"),
              placementTooltip: nonEmpty(tooltips.placementTooltip, "tooltips.placementTooltip"),
            },
            () => publishCommand({ type: "service-connection-lost" }),
          ),
        ),
      stopHost: attempt("stop-host", () => addon.stopRemoteHostedPIPContentHost()),
      unregisterHost: (hostId) =>
        attempt("unregister-host", () =>
          addon.unregisterRemoteHostedPIPContentHost(nonEmpty(hostId, "hostId")),
        ),
      upsertBrowserContent: (input) =>
        attempt("upsert-browser-content", () => {
          if (!input.imageDataUrl.startsWith("data:image/")) {
            throw new Error("imageDataUrl must be an image data URL");
          }
          return addon.upsertBrowserUsePIPContent(
            nonEmpty(input.presentationId, "presentationId"),
            nonEmpty(input.threadId, "threadId"),
            input.imageDataUrl,
            input.appIconPath,
          );
        }),
    } satisfies RemoteHostedPipNativePlatformService;
  });
}

export function makeRemoteHostedPipNativePlatform(options: {
  readonly expectedExports: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly verifiedAddonPath: string | null;
}): Effect.Effect<
  RemoteHostedPipNativePlatformService,
  never,
  Scope.Scope | ScopedCallbackRuntime
> {
  if (options.platform !== "darwin") return Effect.succeed(makeUnavailable("platform-unsupported"));
  if (!options.verifiedAddonPath) return Effect.succeed(makeUnavailable("addon-missing"));
  const addon = loadSkyNativeAddon(options.verifiedAddonPath, options.expectedExports);
  if (!addon) return Effect.succeed(makeUnavailable("addon-invalid"));
  return Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    return yield* makeAvailable(addon, callbacks);
  });
}

export const live = (options: {
  readonly expectedExports: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly verifiedAddonPath: string | null;
}): Layer.Layer<RemoteHostedPipNativePlatform, never, ScopedCallbackRuntime> =>
  Layer.effect(RemoteHostedPipNativePlatform, makeRemoteHostedPipNativePlatform(options));

export function makeRemoteHostedPipNativePlatformFromAddon(
  addon: SkyNativeAddon,
  callbacks: ScopedCallbackRuntime["Service"],
): Effect.Effect<RemoteHostedPipNativePlatformService, never, Scope.Scope> {
  return makeAvailable(addon, callbacks);
}

export interface FakeRemoteHostedPipNativePlatform {
  readonly emit: (event: RemoteHostedPipNativeEvent) => void;
  readonly service: RemoteHostedPipNativePlatformService;
  readonly snapshot: () => {
    readonly activeThreadId: string | null;
    readonly hosts: readonly string[];
    readonly started: boolean;
    readonly suppressedThreadIds: readonly string[];
  };
}

export const fakeRemoteHostedPipNativePlatform: Effect.Effect<FakeRemoteHostedPipNativePlatform> =
  Effect.gen(function* () {
    const eventBus = yield* PubSub.sliding<RemoteHostedPipNativeEvent>(256);
    const hosts = new Set<string>();
    let activeThreadId: string | null = null;
    let started = false;
    let suppressedThreadIds: readonly string[] = [];
    const succeed = <A>(evaluate: () => A): Effect.Effect<A, RemoteHostedPipNativePlatformError> =>
      attempt("fake", evaluate);
    const service: RemoteHostedPipNativePlatformService = {
      availability: {
        capabilities: {
          computerUseService: true,
          hostLayout: true,
          interaction: true,
          presentation: true,
        },
        status: "available",
      },
      completeThread: () => Effect.succeed(true),
      connectHost: (pid) => succeed(() => Number.isSafeInteger(pid) && pid > 0),
      events: Stream.fromPubSub(eventBus),
      hasAnyPresentation: Effect.succeed(false),
      invalidateBrowserContent: () => Effect.succeed(true),
      invalidateTurn: () => Effect.succeed(true),
      isPrivacySettingsTerminationRequest: Effect.succeed(false),
      readActiveTaskIds: Effect.succeed([]),
      readLayoutState: Effect.succeed(null),
      refreshVisibility: () => Effect.succeed(true),
      registerHost: (input) => succeed(() => (hosts.add(nonEmpty(input.id, "hostId")), true)),
      setActiveThreadId: (threadId) => succeed(() => ((activeThreadId = threadId), true)),
      setMaxDisplaySize: (size) => succeed(() => (dimension(size, "size", false), true)),
      setShouldShowTask: () => undefined,
      setSuppressedThreadIds: (threadIds) =>
        succeed(() => ((suppressedThreadIds = parseTaskIds(threadIds)), true)),
      startHost: () => succeed(() => ((started = true), true)),
      stopHost: succeed(() => ((started = false), true)),
      unregisterHost: (hostId) => succeed(() => hosts.delete(nonEmpty(hostId, "hostId"))),
      upsertBrowserContent: () => Effect.succeed(true),
    };
    return {
      emit: (event) => void PubSub.publishUnsafe(eventBus, event),
      service,
      snapshot: () => ({
        activeThreadId,
        hosts: [...hosts],
        started,
        suppressedThreadIds,
      }),
    };
  });

export const fakeLayer = (
  fake: FakeRemoteHostedPipNativePlatform,
): Layer.Layer<RemoteHostedPipNativePlatform> =>
  Layer.succeed(RemoteHostedPipNativePlatform, fake.service);
