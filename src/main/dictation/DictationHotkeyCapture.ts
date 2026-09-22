import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import type { BrowserWindow } from "electron";

/** Couples native shortcut capture to its focused Electron sender and the Profile Scope. */
export const makeDictationHotkeyCapture = Effect.fn("DictationHotkeyCapture.make")(
  function* (options: {
    readonly primaryWindows: () => readonly BrowserWindow[];
    readonly capture: (
      window: BrowserWindow,
      signal: AbortSignal,
      allowsBareModifiers: boolean,
    ) => Promise<string | null>;
  }) {
    const captures = yield* FiberMap.make<number, string | null>();
    const callbacks = yield* FiberSet.make();
    const runCallback = yield* FiberSet.runtime(callbacks)();
    const cancel = Effect.fn("DictationHotkeyCapture.cancel")(function* (webContentsId: number) {
      const active = yield* FiberMap.has(captures, webContentsId);
      yield* FiberMap.remove(captures, webContentsId);
      return active;
    });
    const capture = Effect.fn("DictationHotkeyCapture.capture")(function* (
      webContentsId: number,
      allowsBareModifiers: boolean,
    ) {
      const window = options
        .primaryWindows()
        .find(
          (candidate) =>
            !candidate.isDestroyed() &&
            candidate.webContents.id === webContentsId &&
            candidate.isFocused(),
        );
      if (!window || window.webContents.isDestroyed()) return null;
      const operation = Effect.acquireUseRelease(
        Effect.sync(() => {
          const stop = (): void => {
            void runCallback(cancel(webContentsId));
          };
          const navigate = (
            event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
          ): void => {
            if (event.isMainFrame && !event.isSameDocument) stop();
          };
          window.once("blur", stop);
          window.webContents.once("destroyed", stop);
          window.webContents.once("render-process-gone", stop);
          window.webContents.on("did-start-navigation", navigate);
          return () => {
            window.removeListener("blur", stop);
            window.webContents.removeListener("destroyed", stop);
            window.webContents.removeListener("render-process-gone", stop);
            window.webContents.removeListener("did-start-navigation", navigate);
          };
        }),
        () =>
          Effect.callback<string | null>((resume) => {
            const controller = new AbortController();
            const pending = options.capture(window, controller.signal, allowsBareModifiers);
            void pending.then(
              (accelerator) => resume(Effect.succeed(accelerator)),
              () => resume(Effect.succeed(null)),
            );
            return Effect.promise(async () => {
              controller.abort();
              await pending.catch(() => undefined);
            });
          }),
        (release) => Effect.sync(release),
      );
      const fiber = yield* FiberMap.run(captures, webContentsId, operation, {
        startImmediately: true,
      });
      return yield* Fiber.join(fiber).pipe(Effect.catchCause(() => Effect.succeed(null)));
    });
    return { capture, cancel };
  },
);
