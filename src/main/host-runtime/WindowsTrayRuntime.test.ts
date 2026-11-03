import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { testLayer } from "../app/MainConfig";
import { layer as callbacksLayer } from "../app/ScopedCallbackRuntime";
import * as NodeServices from "../platform/node/NodeServices";
import {
  WindowsTrayRuntime,
  live,
  type WindowsTrayAction,
  type WindowsTrayNativePort,
} from "./WindowsTrayRuntime";

it.effect("owns the tray, theme listener and pre-ready actions through the same Scope", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    let dark = false;
    let refresh = () => {};
    let emit: (action: WindowsTrayAction) => void = () => {};
    const native: WindowsTrayNativePort = {
      create: (icon, guid) => {
        events.push(`create:${icon}`);
        assert.isUndefined(guid);
        return {
          destroy: () => events.push("destroy"),
          setIcon: (path) => events.push(`icon:${path}`),
          subscribe: (action) => {
            emit = action;
            return () => {
              events.push("unsubscribe");
            };
          },
          showMenu: () => {
            events.push("menu");
          },
        };
      },
      isDark: () => dark,
      subscribeTheme: (update) => {
        refresh = update;
        return () => {
          events.push("theme-off");
        };
      },
      startupEnabled: () => {
        throw new Error("Development must not read login registration");
      },
      openStartupSettings: () => Promise.resolve(),
    };
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live(native).pipe(
        Layer.provide(
          Layer.mergeAll(testLayer({ platform: "win32" }), NodeServices.layer, callbacksLayer),
        ),
      ),
      scope,
    );
    const tray = Context.get(context, WindowsTrayRuntime);
    assert.isFalse(tray.canHideLastWindow());
    emit({ kind: "open" });
    assert.deepEqual(yield* tray.actions.pipe(Stream.take(1), Stream.runCollect), [
      { kind: "open" },
    ]);
    yield* tray.markApplicationReady;
    assert.isTrue(tray.canHideLastWindow());
    yield* tray.markApplicationFailed;
    assert.isFalse(tray.canHideLastWindow());
    yield* tray.markApplicationReady;
    assert.deepEqual(yield* tray.startupStatus, { supported: false, enabled: false });
    dark = true;
    refresh();
    yield* tray.showMenu([]);
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(tray.canHideLastWindow());
    assert.deepEqual(
      events.map((event) => event.replaceAll("\\", "/")),
      [
        "create:/tmp/nodex-project/resources/windows/tray-light.ico",
        "icon:/tmp/nodex-project/resources/windows/tray-dark.ico",
        "menu",
        "theme-off",
        "unsubscribe",
        "destroy",
      ],
    );
  }),
);

it.effect("macOS never acquires a Windows tray or reads startup settings", () =>
  Effect.gen(function* () {
    const forbidden = () => {
      throw new Error("Windows integration used on macOS");
    };
    const native: WindowsTrayNativePort = {
      create: forbidden,
      isDark: forbidden,
      subscribeTheme: forbidden,
      startupEnabled: forbidden,
      openStartupSettings: forbidden,
    };
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live(native).pipe(
        Layer.provide(
          Layer.mergeAll(testLayer({ platform: "darwin" }), NodeServices.layer, callbacksLayer),
        ),
      ),
      scope,
    );
    const tray = Context.get(context, WindowsTrayRuntime);
    yield* tray.markApplicationReady;
    assert.isFalse(tray.canHideLastWindow());
    assert.deepEqual(yield* tray.startupStatus, { supported: false, enabled: false });
    yield* Scope.close(scope, Exit.void);
  }),
);
