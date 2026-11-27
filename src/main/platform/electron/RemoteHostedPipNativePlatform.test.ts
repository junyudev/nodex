import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { SkyNativeAddon, SkyRemoteHostedPipHostRegistration } from "../../sky-native";
import {
  layer as callbackRuntimeLayer,
  ScopedCallbackRuntime,
} from "../../app/ScopedCallbackRuntime";
import {
  fakeRemoteHostedPipNativePlatform,
  makeRemoteHostedPipNativePlatformFromAddon,
} from "./RemoteHostedPipNativePlatform";

function makeAddon() {
  const handlers = new Map<string, unknown>();
  const stopHost = vi.fn(() => {
    handlers.set("service-loss", null);
    return true;
  });
  const upsertBrowserContent = vi.fn(() => true);
  const setHandler = (name: string) => (handler: unknown) => {
    handlers.set(name, handler);
    return true;
  };
  let currentHostID = "window-1";
  const addon = {
    completeRemoteHostedPIPContentThread: vi.fn(() => true),
    computerUseServiceProcessMatchesExecutablePath: vi.fn(() => true),
    connectRemoteHostedPIPContentHost: vi.fn(() => true),
    getRemoteHostedPIPContentActiveTaskIDs: vi.fn(() => ["thread-1", "thread-1"]),
    getRemoteHostedPIPContentLayoutState: vi.fn(() => ({
      currentHostID,
      stackDisplayHeight: 250,
    })),
    hasRemoteHostedPIPContentAnyPresentation: vi.fn(() => true),
    invalidateBrowserUsePIPContent: vi.fn(() => true),
    invalidateRemoteHostedPIPContentTurn: vi.fn(() => true),
    isPrivacySettingsTerminationRequest: vi.fn(() => false),
    refreshRemoteHostedPIPContentVisibility: vi.fn(() => true),
    registerRemoteHostedPIPContentHost: vi.fn(
      (registration: SkyRemoteHostedPipHostRegistration) => {
        currentHostID = registration.id;
        return true;
      },
    ),
    setBrowserUsePIPContentClickHandler: vi.fn(setHandler("browser-click")),
    setRemoteHostedPIPContentActiveThreadID: vi.fn(() => true),
    setRemoteHostedPIPContentComputerUseCursorLocationHandler: vi.fn(),
    setRemoteHostedPIPContentLayoutStateChangedHandler: vi.fn(setHandler("layout")),
    setRemoteHostedPIPContentMaxDisplaySize: vi.fn(() => true),
    setRemoteHostedPIPContentMaxDisplaySizeChangedHandler: vi.fn(setHandler("max-size")),
    setRemoteHostedPIPContentPetWakeRequestHandler: vi.fn(setHandler("pet-wake")),
    setRemoteHostedPIPContentShouldShowTaskHandler: vi.fn(setHandler("should-show")),
    setRemoteHostedPIPContentSuppressedThreadIDs: vi.fn(() => true),
    setRemoteHostedPIPContentVisibilityRequestHandler: vi.fn(setHandler("visibility")),
    spawnComputerUseService: vi.fn(() => Promise.resolve(123)),
    startRemoteHostedPIPContentHost: vi.fn(
      (_tooltips: unknown, onServiceConnectionLost?: () => void) => {
        handlers.set("service-loss", onServiceConnectionLost ?? null);
        return true;
      },
    ),
    stopRemoteHostedPIPContentHost: stopHost,
    unregisterRemoteHostedPIPContentHost: vi.fn((id: string) => id === currentHostID),
    upsertBrowserUsePIPContent: upsertBrowserContent,
  } as unknown as SkyNativeAddon;
  return { addon, handlers, stopHost, upsertBrowserContent };
}

