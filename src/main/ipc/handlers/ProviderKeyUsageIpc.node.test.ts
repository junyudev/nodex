import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ProviderKeyUsageSnapshot } from "../../../shared/provider-key-usage";
import { testLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ProviderKeyUsage } from "../../provider-keys/ProviderKeyUsage";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ProviderKeyUsageIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  connectionId?: unknown,
) => Effect.Effect<unknown, unknown>;

const personal = "app://-/index.html";
const hosted = "app://-/index.html?spaceId=team";
const event = (url = personal, id = 1, subframe = false) => {
  const frame = { url };
  return {
    sender: { id, mainFrame: frame, getType: () => "window" },
    senderFrame: subframe ? { ...frame } : frame,
  } as unknown as IpcMainInvokeEvent;
};

it.effect("only personal windows can read, refresh or receive API key usage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const refreshed: (string | undefined)[] = [];
      const sent: [number, string, unknown][] = [];
      const snapshot = yield* SubscriptionRef.make<ProviderKeyUsageSnapshot>({ connections: [] });
      const read = SubscriptionRef.get(snapshot);
      const window = (id: number, url: string) => ({
        isDestroyed: () => false,
        webContents: {
          getURL: () => url,
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => sent.push([id, channel, payload]),
        },
      });

      yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              testLayer(),
              Layer.succeed(ProviderKeyUsage, {
                read,
                changes: SubscriptionRef.changes(snapshot),
                refresh: (id) => Effect.sync(() => refreshed.push(id)).pipe(Effect.andThen(read)),
              }),
              Layer.succeed(
                ElectronIpc,
                makeTestElectronIpc({
                  handle: (channel: string, handler: Handler) =>
                    Effect.sync(() => {
                      handlers.set(channel, handler);
                    }),
                  on: () => Effect.void,
                }),
              ),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id <= 3,
                all: () => [window(1, personal), window(2, personal), window(3, hosted)],
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      );

      const readHandler = handlers.get("provider-keys:usage:read")!;
      const refreshHandler = handlers.get("provider-keys:usage:refresh")!;
      const update: ProviderKeyUsageSnapshot = {
        connections: [
          { connectionId: "deep", observedAt: 0, readFailed: false, balance: null, windows: [] },
        ],
      };
      yield* SubscriptionRef.set(snapshot, update);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });
      assert.deepEqual(
        sent.filter(([, , payload]) => payload === update),
        [
          [1, "provider-keys:usage-changed", update],
          [2, "provider-keys:usage-changed", update],
        ],
      );

      for (const sender of [
        event(hosted, 3),
        event("https://untrusted.example"),
        event(personal, 1, true),
        event(personal, 4),
      ]) {
        assert.equal((yield* Effect.result(readHandler(sender)))._tag, "Failure");
        assert.equal((yield* Effect.result(refreshHandler(sender)))._tag, "Failure");
      }
      assert.equal((yield* Effect.result(refreshHandler(event(), { id: "deep" })))._tag, "Failure");
      assert.deepEqual(refreshed, []);
      assert.deepEqual(yield* readHandler(event()), update);
      assert.deepEqual(yield* refreshHandler(event(), "deep"), update);
      assert.deepEqual(yield* refreshHandler(event()), update);
      assert.deepEqual(refreshed, ["deep", undefined]);
    }),
  ),
);
