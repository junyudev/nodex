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
    const applicationWindows = ApplicationWindowRuntime.of({
      openForRequest,
    } as unknown as ApplicationWindowRuntime["Service"]);
    const focusedWindow = { isFocused: () => true } as unknown as BrowserWindow;
    const windows = WindowRuntime.of({
      get: () => focusedWindow,
      has: () => true,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({
        showEmojiPanel: () => true,
        runtimeCapabilities: {
          enabledDevelopmentFeatures: ["database-page-reorder-menu"],
        },
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ApplicationWindowRuntime, applicationWindows),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );
    assert.deepEqual([...handlers.keys()].sort(), [
      "app:runtime-capabilities:get",
      "electron-window:focus:get",
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
    yield* handlers.get("window:new")!(event, { activeProjectSessionId: "session-1" });
    assert.strictEqual(openForRequest.mock.calls.length, 1);
    assert.deepEqual(openForRequest.mock.calls[0], [17, { activeProjectSessionId: "session-1" }]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
