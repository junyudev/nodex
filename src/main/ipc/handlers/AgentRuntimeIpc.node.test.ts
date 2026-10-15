import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentRuntimeSessionEvent } from "../../../shared/agent-runtime-api";
import type { AgentEvent, AgentRuntimeNotification } from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../../agent-runtime/AgentRuntimeSupervisor";
import { testLayer } from "../../app/MainConfig";
import { layer as callbacks, ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AgentRuntimeIpc";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
const engineEvent = {
  sequence: 9,
  commandId: null,
  event: { type: "thread.updated", payload: {} },
} as unknown as AgentEvent;

const setup = Effect.gen(function* () {
  const handlers = new Map<string, Handler>();
  const bus = yield* PubSub.sliding<{ delivery: number; notification: AgentRuntimeNotification }>(
    256,
  );
  const terminated = yield* Deferred.make<never>();
  const received = yield* PubSub.unbounded<{ sender: number; message: AgentRuntimeSessionEvent }>();
  const releases = yield* PubSub.unbounded<string>();
  const calls: unknown[] = [];
  const callbackContext = yield* Layer.build(callbacks);
  const callbackRuntime = Context.get(callbackContext, ScopedCallbackRuntime);
  let backendId = 0;
  let delivery = 0;
  const connection = {
    identity: { runtimeId: "engine" },
    notifications: Stream.fromPubSub(bus),
    subscribeNotifications: PubSub.subscribe(bus).pipe(Effect.map(Stream.fromSubscription)),
    subscribeExecutionNotifications: PubSub.subscribe(bus).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    terminated: Deferred.await(terminated),
    request: (method: string, input: { subscriptionId?: string }) =>
      Effect.gen(function* () {
        if (method === "events.unobserve") {
          yield* PubSub.publish(releases, input.subscriptionId!);
          return { unsubscribed: true };
        }
        const subscriptionId = `backend:${++backendId}`;
        // This replay deliberately arrives before the observe acknowledgement.
        yield* PubSub.publish(bus, {
          delivery: ++delivery,
          notification: { type: "event", subscriptionId, event: engineEvent },
        });
        return { subscribed: true, subscriptionId, afterSequence: 0 };
      }),
  };
  const application = {
    launch: (input: unknown) =>
      Effect.sync(() => {
        calls.push(input);
        return {};
      }),
    respond: (input: unknown) =>
      Effect.sync(() => {
        calls.push(input);
        return { sequence: 1 };
      }),
    readQueuePage: (input: unknown) =>
      Effect.sync(() => {
        calls.push(input);
        return { snapshotSequence: 1, entries: [], nextCursor: null, nextRunId: null };
      }),
    readQueuedPreview: (input: unknown) =>
      Effect.sync(() => {
        calls.push(input);
        return { threadId: "child", runId: "queued", messageId: "message", text: "Preview" };
      }),
    resolveTarget: (input: { sessionId: string; threadId?: string }) =>
      Effect.succeed({
        sessionId: input.sessionId,
        threadId: input.threadId ?? "thread",
        runtimeId: "engine",
      }),
  } as unknown as AgentRuntimeApplication["Service"];
  yield* Layer.build(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentRuntimeApplication, application),
          Layer.succeed(AgentRuntimeSupervisor, { get: () => Effect.succeed(connection) } as never),
          Layer.succeed(
            ElectronIpc,
            makeTestElectronIpc({
              handle: (channel, handler) =>
                Effect.sync(() => {
                  handlers.set(channel, handler as Handler);
                }),
              on: () => Effect.void,
            }),
          ),
          Layer.succeed(WindowRuntime, { has: (id: number) => id === 1 || id === 2 } as never),
          testLayer(),
          Layer.succeed(ScopedCallbackRuntime, callbackRuntime),
        ),
      ),
    ),
  );
  const event = (id: number) => {
    const frame = { url: "app://-/index.html" };
    const sender = Object.assign(new EventEmitter(), {
      id,
      mainFrame: frame,
      getType: () => "window",
      isDestroyed: () => false,
      send: (_channel: string, message: AgentRuntimeSessionEvent) => {
        callbackRuntime.fork(PubSub.publish(received, { sender: id, message }));
      },
    });
    return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  };
  const send = (notification: AgentRuntimeNotification, gap = false) =>
    PubSub.publish(bus, { delivery: (delivery += gap ? 2 : 1), notification });
  return { handlers, received, releases, calls, event, send, backend: () => backendId };
});

