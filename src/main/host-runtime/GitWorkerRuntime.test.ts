import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import { EventEmitter } from "node:events";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import {
  GIT_WORKER_PROTOCOL_VERSION,
  type GitWorkerMessageForView,
  type GitWorkerMessageFromHost,
} from "../../shared/git-worker-protocol";
import {
  GitWorkerRuntime,
  live,
  type GitWorkerProcess,
  type GitWorkerRendererTarget,
  type GitWorkerRuntimeOptions,
} from "./GitWorkerRuntime";

class FakeProcess implements GitWorkerProcess {
  readonly sent: GitWorkerMessageFromHost[] = [];
  readonly events = new EventEmitter();
  terminated = false;

  send(message: GitWorkerMessageFromHost): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.on("error", listener);
    return () => this.events.off("error", listener);
  }

  onExit(listener: (code: number) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    this.events.emit("exit", 1);
    return 1;
  }
}

class FakeRenderer extends EventEmitter implements GitWorkerRendererTarget {
  readonly messages: GitWorkerMessageForView[] = [];
  destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(_channel: string, message: GitWorkerMessageForView): void {
    this.messages.push(message);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

const request = (id: string, nonce = id) => ({
  type: "worker-request" as const,
  workerId: "git" as const,
  request: {
    id,
    method: "probe" as const,
    params: { nonce },
    enqueuedAtMs: 1,
  },
});

const response = (id: string, nonce = id) => ({
  type: "worker-response" as const,
  workerId: "git" as const,
  id,
  method: "probe" as const,
  result: {
    type: "ok" as const,
    value: { nonce, protocolVersion: GIT_WORKER_PROTOCOL_VERSION },
  },
});

const liveSubscriptionRequest = (id: string, subscriptionId: string) => ({
  type: "worker-request" as const,
  workerId: "git" as const,
  request: {
    id,
    method: "subscribe-live-query" as const,
    params: {
      subscriptionId,
      query: { method: "base-branch" as const, params: { cwd: "/repo" } },
    },
    enqueuedAtMs: 1,
  },
});

const performanceOperation = (outcome: "stale" | "canceled" | "timed-out") => ({
  type: "git-performance-operation" as const,
  workerId: "git" as const,
  metric: {
    operation: "review-summary",
    trigger: "live" as const,
    outcome,
    durationMs: 10,
    firstResultMs: 10,
    queueDurationMs: 1,
    commandCount: 1,
    peakConcurrency: 1,
    statusCommandCount: 1,
    fullUntrackedScanCount: 0,
    unscopedAllStatusCount: 0,
    cacheHits: 0,
    cacheMisses: 1,
    coalescedQueries: 0,
    timedOut: outcome === "timed-out",
    canceled: outcome === "canceled",
    outputLimitExceeded: false,
    repoIndexSizeBucket: "unknown" as const,
  },
});

const acquire = (options: Omit<GitWorkerRuntimeOptions, "workerPath">) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Layer.unwrap(
        Effect.gen(function* () {
          const rendererLifecycle = yield* WebContentsDestructionSubscriptions;
          return live({ workerPath: "/test/git-worker.js", rendererLifecycle, ...options });
        }),
      ).pipe(Layer.provide(WebContentsDestructionSubscriptions.live)),
      scope,
    );
    return { runtime: Context.get(context, GitWorkerRuntime), scope };
  });

it.effect("serves host requests without a renderer lifecycle and refuses renderer access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = new FakeProcess();
      const context = yield* Layer.build(
        live({
          workerPath: "/test/git-worker.js",
          createProcess: () => process,
        }),
      );
      const runtime = Context.get(context, GitWorkerRuntime);
      const refused = yield* Effect.flip(
        runtime.handleRendererMessage(new FakeRenderer(1), request("renderer")),
      );
      assert.equal(refused.code, "protocol-error");
      assert.lengthOf(process.sent, 0);
      const pending = yield* Effect.forkChild(
        runtime.request({ method: "probe", params: { nonce: "host" } }),
      );
      yield* Effect.yieldNow;
      const sent = process.sent[0];
      if (sent?.type !== "worker-request") return yield* Effect.die("Missing host request");
      process.events.emit("message", response(sent.request.id, "host"));
      assert.deepEqual(yield* Fiber.join(pending), {
        nonce: "host",
        protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
      });
      process.events.emit("exit", 0);
      yield* Effect.yieldNow;
    }),
  ),
);

