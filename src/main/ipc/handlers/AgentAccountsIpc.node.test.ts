import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AcpAgents } from "../../acp-agents/AcpAgents";
import { testLayer } from "../../app/MainConfig";
import { layer as callbacks, ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live as acpIpc } from "./AcpAgentsIpc";
import { live as accountIpc } from "./AgentAccountsIpc";
import { AgentAccounts } from "../../agent-accounts/AgentAccounts";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { isSpaceIpcChannel } from "../../../shared/space-ipc-policy";
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
      const changes = yield* PubSub.sliding<void>(1);
      const released = yield* PubSub.subscribe(releases);
      const callbackContext = yield* Layer.build(callbacks);
      const runtime = Context.get(callbackContext, ScopedCallbackRuntime);
      yield* Layer.build(
        Layer.merge(acpIpc, accountIpc).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AcpAgents, {
                changes: Stream.fromPubSub(changes),
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
              } as unknown as AcpAgents["Service"]),
              Layer.succeed(AgentAccounts, {
                changes: Stream.empty,
                start: (ownerId: string, input: unknown) =>
                  Effect.sync(() => {
                    calls.push({ ownerId, input });
                    return {};
                  }),
                releaseOwner: (ownerId: string) =>
                  PubSub.publish(releases, ownerId).pipe(Effect.asVoid),
              } as unknown as AgentAccounts["Service"]),
              Layer.succeed(AgentRuntimeApplication, {} as AgentRuntimeApplication["Service"]),
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
        isDestroyed: () => false,
        mainFrame: frame,
        getType: () => "window",
      });
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
      const start = handlers.get("agent-accounts:start")!;
      assert.isTrue(isSpaceIpcChannel("agent-accounts:start"));
      assert.isTrue(isSpaceIpcChannel("agent-accounts:read"));
      const backend = { kind: "antigravity", instanceConfigId: "personal" };
      yield* start(event, { backend });
      yield* start(event, { backend: { kind: "acp", instanceConfigId: "work" } });
      assert.equal(calls[0]?.ownerId, calls[1]?.ownerId);
      assert.isNotEmpty(calls[0]!.ownerId);
      const foreign = {
        ...event,
        senderFrame: { url: "https://foreign.example" },
      } as IpcMainInvokeEvent;
      const unauthorized = (yield* start(foreign, { backend })) as { ok: boolean };
      const forged = (yield* start(event, { backend, ownerId: "forged" })) as {
        ok: boolean;
      };
      assert.isFalse(unauthorized.ok);
      assert.isFalse(forged.ok);
      const injected = (yield* start(event, {
        backend: { ...backend, runtimeInstanceId: "forged" },
        methodId: "key",
      })) as { ok: boolean };
      assert.isFalse(injected.ok);
      assert.equal(calls.length, 2);
      const read = handlers.get("acp:operation:read")!;
      yield* read(event, { operationId: "operation" });
      assert.deepEqual(broadcasts, []);
      yield* PubSub.publish(changes, undefined);
      yield* Effect.yieldNow;
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
        isDestroyed: () => false,
        mainFrame: frame,
        getType: () => "window",
      });
      yield* start({ sender: secondSender, senderFrame: frame } as unknown as IpcMainInvokeEvent, {
        backend,
      });
      assert.notEqual(calls[0]?.ownerId, calls[2]?.ownerId);
      assert.deepEqual(broadcasts, ["agent-settings-changed"]);
      sender.emit("destroyed");
      assert.equal(yield* PubSub.take(released), calls[0]?.ownerId);
      secondSender.emit("render-process-gone");
      assert.equal(yield* PubSub.take(released), calls[2]?.ownerId);
      assert.equal(secondSender.listenerCount("render-process-gone"), 0);
    }),
);