const makePlatform = Effect.fn("RemoteHostedPipNativePlatformTest.makePlatform")(function* (
  addon: SkyNativeAddon,
) {
  const scope = yield* Scope.Scope;
  const callbacksContext = yield* Layer.buildWithScope(callbackRuntimeLayer, scope);
  return yield* makeRemoteHostedPipNativePlatformFromAddon(
    addon,
    Context.get(callbacksContext, ScopedCallbackRuntime),
  );
});

const HOST_TOOLTIPS = {
  closeTooltip: "Return",
  hide: "Hide",
  hideForAllActiveTasks: "Hide all",
  hideForTask: "Hide task",
  placementTooltip: "Move",
} as const;

it.effect("adapts native callbacks into a scoped typed event stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { addon, handlers } = makeAddon();
      const platform = yield* makePlatform(addon);
      const next = yield* Effect.forkChild(Stream.runHead(platform.events));
      yield* Effect.yieldNow;

      const callback = handlers.get("visibility");
      assert.strictEqual(typeof callback, "function");
      (callback as (visible: boolean, ids: string[]) => void)(true, ["thread-1", "thread-1"]);

      const event = yield* Fiber.join(next);
      assert.deepEqual(Option.getOrThrow(event), {
        isVisible: true,
        threadIds: ["thread-1"],
        type: "visibility-requested",
      });
      assert.deepEqual(yield* platform.readActiveTaskIds, ["thread-1"]);
      assert.deepEqual(yield* platform.readLayoutState, {
        currentHostID: "window-1",
        stackDisplayHeight: 250,
      });
    }),
  ),
);

it.effect("round-trips Mini through the host identity used by the signed placement control", () =>
  Effect.gen(function* () {
    const { addon, handlers } = makeAddon();
    const platform = yield* makePlatform(addon);
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    yield* platform.registerHost({
      anchors: [{ alignment: "bottom-left", point: { x: 100, y: 100 } }],
      anchorRect: bounds,
      animated: false,
      contentBounds: bounds,
      id: "mini",
      isCodexHomeAvailable: false,
      nativeWindowHandle: null,
      presentationScope: "all",
      title: "Mini",
    });
    const wireLayout = addon.getRemoteHostedPIPContentLayoutState();
    assert.notPropertyVal(wireLayout, "currentHostID", "mini");
    assert.deepEqual(yield* platform.readLayoutState, {
      currentHostID: "mini",
      stackDisplayHeight: 250,
    });

    const next = yield* Effect.forkChild(Stream.runHead(platform.events));
    (handlers.get("layout") as (state: unknown) => void)(wireLayout);
    assert.deepEqual(Option.getOrThrow(yield* Fiber.join(next)), {
      type: "host-layout-changed",
      layoutState: { currentHostID: "mini", stackDisplayHeight: 250 },
    });
    assert.isTrue(yield* platform.unregisterHost("mini"));
  }),
);

it.effect("clears every callback lease and stops the native host on Scope release", () =>
  Effect.gen(function* () {
    const { addon, handlers, stopHost } = makeAddon();
    yield* Effect.scoped(makePlatform(addon));

    for (const handler of handlers.values()) assert.isNull(handler);
    assert.strictEqual(stopHost.mock.calls.length, 1);
  }),
);

it.effect("keeps lossless commands isolated from coalescible native state floods", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { addon, handlers } = makeAddon();
      const platform = yield* makePlatform(addon);
      yield* platform.startHost(HOST_TOOLTIPS);
      assert.deepEqual(
        (addon.startRemoteHostedPIPContentHost as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
        HOST_TOOLTIPS,
      );
      const commands = yield* Effect.forkChild(
        platform.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "browser-content-clicked" ||
              event.type === "visibility-requested" ||
              event.type === "service-connection-lost",
          ),
          Stream.take(3),
          Stream.runCollect,
        ),
      );
      yield* Effect.yieldNow;

      const layout = handlers.get("layout") as (state: unknown) => void;
      const maxSize = handlers.get("max-size") as (size: number) => void;
      for (let index = 0; index < 2_000; index += 1) {
        layout({ currentHostID: `host-${index}`, stackDisplayHeight: index });
        maxSize(200 + index);
      }
      (handlers.get("browser-click") as (presentationId: string) => void)("presentation-1");
      (handlers.get("visibility") as (visible: boolean, ids: string[]) => void)(false, [
        "thread-1",
        "thread-2",
      ]);
      (handlers.get("service-loss") as () => void)();

      assert.deepEqual(yield* Fiber.join(commands), [
        { presentationId: "presentation-1", type: "browser-content-clicked" },
        {
          isVisible: false,
          threadIds: ["thread-1", "thread-2"],
          type: "visibility-requested",
        },
        { type: "service-connection-lost" },
      ]);
    }),
  ),
);

