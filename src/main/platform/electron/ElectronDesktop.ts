import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  Menu,
  Notification,
  WebContentsView,
  dialog,
  nativeTheme,
  powerMonitor,
  safeStorage,
  shell,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type Session,
} from "electron";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { makeNativeNotificationDelivery } from "./NativeNotificationDelivery";
import { getLogger } from "../../logging/logger";
import { NativeNotificationAuthorization } from "./NativeNotificationAuthorization";

export interface ElectronNotificationInput {
  readonly title: string;
  readonly body: string;
  readonly actions?: readonly string[];
  readonly onClick?: Effect.Effect<void>;
  readonly onAction?: (index: number) => Effect.Effect<void>;
}

export class ElectronDesktop extends Context.Service<
  ElectronDesktop,
  {
    readonly dialog: typeof dialog;
    readonly menu: typeof Menu;
    readonly nativeTheme: typeof nativeTheme;
    readonly safeStorage: typeof safeStorage;
    readonly shell: typeof shell;
    readonly showMessage: (options: MessageBoxOptions) => Effect.Effect<MessageBoxReturnValue>;
    readonly showNotification: (input: ElectronNotificationInput) => Effect.Effect<boolean>;
    readonly createDownloadView: (session: Session) => WebContentsView;
    readonly onPowerEvent: (
      event: "lock-screen" | "resume" | "suspend" | "unlock-screen",
      handler: Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/platform/electron/ElectronDesktop") {}

export const live: Layer.Layer<
  ElectronDesktop,
  never,
  ScopedCallbackRuntime | NativeNotificationAuthorization
> = Layer.effect(
  ElectronDesktop,
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    const authorization = yield* NativeNotificationAuthorization;
    const deliver = yield* makeNativeNotificationDelivery({
      authorization,
      isSupported: () => Notification.isSupported(),
      createNotification: (input) =>
        new Notification({
          title: input.title,
          body: input.body,
          actions: input.actions?.map((text) => ({ type: "button" as const, text })),
        }),
      runCallback: (effect) => {
        callbacks.fork(effect);
      },
      logger: getLogger({ component: "native-notification-delivery" }),
    });
    return ElectronDesktop.of({
      dialog,
      menu: Menu,
      nativeTheme,
      safeStorage,
      shell,
      showMessage: (options) => Effect.promise(() => dialog.showMessageBox(options)),
      showNotification: (input) => deliver(input).pipe(Effect.orDie),
      createDownloadView: (session) =>
        new WebContentsView({
          webPreferences: { session, sandbox: true, nodeIntegration: false },
        }),
      onPowerEvent: (event, handler) => {
        const listener = () => {
          callbacks.fork(handler);
        };
        const register = () => {
          if (event === "lock-screen") return powerMonitor.on("lock-screen", listener);
          if (event === "unlock-screen") return powerMonitor.on("unlock-screen", listener);
          if (event === "resume") return powerMonitor.on("resume", listener);
          return powerMonitor.on("suspend", listener);
        };
        const unregister = () => {
          if (event === "lock-screen") return powerMonitor.removeListener("lock-screen", listener);
          if (event === "unlock-screen")
            return powerMonitor.removeListener("unlock-screen", listener);
          if (event === "resume") return powerMonitor.removeListener("resume", listener);
          return powerMonitor.removeListener("suspend", listener);
        };
        return Effect.acquireRelease(Effect.sync(register), () => Effect.sync(unregister));
      },
    });
  }),
);
