import { it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect, vi } from "vitest";
import type { MobileAccessStatus } from "../../shared/mobile-access";
import { testLayer as configLayer } from "../app/MainConfig";
import { live } from "../ipc/handlers/MobileAccessIpc";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { MobileGateway } from "./MobileGateway";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

it.effect("broadcasts a payload-free change and returns pairing status only to the requester", () =>
  Effect.gen(function* () {
    const broadcasts: unknown[][] = [];
    const sent = yield* Deferred.make<void>();
    const status = {
      enabled: true,
      state: "listening",
      hostName: "Nodex",
      routes: [],
      devices: [],
      failureMessage: null,
      pairing: { uri: "nodex://pairing-secret", expiresAt: 60_000 },
    } satisfies MobileAccessStatus;
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, unknown>
    >();
    yield* Layer.build(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            configLayer({ rendererUrl: "http://localhost:5173" }),
            Layer.succeed(MobileGateway, {
              status: Effect.succeed(status),
              changes: Stream.succeed(undefined),
              setEnabled: () => Effect.succeed(status),
              beginPairing: Effect.succeed(status),
              cancelPairing: Effect.succeed(status),
              revoke: () => Effect.succeed(status),
            }),
            Layer.succeed(
              ElectronIpc,
              makeTestElectronIpc({
                handle: (channel, handler) =>
                  Effect.sync(() => {
                    handlers.set(
                      channel,
                      handler as (
                        event: IpcMainInvokeEvent,
                        ...args: unknown[]
                      ) => Effect.Effect<unknown, unknown>,
                    );
                  }),
                on: () => Effect.void,
              }),
            ),
            Layer.succeed(WindowRuntime, {
              has: (id: number) => id === 1 || id === 2,
              all: () =>
                [1, 2].map((id) => ({
                  id,
                  isDestroyed: () => false,
                  webContents: {
                    id,
                    isDestroyed: () => false,
                    send: (...args: unknown[]) => {
                      broadcasts.push([id, ...args]);
                      if (broadcasts.length === 2) Deferred.doneUnsafe(sent, Effect.void);
                    },
                  },
                })),
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
    );
    yield* Deferred.await(sent);
    const frame = { url: "http://localhost:5173" };
    const event = {
      sender: { id: 1, getType: () => "window", mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    expect(yield* handlers.get("mobile-access:status")!(event)).toEqual(status);
    expect(yield* handlers.get("mobile-access:begin-pairing")!(event)).toEqual(status);
    expect(
      yield* handlers.get("mobile-access:set-enabled")!(event, { enabled: true }),
    ).toMatchObject({ pairing: null });
    expect(
      yield* handlers.get("mobile-access:revoke-device")!(event, { deviceId: "A".repeat(22) }),
    ).toMatchObject({ pairing: null });
    expect(broadcasts).toEqual([
      [1, "mobile-access-changed"],
      [2, "mobile-access-changed"],
    ]);
  }),
);
