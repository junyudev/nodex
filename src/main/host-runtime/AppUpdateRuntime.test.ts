import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { AppUpdateSettings, AppUpdateStatus } from "../../shared/types";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { layer as callbackRuntimeLayer } from "../app/ScopedCallbackRuntime";
import type {
  MacAppUpdaterCheckKind,
  MacAppUpdaterEvent,
  MacAppUpdaterPlatform,
} from "../mac-app-updater";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";
import { reduceAppUpdateStatus } from "./AppUpdatePolicy";
import { AppUpdateRuntime, layer } from "./AppUpdateRuntime";

class FakeUpdaterPlatform implements MacAppUpdaterPlatform {
  readonly buildDefaultChannel = "stable" as const;
  readonly checkKinds: MacAppUpdaterCheckKind[] = [];
  acquireCount = 0;
  failAcquire = false;
  installCount = 0;
  releaseCount = 0;
  private listener: ((event: MacAppUpdaterEvent) => void) | null = null;
  private channel: AppUpdateSettings["channel"] = "stable";

  getChannel(): AppUpdateSettings["channel"] {
    return this.channel;
  }

  acquire(channel: AppUpdateSettings["channel"], listener: (event: MacAppUpdaterEvent) => void) {
    this.acquireCount += 1;
    if (this.failAcquire) throw new Error("native updater unavailable");
    this.channel = channel;
    this.listener = listener;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseCount += 1;
        this.listener = null;
      },
      session: {
        check: (kind: MacAppUpdaterCheckKind) => this.checkKinds.push(kind),
        installDownloadedUpdate: () => {
          this.installCount += 1;
        },
        setChannel: (nextChannel: AppUpdateSettings["channel"]) => {
          this.channel = nextChannel;
        },
      },
    };
  }

  emit(event: MacAppUpdaterEvent): void {
    this.listener?.(event);
  }
}

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });

const buildHarness = (input: {
  readonly inApplicationsFolder?: boolean;
  readonly isPackaged?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly updater?: FakeUpdaterPlatform | null;
}) =>
  Effect.gen(function* () {
    const updater = "updater" in input ? (input.updater ?? null) : new FakeUpdaterPlatform();
    const broadcasts: AppUpdateStatus[] = [];
    let persistedSettings: AppUpdateSettings = {
      automaticChecksEnabled: true,
      channel: "stable",
    };
    const window = {
      id: 1,
      isDestroyed: () => false,
      webContents: {
        id: 2,
        isDestroyed: () => false,
        send: (_channel: string, status: AppUpdateStatus) => broadcasts.push(status),
      },
    };
    const app = ElectronApp.of({
      isInApplicationsFolder: Effect.succeed(input.inApplicationsFolder ?? true),
    } as ElectronApp["Service"]);
    const windows = ElectronWindowHost.of({
      all: Effect.succeed([window] as never),
    } as unknown as ElectronWindowHost["Service"]);
    const scope = yield* Scope.make();
    const settings = ApplicationSettings.of({
      snapshot: () =>
        Effect.succeed({ appUpdate: persistedSettings } as ApplicationSettingsSnapshot),
      update: (command) => {
        if (command.type === "update-app-update") {
          persistedSettings = { ...persistedSettings, ...command.input };
        }
        return Effect.succeed({ appUpdate: persistedSettings } as ApplicationSettingsSnapshot);
      },
    });
    const context = yield* Layer.buildWithScope(
      layer({
        createUpdaterPlatform: () => updater,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronApp, app),
            Layer.succeed(ElectronWindowHost, windows),
            Layer.succeed(ApplicationSettings, settings),
            mainConfigLayer({
              appVersion: "0.2.1",
              isPackaged: input.isPackaged ?? true,
              platform: input.platform ?? "darwin",
            }),
            callbackRuntimeLayer,
          ),
        ),
      ),
      scope,
    );
    const runtime = Context.get(context, AppUpdateRuntime);
    const supported =
      (input.isPackaged ?? true) &&
      (input.platform ?? "darwin") === "darwin" &&
      (input.inApplicationsFolder ?? true) &&
      updater !== null;
    yield* waitUntil("app updater initialization", () => !supported || updater?.acquireCount === 1);
    return { broadcasts, runtime, scope, updater };
  });

it.effect("keeps unsupported runtimes offline", () =>
  Effect.gen(function* () {
    const unpackaged = yield* buildHarness({ isPackaged: false, platform: "linux" });
    assert.deepInclude(yield* unpackaged.runtime.currentStatus, {
      currentVersion: "0.2.1",
      status: "unsupported",
      supported: false,
    });
    yield* Scope.close(unpackaged.scope, Exit.void);

    const disabled = yield* buildHarness({ updater: null });
    assert.deepInclude(yield* disabled.runtime.currentStatus, {
      message: "App updates are disabled in this build.",
      status: "unsupported",
    });
    yield* Scope.close(disabled.scope, Exit.void);

    const misplaced = yield* buildHarness({ inApplicationsFolder: false });
    assert.deepInclude(yield* misplaced.runtime.currentStatus, {
      message: "Move Nodex to Applications to enable app updates.",
      status: "unsupported",
    });
    assert.strictEqual(misplaced.updater?.acquireCount, 0);
    yield* Scope.close(misplaced.scope, Exit.void);
  }),
);

