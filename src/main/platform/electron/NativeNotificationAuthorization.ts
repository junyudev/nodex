import { createRequire } from "node:module";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Notification } from "electron";
import { MainConfig } from "../../app/MainConfig";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { DesktopNotificationAuthorization } from "../../../shared/desktop-notification-authorization";

const NativeAuthorization = Schema.Literals([
  "not-determined",
  "denied",
  "authorized",
  "provisional",
]);

interface NativeNotificationBridge {
  readonly readAuthorization: () => Promise<unknown>;
  readonly requestAuthorization: () => Promise<unknown>;
}

const require = createRequire(import.meta.url);

export interface NativeNotificationAuthorizationService {
  readonly read: Effect.Effect<DesktopNotificationAuthorization, unknown>;
  readonly request: Effect.Effect<DesktopNotificationAuthorization, unknown>;
}

/** Read the running Electron bundle's authorization; browser permission is a separate capability. */
export const makeNativeNotificationAuthorization = Effect.fnUntraced(function* (options: {
  readonly platform: string;
  readonly isSupported: () => boolean;
  readonly loadBridge: () => NativeNotificationBridge;
}) {
  if (options.platform !== "darwin") {
    const read = Effect.sync((): DesktopNotificationAuthorization =>
      options.isSupported() ? "unknown" : "unsupported",
    );
    return { read, request: read } satisfies NativeNotificationAuthorizationService;
  }
  let bridge: NativeNotificationBridge | undefined;
  const binding = () => (bridge ??= options.loadBridge());
  const read = Effect.tryPromise(() => binding().readAuthorization()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NativeAuthorization)),
  );
  const requests = yield* Semaphore.make(1);
  const request = requests.withPermits(1)(
    read.pipe(
      Effect.flatMap((status) =>
        status !== "not-determined"
          ? Effect.succeed(status)
          : Effect.tryPromise(() => binding().requestAuthorization()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(NativeAuthorization)),
            ),
      ),
    ),
  );
  return { read, request } satisfies NativeNotificationAuthorizationService;
});

export class NativeNotificationAuthorization extends Context.Service<
  NativeNotificationAuthorization,
  NativeNotificationAuthorizationService
>()("nodex/main/platform/electron/NativeNotificationAuthorization") {}

export const live: Layer.Layer<NativeNotificationAuthorization, never, MainConfig> = Layer.effect(
  NativeNotificationAuthorization,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return yield* makeNativeNotificationAuthorization({
      platform: config.platform,
      isSupported: () => Notification.isSupported(),
      loadBridge: () =>
        require(
          config.isPackaged
            ? join(config.resourcesPath, "native", "nodex-notifications.node")
            : join(
                config.projectRootPath,
                ".generated",
                "notifications-runtime",
                config.arch,
                "nodex-notifications.node",
              ),
        ) as NativeNotificationBridge,
    });
  }),
);