it.effect("provides a deterministic fake Adapter for host-runtime tests", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRemoteHostedPipNativePlatform;
    yield* fake.service.startHost(HOST_TOOLTIPS);
    yield* fake.service.setActiveThreadId("thread-2");
    yield* fake.service.setSuppressedThreadIds(["thread-3"]);
    yield* fake.service.registerHost({
      anchorRect: null,
      anchors: null,
      animated: false,
      contentBounds: { height: 800, width: 1200, x: 0, y: 0 },
      id: "window-1",
      isCodexHomeAvailable: true,
      nativeWindowHandle: null,
      presentationScope: "thread",
      title: "Nodex",
    });

    assert.deepEqual(fake.snapshot(), {
      activeThreadId: "thread-2",
      hosts: ["window-1"],
      started: true,
      suppressedThreadIds: ["thread-3"],
    });
  }),
);

it.effect("rejects invalid native-bound presentation data before calling the addon", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { addon, upsertBrowserContent } = makeAddon();
      const platform = yield* makePlatform(addon);
      const exit = yield* Effect.exit(
        platform.upsertBrowserContent({
          appIconPath: null,
          imageDataUrl: "https://example.test/image.png",
          presentationId: "presentation-1",
          threadId: "thread-1",
        }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(upsertBrowserContent.mock.calls.length, 0);
    }),
  ),
);

it.effect("rejects invalid native callback payloads without poisoning later events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { addon, handlers } = makeAddon();
      const platform = yield* makePlatform(addon);
      const events = yield* Effect.forkChild(
        platform.events.pipe(Stream.take(2), Stream.runCollect),
      );
      yield* Effect.yieldNow;

      (handlers.get("browser-click") as (presentationId: string) => void)("\0invalid");
      (handlers.get("layout") as (state: unknown) => void)({
        currentHostID: "x".repeat(1_025),
        stackDisplayHeight: 10,
      });
      (handlers.get("max-size") as (size: number) => void)(Number.POSITIVE_INFINITY);

      (handlers.get("browser-click") as (presentationId: string) => void)("presentation-1");
      (handlers.get("max-size") as (size: number) => void)(320);

      const received = [...(yield* Fiber.join(events))].sort((left, right) =>
        left.type.localeCompare(right.type),
      );
      assert.deepEqual(received, [
        { presentationId: "presentation-1", type: "browser-content-clicked" },
        { size: 320, type: "max-display-size-changed" },
      ]);
    }),
  ),
);

it.effect("rejects unsafe host geometry before calling the addon", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { addon } = makeAddon();
      const platform = yield* makePlatform(addon);
      const exit = yield* Effect.exit(
        platform.registerHost({
          anchorRect: null,
          anchors: null,
          animated: false,
          contentBounds: { height: 800, width: 1_200, x: Number.POSITIVE_INFINITY, y: 0 },
          id: "window-1",
          isCodexHomeAvailable: false,
          nativeWindowHandle: null,
          presentationScope: "thread",
          title: "Nodex",
        }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(
        (addon.registerRemoteHostedPIPContentHost as ReturnType<typeof vi.fn>).mock.calls.length,
        0,
      );
    }),
  ),
);
