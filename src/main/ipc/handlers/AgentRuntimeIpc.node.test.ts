import { describe } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentRuntimeSessionEvent } from "../../../shared/agent-runtime-api";
import type {
  AgentEvent,
  AgentRuntimeNotification,
  AgentAcpFailure,
} from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "../../agent-runtime/AgentRuntimeSupervisor";
import * as SessionActivity from "../../agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSessionActivity } from "../../agent-runtime/AgentRuntimeSessionActivity";
import { testLayer } from "../../app/MainConfig";
import { layer as callbacks, ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AgentRuntimeIpc";
import { AcpAgents } from "../../acp-agents/AcpAgents";
import { live as acpIpc } from "./AcpAgentsIpc";
import { live as accountIpc } from "./AgentAccountsIpc";
import { AgentAccounts } from "../../agent-accounts/AgentAccounts";
import { isSpaceIpcChannel } from "../../../shared/space-ipc-policy";
import { AgentRuntimeProcessError } from "../../platform/node/AgentRuntimeProcess";

describe("AgentRuntimeIpc", () => {
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
    const received = yield* PubSub.unbounded<{
      sender: number;
      message: AgentRuntimeSessionEvent;
    }>();
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
      liveness: Stream.make("ready" as const),
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
      catalogInvalidations: Stream.never,
      deleteSideChat: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input);
          return { deleted: true };
        }),
      rewriteMessage: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input);
          return { sequence: 17 };
        }),
      stopBackground: (input: { taskIds: readonly string[] }) =>
        Effect.sync(() => {
          calls.push(input);
          return { stopping: input.taskIds };
        }),
      backgroundOutput: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input);
          return { text: "Output", truncated: false, totalBytes: 6 };
        }),
      cancelTask: (input: { taskId: string }) =>
        Effect.sync(() => {
          calls.push(input);
          return { taskId: input.taskId, status: "cancelled" };
        }),
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
            Layer.succeed(AgentRuntimeSupervisor, {
              get: () => Effect.succeed(connection),
              restart: (generation: string) =>
                Effect.sync(() => {
                  calls.push(`restart:${generation}`);
                }),
            } as never),
            Layer.succeed(AgentRuntimeSessionActivity, SessionActivity.inactive),
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
            Layer.succeed(WindowRuntime, {
              has: (id: number) => id === 1 || id === 2,
              all: () => [],
            } as never),
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

  it.effect("deletes a side chat only through a trusted, validated Runtime command", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const handler = fixture.handlers.get("agent-runtime:session:delete-side-chat")!;
      const input = { sessionId: "side", requestId: "delete" };
      const trusted = fixture.event(1);
      assert.deepEqual(yield* handler(trusted, input), { deleted: true });
      const foreign = {
        ...trusted,
        senderFrame: { url: "https://example.com" },
      } as unknown as IpcMainInvokeEvent;
      yield* handler(foreign, input).pipe(Effect.flip);
      for (const malformed of [
        { ...input, sessionId: "" },
        { ...input, requestId: " " },
        { sessionId: "side" },
        { ...input, threadId: "ordinary" },
      ])
        yield* handler(trusted, malformed).pipe(Effect.flip);
      assert.deepEqual(fixture.calls, [input]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "admits background and delegated task operations through strict trusted boundaries",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup;
        const target = { sessionId: "session", threadId: "child" };
        const stop = { ...target, requestId: "stop:all", taskIds: ["background", "another"] };
        const stopOne = { ...stop, taskIds: ["background"] };
        const output = { ...target, taskId: "background" };
        const cancel = { ...target, requestId: "cancel:one", taskId: "delegate" };
        const event = fixture.event(1);
        assert.deepEqual(
          yield* fixture.handlers.get("agent-runtime:session:stop-background")!(event, stop),
          { stopping: ["background", "another"] },
        );
        assert.deepEqual(
          yield* fixture.handlers.get("agent-runtime:session:stop-background")!(event, stopOne),
          { stopping: ["background"] },
        );
        assert.deepEqual(
          yield* fixture.handlers.get("agent-runtime:session:background-output")!(event, output),
          { text: "Output", truncated: false, totalBytes: 6 },
        );
        assert.deepEqual(
          yield* fixture.handlers.get("agent-runtime:session:cancel-task")!(event, cancel),
          { taskId: "delegate", status: "cancelled" },
        );
        const stopHandler = fixture.handlers.get("agent-runtime:session:stop-background")!;
        for (const taskIds of [
          undefined,
          [],
          ["same", "same"],
          [" task"],
          ["a".repeat(513)],
          Array.from({ length: 26 }, (_, i) => `task:${i}`),
        ])
          yield* stopHandler(event, { ...stop, taskIds }).pipe(Effect.flip);
        yield* stopHandler(event, { ...target, requestId: "legacy", taskId: "background" }).pipe(
          Effect.flip,
        );
        const foreign = {
          ...event,
          senderFrame: { url: "https://example.com" },
        } as IpcMainInvokeEvent;
        for (const [channel, input] of [
          ["agent-runtime:session:stop-background", stopOne],
          ["agent-runtime:session:background-output", output],
          ["agent-runtime:session:cancel-task", cancel],
        ] as const) {
          const handler = fixture.handlers.get(channel)!;
          yield* handler(foreign, input).pipe(Effect.flip);
          for (const malformed of [
            { ...input, sessionId: "" },
            { ...input, threadId: " child" },
            { ...input, taskId: "" },
            { ...input, taskId: "a".repeat(513) },
            // Stops and cancels name their Run; output reads take no Run at all.
            channel === "agent-runtime:session:background-output"
              ? { ...input, runId: "unrelated" }
              : { ...input, runId: " run" },
          ])
            yield* handler(event, malformed).pipe(Effect.flip);
          if (channel === "agent-runtime:session:background-output") {
            yield* handler(event, target).pipe(Effect.flip);
            continue;
          }
          yield* handler(event, { ...input, requestId: " " }).pipe(Effect.flip);
          yield* handler(event, { ...target, taskId: "task" }).pipe(Effect.flip);
          if (channel === "agent-runtime:session:cancel-task")
            yield* handler(event, stop).pipe(Effect.flip);
        }
        const maximum = { ...stop, taskIds: Array.from({ length: 25 }, (_, i) => `task:${i}`) };
        assert.deepEqual(yield* stopHandler(event, maximum), { stopping: maximum.taskIds });
        assert.deepEqual(fixture.calls, [stop, stopOne, output, cancel, maximum]);
      }).pipe(Effect.scoped),
  );

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
        yield* fixture.send(
          { type: "event", subscriptionId: "backend:1", event: engineEvent },
          true,
        );
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
        const preview = yield* fixture.handlers.get("agent-runtime:session:queued-preview")!(
          event,
          {
            ...target,
            runId: "queued",
          },
        );
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

  it.effect("authorizes and validates a restart before delegating to the Supervisor", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const restart = f.handlers.get("agent-runtime:restart")!;
      const input = { generation: "one" };
      assert.isTrue(Exit.isFailure(yield* restart(f.event(99), input).pipe(Effect.exit)));
      assert.isTrue(Exit.isFailure(yield* restart(f.event(1), undefined).pipe(Effect.exit)));
      assert.deepEqual(f.calls, []);
      yield* restart(f.event(1), input);
      assert.deepEqual(f.calls, ["restart:one"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rewrite admission validates all image inputs before reaching the application", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const input = {
        sessionId: "session",
        threadId: "thread",
        requestId: "edit",
        runId: "old-run",
        message: { messageId: "replacement", text: "", images: [{ source: "/new.png" }] },
      };
      const handler = f.handlers.get("agent-runtime:session:rewrite-message")!;
      const event = f.event(1);
      const result = yield* handler(event, input);
      assert.deepEqual(result, { sequence: 17 });
      assert.deepEqual(f.calls, [input]);
      const rejected = yield* handler(event, {
        ...input,
        message: {
          ...input.message,
          images: Array.from({ length: 21 }, () => ({ source: "/new.png" })),
        },
      }).pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");
      assert.deepEqual(f.calls, [input]);
    }),
  );
});

describe("AgentAccountsIpc", () => {
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
        const backend = { driver: "antigravity", instanceId: "personal" };
        yield* start(event, { backend });
        yield* start(event, { backend: { driver: "acpRegistry", instanceId: "work" } });
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
        yield* start(
          { sender: secondSender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
          {
            backend,
          },
        );
        assert.notEqual(calls[0]?.ownerId, calls[2]?.ownerId);
        assert.deepEqual(broadcasts, ["agent-settings-changed"]);
        sender.emit("destroyed");
        assert.equal(yield* PubSub.take(released), calls[0]?.ownerId);
        secondSender.emit("render-process-gone");
        assert.equal(yield* PubSub.take(released), calls[2]?.ownerId);
        assert.equal(secondSender.listenerCount("render-process-gone"), 0);
      }),
  );
});
