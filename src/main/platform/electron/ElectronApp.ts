import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { app, type Event, type WebContents, type Certificate } from "electron";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";

export class ElectronAppError extends Schema.TaggedError<ElectronAppError>()("ElectronAppError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface ElectronBeforeQuitDecision {
  readonly preventDefault: boolean;
  readonly task: Effect.Effect<void>;
}

export type ElectronTerminationSignal = "SIGINT" | "SIGTERM";

export class ElectronApp extends Context.Service<
  ElectronApp,
  {
    readonly appPath: Effect.Effect<string>;
    readonly downloadsPath: Effect.Effect<string>;
    readonly isInApplicationsFolder: Effect.Effect<boolean>;
    readonly locale: Effect.Effect<string>;
    readonly userDataPath: Effect.Effect<string>;
    readonly whenReady: Effect.Effect<void, ElectronAppError>;
    readonly quit: Effect.Effect<void>;
    readonly relaunch: Effect.Effect<void>;
    readonly exit: (code: number) => Effect.Effect<void>;
    readonly onActivate: (handler: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
    readonly onBeforeQuit: (
      handler: () => ElectronBeforeQuitDecision,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly onOpenUrl: (
      handler: (url: string) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly onSecondInstance: (
      handler: (argv: readonly string[]) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly onTerminationSignal: (
      handler: (signal: ElectronTerminationSignal) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly onWindowAllClosed: (
      handler: Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/platform/electron/ElectronApp") {}

const scopedListener = <A extends readonly unknown[]>(
  register: (listener: (...args: A) => void) => void,
  unregister: (listener: (...args: A) => void) => void,
  listener: (...args: A) => void,
) =>
  Effect.acquireRelease(
    Effect.sync(() => register(listener)),
    () => Effect.sync(() => unregister(listener)),
  );

/** Background requests must not silently disclose a platform client certificate. */
export const selectMainClientCertificate = (
  event: Pick<Event, "preventDefault">,
  webContents: WebContents | null,
  _url: string,
  _certificates: readonly Certificate[],
  callback: (certificate?: Certificate) => void,
): void => {
  if (webContents !== null) return;
  event.preventDefault();
  callback();
};

export const live: Layer.Layer<ElectronApp, never, ScopedCallbackRuntime> = Layer.effect(
  ElectronApp,
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    yield* scopedListener(
      (listener) => app.on("select-client-certificate", listener),
      (listener) => app.removeListener("select-client-certificate", listener),
      selectMainClientCertificate,
    );
    const fork = (effect: Effect.Effect<void>) => {
      callbacks.fork(effect);
    };

    return ElectronApp.of({
      appPath: Effect.sync(() => app.getAppPath()),
      downloadsPath: Effect.sync(() => app.getPath("downloads")),
      isInApplicationsFolder: Effect.sync(
        () => typeof app.isInApplicationsFolder !== "function" || app.isInApplicationsFolder(),
      ),
      locale: Effect.sync(() => app.getLocale()),
      userDataPath: Effect.sync(() => app.getPath("userData")),
      whenReady: Effect.tryPromise({
        try: () => app.whenReady(),
        catch: (cause) => new ElectronAppError({ operation: "when-ready", cause }),
      }).pipe(Effect.asVoid),
      quit: Effect.sync(() => app.quit()),
      relaunch: Effect.sync(() => app.relaunch()),
      exit: (code) => Effect.sync(() => app.exit(code)),
      onActivate: (handler) => {
        const listener = () => fork(handler);
        return scopedListener(
          (registered) => app.on("activate", registered),
          (registered) => app.removeListener("activate", registered),
          listener,
        );
      },
      onBeforeQuit: (handler) => {
        const listener = (event: Event) => {
          const decision = handler();
          if (decision.preventDefault) event.preventDefault();
          fork(decision.task);
        };
        return scopedListener(
          (registered) => app.on("before-quit", registered),
          (registered) => app.removeListener("before-quit", registered),
          listener,
        );
      },
      onOpenUrl: (handler) => {
        const listener = (event: Event, url: string) => {
          event.preventDefault();
          fork(handler(url));
        };
        return scopedListener(
          (registered) => app.on("open-url", registered),
          (registered) => app.removeListener("open-url", registered),
          listener,
        );
      },
      onSecondInstance: (handler) => {
        const listener = (_event: Event, argv: string[]) => fork(handler([...argv]));
        return scopedListener(
          (registered) => app.on("second-instance", registered),
          (registered) => app.removeListener("second-instance", registered),
          listener,
        );
      },
      onTerminationSignal: (handler) => {
        const onSigint = () => fork(handler("SIGINT"));
        const onSigterm = () => fork(handler("SIGTERM"));
        return Effect.acquireRelease(
          Effect.sync(() => {
            process.on("SIGINT", onSigint);
            try {
              process.on("SIGTERM", onSigterm);
            } catch (error) {
              process.removeListener("SIGINT", onSigint);
              throw error;
            }
          }),
          () =>
            Effect.sync(() => {
              process.removeListener("SIGINT", onSigint);
              process.removeListener("SIGTERM", onSigterm);
            }),
        );
      },
      onWindowAllClosed: (handler) => {
        const listener = () => fork(handler);
        return scopedListener(
          (registered) => app.on("window-all-closed", registered),
          (registered) => app.removeListener("window-all-closed", registered),
          listener,
        );
      },
    });
  }),
);
