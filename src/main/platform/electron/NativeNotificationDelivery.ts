import * as Effect from "effect/Effect";
import type { ElectronNotificationInput } from "./ElectronDesktop";
import type { NativeNotificationAuthorizationService } from "./NativeNotificationAuthorization";
import { canDeliverDesktopNotification } from "../../../shared/desktop-notification-authorization";

interface NativeNotificationInstance {
  show(): void;
  close(): void;
  on(
    event: "show" | "failed" | "close" | "click" | "action",
    listener: (...args: unknown[]) => void,
  ): unknown;
  removeAllListeners(): unknown;
}

/** Resolves delivery only when Electron confirms native scheduling, retaining actions until the first interaction or close. */
export const makeNativeNotificationDelivery = Effect.fnUntraced(function* (options: {
  readonly authorization: NativeNotificationAuthorizationService;
  readonly isSupported: () => boolean;
  readonly createNotification: (input: ElectronNotificationInput) => NativeNotificationInstance;
  readonly runCallback: (effect: Effect.Effect<void>) => void;
  readonly logger: Pick<Console, "warn">;
}) {
  const active = new Set<() => void>();
  let accepting = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      accepting = false;
      for (const close of [...active]) close();
    }),
  );

  return (input: ElectronNotificationInput): Effect.Effect<boolean, unknown> =>
    options.authorization.request.pipe(
      Effect.flatMap((status) => {
        if (!accepting || !options.isSupported() || !canDeliverDesktopNotification(status))
          return Effect.succeed(false);
        return Effect.callback<boolean, unknown>((resume) => {
          let instance: NativeNotificationInstance;
          try {
            instance = options.createNotification(input);
          } catch (error) {
            resume(Effect.fail(error));
            return;
          }
          let pending = true;
          let released = false;
          const settle = (result: Effect.Effect<boolean, unknown>) => {
            if (!pending) return;
            pending = false;
            resume(result);
          };
          const release = () => {
            if (released) return false;
            released = true;
            active.delete(close);
            instance.removeAllListeners();
            return true;
          };
          const closeNative = () => {
            try {
              instance.close();
            } catch (error) {
              options.logger.warn("[desktop-notifications] native close failed", { error });
            }
          };
          const close = () => {
            if (!release()) return;
            settle(Effect.succeed(false));
            closeNative();
          };
          const consume = () => {
            if (!release()) return false;
            // Native interaction proves delivery even if the queued show event has not arrived.
            settle(Effect.succeed(true));
            return true;
          };
          instance.on("show", () => settle(Effect.succeed(true)));
          instance.on("close", () => {
            release();
            settle(Effect.succeed(false));
          });
          instance.on("failed", (_event, error) => {
            if (!release()) return;
            settle(
              Effect.fail(
                new Error(
                  typeof error === "string" ? error : "Native notification delivery failed",
                  { cause: error },
                ),
              ),
            );
          });
          instance.on("click", () => {
            // Electron destroys clicked notifications without emitting close.
            if (!consume()) return;
            if (input.onClick !== undefined) options.runCallback(input.onClick);
          });
          instance.on("action", (_event, index) => {
            if (typeof index !== "number" || !consume()) return;
            // macOS action callbacks do not destroy or close their notification.
            closeNative();
            if (input.onAction !== undefined) options.runCallback(input.onAction(index));
          });
          active.add(close);
          try {
            instance.show();
          } catch (error) {
            settle(Effect.fail(error));
            close();
          }
          return Effect.sync(close);
        });
      }),
    );
});
