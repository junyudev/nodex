import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { loadNativeNotificationBridge } from "./NativeNotificationAuthorization";

export class AppBadge extends Context.Service<
  AppBadge,
  {
    /** Shows a count on the app's icon, or clears it at zero, where the platform has one. */
    readonly set: (count: number) => Effect.Effect<void>;
  }
>()("nodex/main/platform/electron/AppBadge") {}

/**
 * macOS sets the badge through the notification center, so the system's Badges switch and the
 * bundle's notification authorization decide whether it shows. Linux launchers take the count
 * directly. Windows has no app badge.
 */
export const makeAppBadge = (options: {
  readonly platform: NodeJS.Platform;
  readonly setNotificationCenterBadge: (count: number) => void;
  readonly setLauncherBadge: (count: number) => void;
}) => {
  const setBadge =
    options.platform === "darwin"
      ? options.setNotificationCenterBadge
      : options.platform === "linux"
        ? options.setLauncherBadge
        : null;
  return AppBadge.of({
    set: (count) =>
      setBadge
        ? Effect.try(() => setBadge(count)).pipe(
            Effect.catch((cause) => Effect.logWarning("The app badge could not be set", cause)),
          )
        : Effect.void,
  });
};

export const live: Layer.Layer<AppBadge, never, MainConfig> = Layer.effect(
  AppBadge,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return makeAppBadge({
      platform: config.platform as NodeJS.Platform,
      setNotificationCenterBadge: (count) =>
        loadNativeNotificationBridge(config).setBadgeCount(count),
      setLauncherBadge: (count) => {
        app.setBadgeCount(count);
      },
    });
  }),
);
