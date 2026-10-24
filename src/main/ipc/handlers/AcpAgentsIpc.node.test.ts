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
import type { AgentAcpFailure } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeProcessError } from "../../platform/node/AgentRuntimeProcess";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
it.effect(
  "authorizes the main frame, validates inputs, and releases window-owned authentication",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const calls: { ownerId: string; input: unknown }[] = [];
      const broadcasts: string[] = [];
      let operationPhase = "running";
      const releases = yield* PubSub.unbounded<string>();
      const released = yield* PubSub.subscribe(releases);
      const callbackContext = yield* Layer.build(callbacks);
      const runtime = Context.get(callbackContext, ScopedCallbackRuntime);
      yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AcpAgents, {
                presentFailure: (error: AgentAcpFailure) =>
                  Effect.succeed({
                    ...error,
                    affectedSessions: [{ sessionId: "chat", threadId: "root" }],
                  }),
                "acp.operation.read": () =>
                  Effect.succeed({ operationId: "operation", phase: operationPhase }),
                "acp.modelProviders.set": () =>
                  Effect.fail(
                    new AgentRuntimeProcessError({
                      reason: "rejected",
                      message: "Busy",
                      acp: {
                        reason: "busy",
                        message: "Stop active work first.",
                        affectedThreadIds: ["root"],
                      },
                    }),
                  ),
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
                has: (id: number) => id === 1 || id === 2,
                all: () => [
                  {
                    isDestroyed: () => false,
                    webContents: {
                      isDestroyed: () => false,
                      send: (channel: string) => broadcasts.push(channel),
                    },
                  },
                ],
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
      const unauthorized = (yield* start(foreign, { instanceId: "personal" })) as { ok: boolean };
      const forged = (yield* start(event, { instanceId: "personal", ownerId: "forged" })) as {
        ok: boolean;
      };
      assert.isFalse(unauthorized.ok);
      assert.isFalse(forged.ok);
      assert.equal(calls.length, 2);
      const read = handlers.get("acp:operation:read")!;
      yield* read(event, { operationId: "operation" });
      assert.deepEqual(broadcasts, []);
      operationPhase = "succeeded";
      yield* read(event, { operationId: "operation" });
      yield* read(event, { operationId: "operation" });
      assert.deepEqual(broadcasts, ["agent-settings-changed"]);
      const refusal = yield* handlers.get("acp:modelProviders:set")!(event, {
        instanceId: "personal",
        providerId: "model",
        apiType: "openai",
        baseUrl: "https://models.example.test",
      });
      assert.deepEqual(refusal, {
        ok: false,
        error: {
          reason: "busy",
          message: "Stop active work first.",
          affectedThreadIds: ["root"],
          affectedSessions: [{ sessionId: "chat", threadId: "root" }],
        },
      });
      assert.deepEqual(broadcasts, ["agent-settings-changed"]);
      const secondSender = Object.assign(new EventEmitter(), {
        id: 2,
        mainFrame: frame,
        getType: () => "window",
      });
      yield* read({ sender: secondSender, senderFrame: frame } as unknown as IpcMainInvokeEvent, {
        operationId: "operation",
      });
      assert.deepEqual(broadcasts, ["agent-settings-changed", "agent-settings-changed"]);
      sender.emit("destroyed");
      assert.equal(yield* PubSub.take(released), calls[0]?.ownerId);
      assert.equal(sender.listenerCount("render-process-gone"), 0);
    }),
);
