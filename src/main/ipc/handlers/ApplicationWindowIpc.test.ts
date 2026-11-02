import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { vi } from "vite-plus/test";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ApplicationWindowRuntime } from "../../window-runtime/ApplicationWindowRuntime";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { ApplicationWindowIpcError, live } from "./ApplicationWindowIpc";
import { ApplicationMenuRuntime } from "../../host-runtime/ApplicationMenuRuntime";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, ApplicationWindowIpcError>;

it.effect("owns trusted window ingress and validates new-window requests", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const openForRequest = vi.fn();
    const publishHistory = vi.fn(() => Effect.void);
    const snapshot = vi.fn(() => Effect.succeed({ menus: [] }));
    const invoke = vi.fn(() => Effect.succeed(true));
    const applicationWindows = ApplicationWindowRuntime.of({
      openForRequest,
    } as unknown as ApplicationWindowRuntime["Service"]);
    const focusedWindow = {
      isFocused: () => true,
      isFullScreen: () => true,
    } as unknown as BrowserWindow;
    const windows = WindowRuntime.of({
      get: () => focusedWindow,
      has: () => true,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({
        showEmojiPanel: () => true,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationWindowRuntime, applicationWindows),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer({
              rendererUrl: "http://localhost:5173",
              environment: { NODEX_DEV_ENABLED_FEATURES: "database-page-reorder-menu" },
            }),
            Layer.succeed(WindowRuntime, windows),
            Layer.succeed(
              ApplicationMenuRuntime,
              ApplicationMenuRuntime.of({
                snapshot,
                invoke,
                refresh: () => undefined,
                bindHistory: () => Effect.succeed(1),
                publishHistory,
              }),
            ),
          ),
        ),
      ),
      scope,
    );
    assert.deepEqual([...handlers.keys()].sort(), [
      "app:runtime-capabilities:get",
      "application-menu:invoke",
      "application-menu:snapshot",
      "electron-window:focus:get",
      "electron-window:fullscreen:get",
      "surface-history:bind",
      "surface-history:publish",
      "window:appearance:sync",
      "window:new",
      "window:show-emoji-panel",
    ]);

    const frame = { url: "http://localhost:5173" };
    const sender = {
      getType: () => "window",
      id: 17,
      mainFrame: frame,
    };
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    assert.deepEqual(yield* handlers.get("app:runtime-capabilities:get")!(event), {
      enabledDevelopmentFeatures: ["database-page-reorder-menu"],
    });
    assert.deepEqual(yield* handlers.get("application-menu:snapshot")!(event), { menus: [] });
    assert.isTrue(yield* handlers.get("application-menu:invoke")!(event, "menu-item-1"));
    assert.deepEqual(snapshot.mock.calls, [[17]]);
    assert.deepEqual(invoke.mock.calls, [[17, "menu-item-1"]]);
    assert.isTrue(yield* handlers.get("electron-window:fullscreen:get")!(event));
    for (const input of [null, 10, "", {}]) {
      assert.isTrue(
        Exit.isFailure(
          yield* handlers.get("application-menu:invoke")!(event, input).pipe(Effect.exit),
        ),
      );
    }
    assert.isTrue(
      Exit.isFailure(
        yield* handlers.get("window:appearance:sync")!(event, {
          theme: "dark",
          shellZoom: -1,
        }).pipe(Effect.exit),
      ),
    );
    yield* handlers.get("window:new")!(event, { activeProjectSessionId: "session-1" });
    assert.strictEqual(openForRequest.mock.calls.length, 1);
    assert.deepEqual(openForRequest.mock.calls[0], [17, { activeProjectSessionId: "session-1" }]);
    assert.strictEqual(yield* handlers.get("surface-history:bind")!(event), 1);
    const publication = { generation: 1, sequence: 1, snapshot: null };
    yield* handlers.get("surface-history:publish")!(event, publication);
    assert.deepEqual(publishHistory.mock.calls, [[17, publication]]);
    const invalid = yield* handlers.get("surface-history:publish")!(event, {
      ...publication,
      generation: -1,
    }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(invalid));
    const foreign = {
      ...event,
      senderFrame: { url: "https://untrusted.example" },
    } as unknown as IpcMainInvokeEvent;
    const rejected = yield* handlers.get("surface-history:publish")!(foreign, publication).pipe(
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(rejected));
    assert.isTrue(
      Exit.isFailure(
        yield* handlers.get("application-menu:invoke")!(foreign, "menu-item-1").pipe(Effect.exit),
      ),
    );
    assert.strictEqual(publishHistory.mock.calls.length, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
