import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  CODEX_HOST_CHUNKED_MESSAGE_MARKER,
  CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES,
  type CodexHostMessagePart,
} from "../../shared/codex-host-chunked-message";
import type { CodexRendererClientRequestMessage } from "../../shared/types";
import { RENDERER_CLIENT_REQUEST_CHANNEL } from "../codex/renderer-client-runtime-contracts";
import { live, RendererClientRuntime } from "./RendererClientRuntime";

class FakeWebContents extends EventEmitter {
  readonly sent: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];
  destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: readonly unknown[]): void {
    if (this.destroyed) throw new Error("webContents destroyed");
    this.sent.push({ channel, args });
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

const idFactory = (prefix: string): (() => string) => {
  let next = 0;
  return () => `${prefix}:${++next}`;
};

const makeRuntime = Effect.fn("RendererClientRuntimeTest.makeRuntime")(function* () {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    live({
      clientIdFactory: idFactory("client"),
      requestIdFactory: idFactory("request"),
      logger: { debug: () => undefined, warn: () => undefined },
    }),
    scope,
  );
  return { runtime: Context.get(context, RendererClientRuntime), scope };
});

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Condition did not settle: ${label}`));
  });

const rendererChunkedPart = (
  target: FakeWebContents,
  index: number,
  expectedChannel = "codex:host-message",
): CodexHostMessagePart => {
  const delivery = target.sent[index];
  if (!delivery) throw new Error(`Renderer delivery ${index} was not sent`);
  assert.strictEqual(delivery.channel, expectedChannel);
  const part = delivery.args[0] as CodexHostMessagePart;
  assert.strictEqual(part.marker, CODEX_HOST_CHUNKED_MESSAGE_MARKER);
  return part;
};

const rendererRequest = (target: FakeWebContents, index = 0): CodexRendererClientRequestMessage => {
  const delivery = target.sent[index];
  if (!delivery) throw new Error("Renderer request was not delivered");
  assert.strictEqual(delivery.channel, RENDERER_CLIENT_REQUEST_CHANNEL);
  return delivery.args[0] as CodexRendererClientRequestMessage;
};

it.effect("owns stable renderer registrations and targeted delivery", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const first = new FakeWebContents(10);
    const second = new FakeWebContents(11);
    const firstRegistration = runtime.register(first);
    assert.strictEqual(runtime.ensureClient(first).clientId, firstRegistration.clientId);
    const secondRegistration = runtime.register(second);

    assert.deepEqual(
      runtime.sendToClients(
        [firstRegistration.clientId, secondRegistration.clientId, "client:missing"],
        "codex:test",
        { value: 1 },
      ),
      {
        sentClientIds: ["client:1", "client:2"],
        unavailableClientIds: ["client:missing"],
        failedClientIds: [],
      },
    );
    assert.strictEqual(runtime.getClientCount(), 2);
    assert.strictEqual(runtime.getClientIdForWebContentsId(10), "client:1");
    assert.strictEqual(runtime.getWebContentsIdForClientId("client:2"), 11);
    assert.strictEqual(
      runtime.broadcast("codex:broadcast", null, {
        sourceClientId: firstRegistration.clientId,
        includeSource: false,
      }),
      1,
    );
    assert.deepEqual(runtime.sendToClients([], "codex:none", null), {
      sentClientIds: [],
      unavailableClientIds: [],
      failedClientIds: [],
    });
    yield* firstRegistration.release;
    assert.strictEqual(runtime.getClientCount(), 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("chunks large routed messages, waits for exact ACKs, and preserves target FIFO", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const target = new FakeWebContents(12);
    const targetId = runtime.register(target).clientId;
    const largeValue = "x".repeat(CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES + 1);

    assert.isTrue(runtime.sendToClient(targetId, "codex:host-message", { largeValue }));
    assert.isTrue(runtime.sendToClient(targetId, "codex:event", { type: "queued-after-large" }));
    yield* waitUntil("transfer start", () => target.sent.length === 1);

    let index = 0;
    while (true) {
      const part = rendererChunkedPart(target, index);
      yield* runtime.handleDeliveryAcknowledgment(target, part.transferId, part.sequence + 1);
      assert.strictEqual(target.sent.length, index + 1);
      yield* runtime.handleDeliveryAcknowledgment(target, part.transferId, part.sequence);
      index += 1;
      if (part.kind === "end") break;
      yield* waitUntil(`transfer frame ${index}`, () => target.sent.length === index + 1);
    }

    yield* waitUntil("queued inline delivery", () => target.sent.length === index + 1);
    assert.strictEqual(target.sent[index]?.channel, "codex:event");
    assert.deepEqual(target.sent[index]?.args, [{ type: "queued-after-large" }]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("releases active and queued delivery when its target is destroyed", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const target = new FakeWebContents(13);
    const targetId = runtime.register(target).clientId;
    const largeValue = "x".repeat(CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES + 1);

    assert.isTrue(runtime.sendToClient(targetId, "codex:host-message", { largeValue }));
    assert.isTrue(runtime.sendToClient(targetId, "codex:event", { type: "must-not-send" }));
    yield* waitUntil("active transfer start", () => target.sent.length === 1);
    target.destroy();
    yield* waitUntil("client disposal", () => runtime.getClientCount() === 0);
    for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;

    assert.strictEqual(target.sent.length, 1);
    assert.isFalse(runtime.sendToClient(targetId, "codex:event", null));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps renderer ownership stable when an immediate send is rejected", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        clientIdFactory: () => "client:failed-delivery",
        requestIdFactory: () => "request:failed-delivery",
        logger: { debug: () => undefined, warn: () => undefined },
        send: () => false,
      }),
      scope,
    );
    const runtime = Context.get(context, RendererClientRuntime);
    const target = new FakeWebContents(14);
    const targetId = runtime.register(target).clientId;

    assert.isFalse(runtime.sendToClient(targetId, "codex:host-message", { revision: 7 }));
    assert.strictEqual(runtime.getClientCount(), 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("projects connected and disposed lifecycle events in admission order", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const lifecycle = yield* Effect.forkChild(
      runtime.events.pipe(Stream.take(2), Stream.runCollect),
    );
    yield* Effect.yieldNow;
    const registration = runtime.register(new FakeWebContents(15));
    yield* Effect.yieldNow;
    yield* registration.release;
    const events = [...(yield* Fiber.join(lifecycle))];
    assert.deepEqual(
      events.map((event) => event.kind),
      ["connected", "disposed"],
    );
    assert.strictEqual(events[0]?.clientId, registration.clientId);
    assert.strictEqual(events[1]?.clientId, registration.clientId);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("completes a request exactly once from its target renderer", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const target = new FakeWebContents(20);
    const other = new FakeWebContents(21);
    const targetId = runtime.register(target).clientId;
    runtime.register(other);
    const response = yield* Effect.forkChild(
      runtime.request<string>(targetId, "snapshot", { threadId: "thread-1" }),
    );
    yield* Effect.yieldNow;
    const request = rendererRequest(target);

    assert.isFalse(
      yield* runtime.handleResponse(other, {
        type: "success",
        requestId: request.requestId,
        result: "wrong",
      }),
    );
    assert.strictEqual(runtime.getPendingRequestCount(), 1);
    assert.isTrue(
      yield* runtime.handleResponse(target, {
        type: "success",
        requestId: request.requestId,
        result: "right",
      }),
    );
    assert.strictEqual(yield* Fiber.join(response), "right");
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    assert.isFalse(
      yield* runtime.handleResponse(target, {
        type: "success",
        requestId: request.requestId,
        result: "late",
      }),
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("maps renderer response failures into typed request failures", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const target = new FakeWebContents(25);
    const targetId = runtime.register(target).clientId;

    const failed = yield* Effect.forkChild(
      runtime.request(targetId, "snapshot", {}).pipe(Effect.asVoid, Effect.flip),
    );
    yield* Effect.yieldNow;
    const failedRequest = rendererRequest(target);
    yield* runtime.handleResponse(target, {
      type: "error",
      requestId: failedRequest.requestId,
      error: "renderer rejected",
    });
    const failedError = yield* Fiber.join(failed);
    assert.strictEqual(failedError.reason, "request-failed");
    assert.strictEqual(failedError.message, "renderer rejected");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not retain a pending request when synchronous delivery fails", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        clientIdFactory: () => "client:failed-send",
        requestIdFactory: () => "request:failed-send",
        send: () => false,
      }),
      scope,
    );
    const runtime = Context.get(context, RendererClientRuntime);
    const targetId = runtime.register(new FakeWebContents(26)).clientId;
    const error = yield* runtime.request(targetId, "snapshot", {}).pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(error.reason, "unavailable");
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects renderer RPC pressure before sending or retaining another request", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        clientIdFactory: idFactory("pressure-client"),
        requestIdFactory: idFactory("pressure-request"),
        maxPendingRequests: 2,
        maxPendingRequestsPerTarget: 1,
        logger: { debug: () => undefined, warn: () => undefined },
      }),
      scope,
    );
    const runtime = Context.get(context, RendererClientRuntime);
    const firstTarget = new FakeWebContents(27);
    const secondTarget = new FakeWebContents(28);
    const thirdTarget = new FakeWebContents(29);
    const firstId = runtime.register(firstTarget).clientId;
    const secondId = runtime.register(secondTarget).clientId;
    const thirdId = runtime.register(thirdTarget).clientId;

    const first = yield* Effect.forkChild(runtime.request(firstId, "first", {}));
    yield* Effect.yieldNow;
    const sameTargetPressure = yield* runtime
      .request(firstId, "same-target-overflow", {})
      .pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(sameTargetPressure.reason, "pressure");
    assert.strictEqual(firstTarget.sent.length, 1);

    const second = yield* Effect.forkChild(runtime.request(secondId, "second", {}));
    yield* Effect.yieldNow;
    const globalPressure = yield* runtime
      .request(thirdId, "global-overflow", {})
      .pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(globalPressure.reason, "pressure");
    assert.strictEqual(thirdTarget.sent.length, 0);
    assert.strictEqual(runtime.getPendingRequestCount(), 2);

    const firstRequest = rendererRequest(firstTarget);
    const secondRequest = rendererRequest(secondTarget);
    yield* runtime.handleResponse(firstTarget, {
      type: "success",
      requestId: firstRequest.requestId,
      result: "first-result",
    });
    yield* runtime.handleResponse(secondTarget, {
      type: "success",
      requestId: secondRequest.requestId,
      result: "second-result",
    });
    assert.strictEqual(yield* Fiber.join(first), "first-result");
    assert.strictEqual(yield* Fiber.join(second), "second-result");
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("uses the Effect clock for the only renderer request deadline", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const target = new FakeWebContents(30);
    const targetId = runtime.register(target).clientId;
    const outcome = yield* Effect.forkChild(
      runtime.request(targetId, "snapshot", {}, { timeoutMs: 25 }).pipe(Effect.asVoid, Effect.flip),
    );
    yield* Effect.yieldNow;
    assert.strictEqual(runtime.getPendingRequestCount(), 1);
    yield* TestClock.adjust("24 millis");
    assert.strictEqual(runtime.getPendingRequestCount(), 1);
    yield* TestClock.adjust("1 millis");
    const error = yield* Fiber.join(outcome);
    assert.strictEqual(error.reason, "timeout");
    assert.match(error.message, /timed out after 25ms/);
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fails pending requests and publishes disposal when a renderer is destroyed", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeRuntime();
    const target = new FakeWebContents(40);
    const targetId = runtime.register(target).clientId;
    const disposed = yield* Effect.forkChild(
      runtime.events.pipe(
        Stream.filter((event) => event.kind === "disposed"),
        Stream.runHead,
      ),
    );
    const outcome = yield* Effect.forkChild(
      runtime.request(targetId, "snapshot", {}).pipe(Effect.asVoid, Effect.flip),
    );
    yield* Effect.yieldNow;
    target.destroy();
    const error = yield* Fiber.join(outcome);
    assert.match(error.message, /was destroyed/);
    const event = yield* Fiber.join(disposed);
    assert.strictEqual(event._tag, "Some");
    if (event._tag === "Some") assert.strictEqual(event.value.clientId, targetId);
    assert.strictEqual(runtime.getClientCount(), 0);
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("closes registrations, listeners, and pending requests with the Main Scope", () =>
  Effect.gen(function* () {
    let destroyedListener: (() => void) | null = null;
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        clientIdFactory: () => "client:scope",
        requestIdFactory: () => "request:scope",
        send: () => true,
      }),
      scope,
    );
    const runtime = Context.get(context, RendererClientRuntime);
    const registration = runtime.register({
      id: 50,
      isDestroyed: () => false,
      once: (_event, listener) => {
        destroyedListener = listener;
      },
      off: () => {
        destroyedListener = null;
      },
      send: () => undefined,
    });
    const outcome = yield* Effect.forkChild(
      runtime.request(registration.clientId, "snapshot", {}).pipe(Effect.asVoid, Effect.flip),
    );
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    const error = yield* Fiber.join(outcome);
    assert.strictEqual(error.reason, "closing");
    assert.strictEqual(runtime.getClientCount(), 0);
    assert.strictEqual(runtime.getPendingRequestCount(), 0);
    assert.isNull(destroyedListener);
  }),
);
