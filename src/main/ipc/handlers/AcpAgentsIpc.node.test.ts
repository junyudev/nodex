import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { AcpAgents } from "../../acp-agents/AcpAgents";
import { testLayer } from "../../app/MainConfig";
import { layer as callbacks, ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AcpAgentsIpc";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
it.effect(
  "authorizes the main frame, validates inputs, and releases window-owned authentication",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const calls: { ownerId: string; input: unknown }[] = [];
      const releases = yield* PubSub.unbounded<string>();
      const released = yield* PubSub.subscribe(releases);
      const callbackContext = yield* Layer.build(callbacks);
      const runtime = Context.get(callbackContext, ScopedCallbackRuntime);
      yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AcpAgents, {
                "acp.auth.start": (ownerId: string, input: unknown) =>
                  Effect.sync(() => {
                    calls.push({ ownerId, input });
                    return {};
                  }),
                releaseOwner: (ownerId: string) =>
                  PubSub.publish(releases, ownerId).pipe(Effect.asVoid),
              } as unknown as AcpAgents["Service"]),
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
                has: (id: number) => id === 1,
              } as unknown as WindowRuntime["Service"]),
              Layer.succeed(ScopedCallbackRuntime, runtime),
              testLayer(),
            ),
          ),
        ),
      );
      const frame = { url: "app://-/index.html" };
      const sender = Object.assign(new EventEmitter(), {
        id: 1,
        mainFrame: frame,
        getType: () => "window",
      });
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
      const start = handlers.get("acp:auth:start")!;
      yield* start(event, { instanceId: "personal" });
      yield* start(event, { instanceId: "work" });
      assert.equal(calls[0]?.ownerId, calls[1]?.ownerId);
      assert.isNotEmpty(calls[0]!.ownerId);
      const foreign = {
        ...event,
        senderFrame: { url: "https://foreign.example" },
      } as IpcMainInvokeEvent;
      assert.equal(
        (yield* Effect.result(start(foreign, { instanceId: "personal" })))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(start(event, { instanceId: "personal", ownerId: "forged" })))._tag,
        "Failure",
      );
      assert.equal(calls.length, 2);
      sender.emit("destroyed");
      assert.equal(yield* PubSub.take(released), calls[0]?.ownerId);
      assert.equal(sender.listenerCount("render-process-gone"), 0);
    }),
);
