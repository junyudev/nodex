import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { live, pluginCommandSchemas, pluginQuerySchemas } from "./PluginManagerIpc";
import { PluginManager } from "../../codex-application/PluginManager";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { testLayer } from "../../app/MainConfig";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import type { PluginManagementChanged } from "../../../shared/codex-plugin-management";
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  protocol: {},
  BrowserWindow: { fromWebContents: () => ({}) },
}));
type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
const event = (kind = "window"): IpcMainInvokeEvent => {
  const frame = { url: "http://localhost:5173" };
  return {
    senderFrame: frame,
    sender: { mainFrame: frame, getType: () => kind },
  } as unknown as IpcMainInvokeEvent;
};
it.effect("validates selector XOR and typed command booleans at ingress", () =>
  Effect.gen(function* () {
    const base = { hostId: "local", projectId: null, pluginName: "name" };
    for (const input of [
      { ...base },
      { ...base, marketplacePath: "/catalog", remoteMarketplaceName: "remote" },
      { ...base, marketplacePath: null },
    ])
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginQuerySchemas.read)(input).pipe(Effect.result))
          ._tag,
        "Failure",
      );
    assert.strictEqual(
      (yield* Schema.decodeUnknownEffect(pluginQuerySchemas.read)({
        ...base,
        marketplacePath: "/catalog",
      }).pipe(Effect.result))._tag,
      "Success",
    );
    assert.strictEqual(
      (yield* Schema.decodeUnknownEffect(pluginCommandSchemas["set-enabled"])({
        hostId: "local",
        projectId: null,
        pluginId: "p",
        enabled: "false",
      }).pipe(Effect.result))._tag,
      "Failure",
    );
  }),
);
it.effect(
  "rejects untrusted senders before the owner and fans out host-qualified events to every window",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const delivered: unknown[][] = [];
        const events = yield* PubSub.unbounded<PluginManagementChanged>();
        let reads = 0;
        const manager = PluginManager.of({
          changes: Stream.fromPubSub(events),
          query: () =>
            Effect.sync(() => {
              reads++;
              return {} as never;
            }),
          command: () => Effect.succeed({} as never),
        });
        const ipc = makeTestElectronIpc({
          handle: (channel, handler) =>
            Effect.sync(() => {
              handlers.set(channel, handler as Handler);
            }),
          on: () => Effect.void,
        });
        const window = () => ({
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (...args: unknown[]) => delivered.push(args),
          },
        });
        yield* Layer.build(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                testLayer({ rendererUrl: "http://localhost:5173" }),
                Layer.succeed(ElectronIpc, ipc),
                Layer.succeed(PluginManager, manager),
                Layer.succeed(WindowRuntime, {
                  all: () => [window(), window()],
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
        );
        assert.strictEqual(
          (yield* handlers.get("codex:plugins:installed")!(event("webview"), {
            hostId: "local",
            projectId: null,
          }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(reads, 0);
        yield* handlers.get("codex:plugins:installed")!(event(), {
          hostId: "local",
          projectId: null,
        });
        assert.strictEqual(reads, 1);
        const change: PluginManagementChanged = {
          hostId: "local",
          accountEpoch: 1,
          kind: "skills",
        };
        yield* PubSub.publish(events, change);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(delivered, [
          ["codex:plugins:changed", change],
          ["codex:plugins:changed", change],
        ]);
      }),
    ),
);
