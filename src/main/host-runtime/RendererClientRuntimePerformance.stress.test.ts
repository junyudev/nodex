import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CodexRendererClientRequestMessage } from "../../shared/types";
import {
  DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS,
  DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
  RENDERER_CLIENT_REQUEST_CHANNEL,
  type RendererClientRuntimeError,
} from "../codex/renderer-client-runtime-contracts";
import { live, RendererClientRuntime } from "./RendererClientRuntime";

class SlowRendererWebContents extends EventEmitter {
  readonly sent: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return false;
  }

  send(channel: string, ...args: readonly unknown[]): void {
    this.sent.push({ channel, args });
  }
}

const idFactory = (prefix: string): (() => string) => {
  let next = 0;
  return () => `${prefix}:${++next}`;
};

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Renderer client condition did not settle: ${label}`));
  });

const rendererRequest = (
  target: SlowRendererWebContents,
  index: number,
): CodexRendererClientRequestMessage => {
  const delivery = target.sent[index];
  if (!delivery) throw new Error(`Renderer request ${index} was not delivered`);
  assert.strictEqual(delivery.channel, RENDERER_CLIENT_REQUEST_CHANNEL);
  return delivery.args[0] as CodexRendererClientRequestMessage;
};

it.effect("bounds slow renderer requests per target and across Main", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        clientIdFactory: idFactory("pressure-client"),
        requestIdFactory: idFactory("pressure-request"),
        logger: { debug: () => undefined, warn: () => undefined },
      }),
      scope,
    );
    const runtime = Context.get(context, RendererClientRuntime);
    const targets = Array.from(
      { length: 5 },
      (_, index) => new SlowRendererWebContents(10_000 + index),
    );
    const targetIds = targets.map((target) => runtime.register(target).clientId);
    const requestFibers: Array<Fiber.Fiber<unknown, RendererClientRuntimeError>> = [];
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();

    const fillTarget = (targetIndex: number) =>
      Effect.gen(function* () {
        const targetId = targetIds[targetIndex];
        if (!targetId) return yield* Effect.die(new Error(`Missing target ${targetIndex}`));
        const base = requestFibers.length;
        for (
          let index = 0;
          index < DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET;
          index += 1
        ) {
          requestFibers.push(
            yield* Effect.forkChild(
              runtime.request(targetId, `slow-request:${targetIndex}:${index}`, {
                targetIndex,
                index,
              }),
            ),
          );
        }
        yield* waitUntil(
          `target ${targetIndex} admission`,
          () =>
            runtime.getPendingRequestCount() ===
            base + DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
        );
      });

    yield* fillTarget(0);
    const firstTargetId = targetIds[0];
    if (!firstTargetId) return yield* Effect.die(new Error("Missing first target"));
    const perTargetOverflow = yield* runtime
      .request(firstTargetId, "same-target-overflow", { shouldNotSend: true })
      .pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(perTargetOverflow.reason, "pressure");
    assert.strictEqual(
      targets[0]?.sent.length,
      DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
    );
    assert.strictEqual(
      runtime.getPendingRequestCount(),
      DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
    );

    yield* fillTarget(1);
    yield* fillTarget(2);
    yield* fillTarget(3);
    assert.strictEqual(
      runtime.getPendingRequestCount(),
      DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS,
    );

    const globalOverflowTargetId = targetIds[4];
    if (!globalOverflowTargetId) {
      return yield* Effect.die(new Error("Missing global overflow target"));
    }
    const globalOverflow = yield* runtime
      .request(globalOverflowTargetId, "global-overflow", { shouldNotSend: true })
      .pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(globalOverflow.reason, "pressure");
    assert.strictEqual(targets[4]?.sent.length, 0);
    assert.strictEqual(
      runtime.getPendingRequestCount(),
      DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS,
    );

    for (const target of targets.slice(0, 4)) {
      for (let index = 0; index < target.sent.length; index += 1) {
        const request = rendererRequest(target, index);
        assert.isTrue(
          yield* runtime.handleResponse(target, {
            type: "success",
            requestId: request.requestId,
            result: request.method,
          }),
        );
      }
    }
    yield* Effect.forEach(requestFibers, (fiber) => Fiber.join(fiber).pipe(Effect.orDie), {
      concurrency: "unbounded",
    });
    assert.strictEqual(runtime.getPendingRequestCount(), 0);

    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
        kind: "renderer-client-request-pressure",
        elapsedMs: elapsed,
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        perTargetAdmitted: DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
        processAdmitted: DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS,
        perTargetOverflowSent: 0,
        processOverflowSent: targets[4]?.sent.length ?? -1,
        pendingAfterResponses: runtime.getPendingRequestCount(),
      })}\n`,
    );
    yield* Scope.close(scope, Exit.void);
  }),
);
