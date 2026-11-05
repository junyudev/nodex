import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { IpcEvents } from "../../../shared/ipc-api";
import type { MobileAccessStatus } from "../../../shared/mobile-access";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { MobileGateway } from "../../mobile-gateway/MobileGateway";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const omitPairing = Effect.map((status: MobileAccessStatus) => ({ ...status, pairing: null }));

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const gateway = yield* MobileGateway;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const trusted = mapElectronIpcHandlers(
      ipc,
      (_, run) =>
        (event, ...args) =>
          Effect.try(() => {
            requireTrustedAppRendererSender(event, "Mobile Access", config.rendererUrl);
            if (!windows.has(event.sender.id))
              throw new Error("Mobile Access requires an active Nodex window.");
          }).pipe(Effect.andThen(Effect.suspend(() => run(event, ...args)))),
    );

    yield* trusted.handleQuery("mobile-access:status", () => gateway.status);
    yield* trusted.handlePlainCommand("mobile-access:set-enabled", (_, input) => {
      if (typeof input?.enabled !== "boolean")
        return Effect.fail(new Error("The enabled state is invalid."));
      return gateway.setEnabled(input.enabled).pipe(omitPairing);
    });
    yield* trusted.handlePlainCommand("mobile-access:begin-pairing", () => gateway.beginPairing);
    yield* trusted.handlePlainCommand("mobile-access:cancel-pairing", () =>
      gateway.cancelPairing.pipe(omitPairing),
    );
    yield* trusted.handlePlainCommand("mobile-access:revoke-device", (_, input) => {
      if (typeof input?.deviceId !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(input.deviceId))
        return Effect.fail(new Error("The device identity is invalid."));
      return gateway.revoke(input.deviceId).pipe(omitPairing);
    });
    yield* gateway.changes.pipe(
      Stream.runForEach(() =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "mobile-access-changed" satisfies keyof IpcEvents),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