it.effect(
  "rejects untrusted renderer origins and malformed launch identity before application dispatch",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const launch = fixture.handlers.get("agent-runtime:session:launch")!;
      const input = {
        launchId: "launch",
        acceptedAt: 1,
        sessionId: "session",
        projectId: "project",
        title: "Task",
        modelSelection: { instanceId: "codex", model: "gpt-6" },
        interactionMode: "default",
        message: { messageId: "message", text: "Do it" },
      };
      const trusted = fixture.event(1);
      yield* launch(trusted, input);
      const foreign = {
        ...trusted,
        senderFrame: { url: "https://example.com" },
      } as unknown as IpcMainInvokeEvent;
      assert.equal((yield* launch(foreign, input).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* launch(trusted, { ...input, launchId: " " }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.calls.length, 1);
    }),
);

it.effect(
  "subscribes before replay acknowledgement and binds release to the observing renderer",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const messages = yield* PubSub.subscribe(fixture.received);
      const releases = yield* PubSub.subscribe(fixture.releases);
      const owner = fixture.event(1);
      yield* fixture.handlers.get("agent-runtime:session:observe")!(owner, {
        sessionId: "session",
        threadId: "thread",
        subscriptionId: "watch",
        afterSequence: 0,
      });
      const next = yield* PubSub.take(messages);
      assert.equal(next.sender, 1);
      assert.equal(next.message.subscriptionId, "watch");
      assert.equal(next.message.type, "event");
      if (next.message.type !== "event") throw new Error("Expected replay event");
      assert.equal(next.message.event.sequence, 9);
      yield* fixture.handlers.get("agent-runtime:session:unobserve")!(fixture.event(2), {
        subscriptionId: "watch",
      });
      assert.equal(fixture.backend(), 1);
      yield* fixture.handlers.get("agent-runtime:session:unobserve")!(owner, {
        subscriptionId: "watch",
      });
      assert.equal(yield* PubSub.take(releases), "backend:1");
    }),
);

it.effect(
  "delivery gaps request a reset and renderer destruction releases the engine subscription",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const messages = yield* PubSub.subscribe(fixture.received);
      const releases = yield* PubSub.subscribe(fixture.releases);
      const owner = fixture.event(1);
      yield* fixture.handlers.get("agent-runtime:session:observe")!(owner, {
        sessionId: "session",
        threadId: "thread",
        subscriptionId: "watch",
        afterSequence: 0,
      });
      yield* PubSub.take(messages);
      yield* fixture.send({ type: "event", subscriptionId: "backend:1", event: engineEvent }, true);
      const reset = yield* PubSub.take(messages);
      assert.equal(reset.message.type, "reset-required");
      if (reset.message.type !== "reset-required") throw new Error("Expected reset");
      assert.equal(reset.message.reason, "delivery-gap");
      owner.sender.emit("destroyed");
      assert.equal(yield* PubSub.take(releases), "backend:1");
    }),
);

it.effect(
  "forwards bounded child queue reads through the product Session and rejects missing Run identity",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const event = fixture.event(1);
      const target = { sessionId: "session", threadId: "child" };
      const page = yield* fixture.handlers.get("agent-runtime:session:queue-read")!(event, {
        ...target,
        cursor: "continuation",
      });
      assert.deepEqual(page, {
        snapshotSequence: 1,
        entries: [],
        nextCursor: null,
        nextRunId: null,
      });
      const preview = yield* fixture.handlers.get("agent-runtime:session:queued-preview")!(event, {
        ...target,
        runId: "queued",
      });
      assert.deepEqual(preview, {
        threadId: "child",
        runId: "queued",
        messageId: "message",
        text: "Preview",
      });
      assert.deepEqual(fixture.calls, [
        { ...target, cursor: "continuation" },
        { ...target, runId: "queued" },
      ]);
      const malformed = yield* fixture.handlers.get("agent-runtime:session:queued-preview")!(
        event,
        target,
      ).pipe(Effect.result);
      assert.equal(malformed._tag, "Failure");
      assert.equal(fixture.calls.length, 2);
    }),
);

it.effect(
  "carries a Session-origin question's null Run through the trusted response boundary",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const respond = fixture.handlers.get("agent-runtime:session:respond")!;
      const input = {
        sessionId: "session",
        threadId: "child",
        requestId: "question",
        runId: null,
        answers: { question: ["Yes"] },
      };
      yield* respond(fixture.event(1), input);
      assert.deepEqual(fixture.calls, [input]);
      assert.equal(
        (yield* respond(fixture.event(1), { ...input, runId: " " }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.calls.length, 1);
    }).pipe(Effect.scoped),
);