it.effect("resolves Main requests in their worker generation", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const { runtime, scope } = yield* acquire({ createProcess: () => process });
    const pending = yield* Effect.forkChild(
      runtime.request({ method: "probe", params: { nonce: "main" } }),
    );
    yield* Effect.yieldNow;
    const sent = process.sent[0];
    assert.strictEqual(sent?.type, "worker-request");
    if (sent?.type !== "worker-request") return yield* Effect.die("Missing request");
    process.events.emit("message", response(sent.request.id, "main"));
    yield* Effect.yieldNow;
    assert.deepEqual(yield* Fiber.join(pending), {
      nonce: "main",
      protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
    });
    process.events.emit("exit", 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("maps external cancellation to the matching worker request", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const { runtime, scope } = yield* acquire({ createProcess: () => process });
    const controller = new AbortController();
    const pending = yield* Effect.forkChild(
      runtime.request({ method: "probe", params: { nonce: "main" }, signal: controller.signal }),
    );
    yield* Effect.yieldNow;
    const sent = process.sent[0];
    if (sent?.type !== "worker-request") return yield* Effect.die("Missing request");
    controller.abort();
    const result = yield* Effect.result(Fiber.join(pending));
    assert.isTrue(Result.isFailure(result));
    assert.deepEqual(process.sent.at(-1), {
      type: "worker-request-cancel",
      workerId: "git",
      id: sent.request.id,
    });
    process.events.emit("exit", 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("routes renderer responses and live publications only to their owners", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const { runtime, scope } = yield* acquire({ createProcess: () => process });
    const first = new FakeRenderer(1);
    const second = new FakeRenderer(2);
    yield* runtime.handleRendererMessage(first, liveSubscriptionRequest("subscribe-1", "sub-1"));
    yield* runtime.handleRendererMessage(second, request("second"));
    process.events.emit("message", response("second"));
    process.events.emit("message", {
      type: "worker-response",
      workerId: "git",
      id: "subscribe-1",
      method: "subscribe-live-query",
      result: { type: "ok", value: { subscribed: true } },
    });
    const publication = {
      type: "git-live-query-event" as const,
      workerId: "git" as const,
      event: {
        type: "git-live-query-updated" as const,
        subscriptionId: "sub-1",
        generation: 1,
        requiresRecovery: false,
        phase: "complete" as const,
        method: "base-branch" as const,
        result: {
          cwd: "/repo",
          local: "main",
          remote: "origin/main",
          errorMessage: null,
        },
      },
    };
    process.events.emit("message", publication);
    yield* Effect.yieldNow;
    assert.deepEqual(second.messages, [response("second")]);
    assert.isTrue(first.messages.some((message) => message.type === "git-live-query-event"));
    assert.isFalse(second.messages.some((message) => message.type === "git-live-query-event"));

    first.destroy();
    yield* Effect.yieldNow;
    const cleanup = process.sent.at(-1);
    assert.strictEqual(cleanup?.type, "worker-request");
    if (cleanup?.type === "worker-request") {
      assert.strictEqual(cleanup.request.method, "unsubscribe-live-query");
      if (cleanup.request.method === "unsubscribe-live-query") {
        assert.strictEqual(cleanup.request.params.subscriptionId, "sub-1");
      }
    }
    process.events.emit("exit", 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("cancels renderer work when its owner is destroyed", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const { runtime, scope } = yield* acquire({ createProcess: () => process });
    const renderer = new FakeRenderer(1);
    yield* runtime.handleRendererMessage(renderer, request("request-1"));
    renderer.destroy();
    yield* Effect.yieldNow;
    assert.deepEqual(process.sent.at(-1), {
      type: "worker-request-cancel",
      workerId: "git",
      id: "request-1",
    });
    process.events.emit("message", response("request-1"));
    yield* Effect.yieldNow;
    assert.deepEqual(renderer.messages, []);
    process.events.emit("exit", 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fails one generation and lazily starts the next after a crash", () =>
  Effect.gen(function* () {
    const processes: FakeProcess[] = [];
    const infrastructureErrors: string[] = [];
    const { runtime, scope } = yield* acquire({
      createProcess: () => {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      },
      onInfrastructureError: (error) => infrastructureErrors.push(error.message),
    });
    const renderer = new FakeRenderer(1);
    yield* runtime.handleRendererMessage(renderer, request("request-1"));
    processes[0]?.events.emit("error", new Error("boom"));
    yield* Effect.yieldNow;
    const failed = renderer.messages.at(-1);
    assert.strictEqual(failed?.type, "worker-response");
    if (failed?.type === "worker-response") {
      assert.strictEqual(failed.id, "request-1");
      assert.strictEqual(failed.result.type, "error");
      if (failed.result.type === "error") {
        assert.strictEqual(failed.result.error.code, "worker-unavailable");
      }
    }
    assert.strictEqual(infrastructureErrors.length, 1);

    yield* runtime.handleRendererMessage(renderer, request("request-2"));
    assert.strictEqual(processes.length, 2);
    processes[1]?.events.emit("message", {
      type: "worker-ready",
      workerId: "git",
      epoch: 2,
      protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
    });
    yield* Effect.yieldNow;
    assert.deepEqual(renderer.messages.at(-1), {
      type: "worker-restarted",
      workerId: "git",
      epoch: 2,
    });
    processes[1]?.events.emit("exit", 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps expected performance outcomes outside infrastructure failure", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const infrastructureErrors: Error[] = [];
    const performance: string[] = [];
    const { runtime, scope } = yield* acquire({
      createProcess: () => process,
      onInfrastructureError: (error) => infrastructureErrors.push(error),
      onPerformanceOperation: (metric) => performance.push(metric.outcome),
    });
    yield* runtime.handleRendererMessage(new FakeRenderer(1), request("start"));
    process.events.emit("message", performanceOperation("stale"));
    process.events.emit("message", performanceOperation("canceled"));
    process.events.emit("message", performanceOperation("timed-out"));
    yield* Effect.yieldNow;
    assert.deepEqual(performance, ["stale", "canceled", "timed-out"]);
    assert.deepEqual(infrastructureErrors, []);
    assert.isFalse(process.terminated);
    process.events.emit("exit", 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("treats malformed diagnostics as a protocol-generation failure", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const infrastructureErrors: Array<{ error: Error; phase: string }> = [];
    const performance: string[] = [];
    const { runtime, scope } = yield* acquire({
      createProcess: () => process,
      onInfrastructureError: (error, context) =>
        infrastructureErrors.push({ error, phase: context.phase }),
      onPerformanceOperation: (metric) => performance.push(metric.outcome),
    });
    yield* runtime.handleRendererMessage(new FakeRenderer(1), request("start"));
    process.events.emit("message", {
      ...performanceOperation("stale"),
      metric: { ...performanceOperation("stale").metric, durationMs: -1 },
    });
    yield* Effect.yieldNow;
    assert.deepEqual(performance, []);
    assert.strictEqual(infrastructureErrors.length, 1);
    assert.strictEqual(infrastructureErrors[0]?.phase, "protocol");
    assert.isTrue(process.terminated);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("performs cooperative shutdown before forced termination", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const { runtime, scope } = yield* acquire({
      createProcess: () => process,
      shutdownTimeoutMs: 100,
    });
    yield* runtime.handleRendererMessage(new FakeRenderer(1), request("request-1"));
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
    yield* Effect.yieldNow;
    assert.deepEqual(process.sent.at(-1), { type: "worker-shutdown", workerId: "git" });
    process.events.emit("exit", 0);
    yield* Fiber.join(closing);
    assert.isFalse(process.terminated);
  }),
);

it.effect("forces a worker that exceeds the scoped shutdown deadline", () =>
  Effect.gen(function* () {
    const process = new FakeProcess();
    const { runtime, scope } = yield* acquire({
      createProcess: () => process,
      shutdownTimeoutMs: 100,
    });
    yield* runtime.handleRendererMessage(new FakeRenderer(1), request("request-1"));
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
    yield* Effect.yieldNow;
    assert.deepEqual(process.sent.at(-1), { type: "worker-shutdown", workerId: "git" });
    assert.isFalse(process.terminated);
    yield* TestClock.adjust(100);
    yield* Fiber.join(closing);
    assert.isTrue(process.terminated);
  }),
);
