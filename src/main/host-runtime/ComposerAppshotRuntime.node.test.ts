import { EventEmitter } from "node:events";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { BrowserWindow, DesktopCapturerSource } from "electron";
import type { ComposerAppshotPlatform } from "../composer-appshot-platform";
import { ComposerAppshotRuntime, liveWithPlatform } from "./ComposerAppshotRuntime";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: async () => [] },
  screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
}));

const externalTarget = {
  name: "Safari",
  bundleIdentifier: "com.apple.Safari",
  processIdentifier: 99,
  windowId: 42,
  windowTitle: "Nodex",
  bounds: { x: 10, y: 20, width: 800, height: 600 },
  axTree: "AXWindow title=Nodex\n  AXButton title=Continue",
} as const;

const fakeImage = (dataUrl: string, empty = false) => ({
  isEmpty: () => empty,
  resize: () => fakeImage(dataUrl, empty),
  toDataURL: () => dataUrl,
});

const fakeSource = (): DesktopCapturerSource =>
  ({
    id: "window:42:0",
    name: "Nodex",
    thumbnail: fakeImage("data:image/png;base64,d2luZG93"),
    appIcon: fakeImage("data:image/png;base64,aWNvbg=="),
    display_id: "",
  }) as unknown as DesktopCapturerSource;

const makePlatform = (
  overrides: Partial<ComposerAppshotPlatform> = {},
): ComposerAppshotPlatform => {
  let id = 0;
  return {
    platform: "darwin",
    processIdentifier: 7,
    helperAvailable: () => true,
    readFrontmostWindow: async () => externalTarget,
    listWindowSources: async () => [fakeSource()],
    displayScaleFactor: () => 2,
    createId: () => `id-${++id}`,
    ...overrides,
  };
};

class FakeWindow extends EventEmitter {
  readonly webContents: { readonly id: number };
  #focused: boolean;

  constructor(id: number, focused = false) {
    super();
    this.webContents = { id };
    this.#focused = focused;
  }

  isFocused(): boolean {
    return this.#focused;
  }

  focusWindow(): void {
    this.#focused = true;
    this.emit("focus");
  }

  blurWindow(): void {
    this.#focused = false;
    this.emit("blur");
  }
}

it.effect("interrupts an in-flight helper read when the Main Scope closes", () =>
  Effect.gen(function* () {
    let helperSignal: AbortSignal | null = null;
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      liveWithPlatform(
        makePlatform({
          readFrontmostWindow: (signal) => {
            helperSignal = signal;
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          },
        }),
        { trackingStartDelayMs: 1, trackingIntervalMs: 750 },
      ),
      scope,
    );
    const appshots = Context.get(context, ComposerAppshotRuntime);
    appshots.observeWindow(new FakeWindow(42) as unknown as BrowserWindow);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(1);
    yield* Effect.yieldNow;
    assert.isNotNull(helperSignal);

    yield* Scope.close(scope, Exit.void);
    assert.isTrue((helperSignal as unknown as AbortSignal).aborted);
  }),
);

it.effect("fails closed when the native capability is unavailable", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      liveWithPlatform(makePlatform({ platform: "linux" })),
      scope,
    );
    const appshots = Context.get(context, ComposerAppshotRuntime);
    assert.deepEqual(yield* appshots.readTarget, { available: false, target: null });
    const capture = yield* Effect.result(appshots.capture("id-1"));
    assert.isTrue(Result.isFailure(capture));
    if (Result.isFailure(capture)) assert.strictEqual(capture.failure.operation, "capture");
    yield* Scope.close(scope, Exit.void);
  }),
);