it.effect("starts exactly one automatic check after application readiness", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    yield* harness.runtime.markApplicationReady;
    yield* Effect.all(
      [harness.runtime.startAutomaticChecks, harness.runtime.startAutomaticChecks],
      { concurrency: "unbounded", discard: true },
    );

    assert.strictEqual(harness.updater?.acquireCount, 1);
    assert.deepEqual(harness.updater?.checkKinds, ["background"]);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("tracks native status events and broadcasts the current projection", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    yield* harness.runtime.check;
    harness.updater?.emit({ type: "up-to-date", version: "0.2.1" });
    yield* waitUntil("up-to-date status", () =>
      harness.broadcasts.some((status) => status.status === "upToDate"),
    );

    assert.deepInclude(yield* harness.runtime.currentStatus, {
      message: "You’re up to date.",
      status: "upToDate",
      supported: true,
    });
    assert.deepEqual(harness.updater?.checkKinds, ["user"]);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("serializes channel changes and rejects them during an update session", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    assert.deepEqual(yield* harness.runtime.updateSettings({ channel: "nightly" }), {
      automaticChecksEnabled: true,
      channel: "nightly",
    });
    assert.strictEqual(harness.updater?.getChannel(), "nightly");
    assert.deepInclude(yield* harness.runtime.currentStatus, {
      channel: "nightly",
      channelChangeAllowed: true,
      status: "idle",
    });

    yield* harness.runtime.check;
    const rejected = yield* Effect.result(harness.runtime.updateSettings({ channel: "stable" }));
    assert.strictEqual(rejected._tag, "Failure");
    assert.strictEqual(harness.updater?.getChannel(), "nightly");
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("starts a fresh automatic check after switching channels", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    yield* harness.runtime.markApplicationReady;
    harness.updater?.emit({ type: "up-to-date", version: "0.2.1" });
    yield* waitUntil("first automatic check completion", () =>
      harness.broadcasts.some((status) => status.status === "upToDate"),
    );

    yield* harness.runtime.updateSettings({ channel: "nightly" });
    assert.deepEqual(harness.updater?.checkKinds, ["background", "background"]);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("tracks download progress and installs only after readiness", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    yield* harness.runtime.check;
    harness.updater?.emit({
      buildVersion: "202",
      releaseDate: "2026-08-02T00:00:00.000Z",
      releaseName: "Nodex 0.2.2",
      releaseNotes: "Bug fixes",
      type: "update-found",
      version: "0.2.2",
    });
    harness.updater?.emit({ expectedBytes: 1_024, type: "download-started" });
    harness.updater?.emit({ expectedBytes: 1_024, receivedBytes: 513, type: "download-progress" });
    yield* waitUntil("download progress", () =>
      harness.broadcasts.some((status) => status.transferredBytes === 513),
    );
    assert.deepInclude(yield* harness.runtime.currentStatus, {
      availableVersion: "0.2.2",
      progressPercent: 50.1,
      status: "downloading",
    });
    assert.isFalse(yield* harness.runtime.install);

    harness.updater?.emit({ buildVersion: "202", type: "update-ready", version: "0.2.2" });
    yield* waitUntil("download ready", () =>
      harness.broadcasts.some((status) => status.status === "downloaded"),
    );
    assert.isTrue(yield* harness.runtime.install);
    assert.strictEqual(harness.updater?.installCount, 1);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("keeps a ready update stable against late progress", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    const initial = yield* harness.runtime.currentStatus;
    const ready = reduceAppUpdateStatus(
      initial,
      { buildVersion: "202", type: "update-ready", version: "0.2.2" },
      "2026-08-02T00:00:00.000Z",
    );
    assert.strictEqual(
      reduceAppUpdateStatus(
        ready,
        { expectedBytes: 100, receivedBytes: 50, type: "download-progress" },
        "2026-08-02T00:00:01.000Z",
      ),
      ready,
    );
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("surfaces updater errors and releases the native adapter with its Scope", () =>
  Effect.gen(function* () {
    const harness = yield* buildHarness({});
    yield* harness.runtime.check;
    harness.updater?.emit({
      code: "NSURLErrorDomain:-1009",
      message: "network failed",
      recoverable: true,
      type: "error",
    });
    yield* waitUntil("update error", () =>
      harness.broadcasts.some((status) => status.status === "error"),
    );
    assert.deepInclude(yield* harness.runtime.currentStatus, {
      channelChangeAllowed: true,
      message: "network failed",
      status: "error",
    });

    yield* Scope.close(harness.scope, Exit.void);
    assert.strictEqual(harness.updater?.releaseCount, 1);
  }),
);

it.effect("keeps a failed native acquisition out of the Scope release set", () =>
  Effect.gen(function* () {
    const updater = new FakeUpdaterPlatform();
    updater.failAcquire = true;
    const harness = yield* buildHarness({ updater });

    assert.deepInclude(yield* harness.runtime.currentStatus, {
      message: "native updater unavailable",
      status: "error",
      supported: true,
    });
    assert.strictEqual(updater.acquireCount, 1);
    assert.deepEqual(updater.checkKinds, []);

    yield* Scope.close(harness.scope, Exit.void);
    assert.strictEqual(updater.releaseCount, 0);
  }),
);
