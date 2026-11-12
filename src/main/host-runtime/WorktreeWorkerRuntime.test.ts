import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vite-plus/test";
import type {
  CodexWorktreeWorkerCreateInput,
  CodexWorktreeWorkerPrepareHandoffInput,
} from "../codex/codex-worktree-worker-protocol";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  type CodexWorktreeWorkerHostMessage,
  type CodexWorktreeWorkerThreadMessage,
} from "../worktree-worker/worktree-worker-protocol";
import {
  localLive,
  makeWorktreeWorkerClient,
  WorktreeWorkerRuntime,
  WorktreeWorkerError,
  type WorktreeWorkerProcess,
} from "./WorktreeWorkerRuntime";

let fixtureRoot = "";
let fixturePath = "";

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "nodex-worktree-worker-runtime-test-"));
  fixturePath = path.join(fixtureRoot, "fixture.mjs");
  await writeFile(
    fixturePath,
    `
import { parentPort, workerData } from "node:worker_threads";
const port = parentPort;
if (!port) throw new Error("missing parent port");
port.on("message", (message) => {
  if (message.type === "shutdown") {
    port.close();
    return;
  }
  if (message.type === "cancel") {
    port.postMessage({ type: "result", id: message.id, operation: message.operation,
      result: { type: "error", code: "canceled", message: "Request canceled", retryable: true } });
    return;
  }
  const request = message.request;
  if (request.operation === "prepare-handoff") {
    port.postMessage({ type: "result", id: message.id, operation: "prepare-handoff", result: {
      type: "error", code: "operation-failed", message: "Destination dirty", retryable: true,
      ...(request.input.threadTitle === "unknown" ? {} : { preparationRestored: request.input.threadTitle === "restored" }),
    } });
    return;
  }
  if (request.operation !== "create") throw new Error("unexpected fixture operation");
  if (request.input.threadTitle === "crash") process.exit(23);
  const roots = {
    worktreeGitRoot: "/worktrees/abcd/repo",
    worktreeWorkspaceRoot: "/worktrees/abcd/repo/packages/app",
  };
  port.postMessage({
    type: "event",
    id: message.id,
    operation: "create",
    event: { operation: "create", type: "path-allocated", ...roots },
  });
  if (request.input.threadTitle === "flood") {
    for (let index = 0; index < 20; index += 1) {
      port.postMessage({
        type: "event",
        id: message.id,
        operation: "create",
        event: { operation: "create", type: "setup-started" },
      });
    }
    return;
  }
  if (request.input.threadTitle === "ordered") {
    port.postMessage({
      type: "event",
      id: message.id,
      operation: "create",
      event: { operation: "create", type: "setup-started" },
    });
  }
  if (request.input.threadTitle === "hang") return;
  port.postMessage({
    type: "result",
    id: message.id,
    operation: "create",
    result: {
      type: "ok",
      success: {
        operation: "create",
        value: { ...roots, setupError: null, shellEnvironment: null },
      },
    },
  });
});
port.postMessage({
  type: "ready",
  epoch: workerData.epoch,
  hostId: workerData.hostId,
  protocolVersion: ${CODEX_WORKTREE_WORKER_PROTOCOL_VERSION},
});
`,
    "utf8",
  );
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

const createInput = (threadTitle: string): CodexWorktreeWorkerCreateInput => ({
  requestId: `request:${threadTitle}`,
  hostId: "local",
  repositoryPath: "/repo",
  nodexHome: "/nodex",
  managedRoot: "/nodex/worktrees",
  projectId: "project-1",
  targetId: "pending-1",
  threadTitle,
  startingState: { type: "branch", branchName: "main" },
  localEnvironmentConfigPath: null,
  setUpSyncedBranch: true,
  propagateLocalWorkspaceFiles: true,
});

const prepareInput = (threadTitle: string): CodexWorktreeWorkerPrepareHandoffInput => ({
  requestId: `proof:${threadTitle}`,
  hostId: "local",
  managedRoot: "/managed",
  allocatedWorktreePath: "/managed/deadbeef1234/repo",
  nodexHome: "/nodex",
  projectId: "project",
  threadId: "thread",
  threadTitle,
  sourceCwd: "/repo",
  sourceWorkspaceRoot: "/repo",
  sourceManagedWorktreePath: null,
  destinationCheckoutRoot: null,
});

const acquire = (
  onInfrastructureError?: (error: Error) => void,
  capacity?: { readonly requestInboxCapacity: number },
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const retired = yield* Deferred.make<void>();
    const context = yield* Layer.buildWithScope(
      localLive({
        hostId: "local",
        workerPath: fixturePath,
        onInfrastructureError: (error) => {
          try {
            onInfrastructureError?.(error);
          } finally {
            Deferred.doneUnsafe(retired, Effect.void);
          }
        },
        ...capacity,
      }),
      scope,
    );
    return { runtime: Context.get(context, WorktreeWorkerRuntime), scope, retired };
  });

it.effect(
  "streams events and fences native work whose worker crashes without a terminal result",
  () =>
    Effect.gen(function* () {
      const infrastructureErrors: string[] = [];
      const { runtime, scope, retired } = yield* acquire((error) =>
        infrastructureErrors.push(error.message),
      );
      const events: string[] = [];
      const result = yield* runtime.request(
        { operation: "create", input: createInput("success") },
        { onEvent: (event) => Effect.sync(() => events.push(event.type)) },
      );
      assert.deepEqual(events, ["path-allocated"]);
      assert.strictEqual(result.worktreeWorkspaceRoot, "/worktrees/abcd/repo/packages/app");
      const crashed = yield* Effect.result(
        runtime.request({ operation: "create", input: createInput("crash") }),
      );
      assert.isTrue(Result.isFailure(crashed));
      if (Result.isFailure(crashed))
        assert.strictEqual(crashed.failure.message, "Worktree cleanup was not confirmed");
      yield* Deferred.await(retired);
      assert.strictEqual(infrastructureErrors.length, 1);
      const next = yield* Effect.result(
        runtime.request({ operation: "create", input: createInput("must-not-retry") }),
      );
      assert.isTrue(Result.isFailure(next));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(scope, Exit.void))));
    }),
);

it.effect("preserves explicit preparation proof and keeps unknown failures uncertain", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* acquire();
    for (const title of ["restored", "uncertain", "unknown"]) {
      const result = yield* runtime
        .request({
          operation: "prepare-handoff",
          input: prepareInput(title),
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.strictEqual(
          result.failure.preparationRestored,
          title === "unknown" ? undefined : title === "restored",
        );
    }
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("maps Effect interruption to one worker cancellation without poisoning the session", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* acquire();
    const allocated = yield* Deferred.make<void>();
    const pending = yield* Effect.forkChild(
      runtime.request(
        { operation: "create", input: createInput("hang") },
        {
          onEvent: (event) =>
            event.type === "path-allocated"
              ? Deferred.succeed(allocated, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      ),
    );
    yield* Deferred.await(allocated);
    yield* Fiber.interrupt(pending);

    const result = yield* runtime.request({
      operation: "create",
      input: createInput("success"),
    });
    assert.isNull(result.setupError);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("isolates event-consumer failure and preserves each request's wire order", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* acquire();
    const survivorAllocated = yield* Deferred.make<void>();
    const survivor = yield* Effect.forkChild(
      runtime.request(
        { operation: "create", input: createInput("hang") },
        {
          onEvent: (event) =>
            event.type === "path-allocated"
              ? Deferred.succeed(survivorAllocated, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      ),
    );
    yield* Deferred.await(survivorAllocated);
    const failed = yield* Effect.result(
      runtime.request(
        { operation: "create", input: createInput("event-failure") },
        { onEvent: () => Effect.die(new Error("consumer failed")) },
      ),
    );
    assert.isTrue(Result.isFailure(failed));
    if (Result.isFailure(failed)) {
      assert.strictEqual(failed.failure.operation, "event-consumer");
    }
    assert.isUndefined(survivor.pollUnsafe());
    yield* Fiber.interrupt(survivor);

    const firstEvent = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const order: string[] = [];
    const ordered = yield* Effect.forkChild(
      runtime.request(
        { operation: "create", input: createInput("ordered") },
        {
          onEvent: (event) =>
            event.type === "path-allocated"
              ? Effect.sync(() => order.push("path-start")).pipe(
                  Effect.andThen(Deferred.succeed(firstEvent, undefined)),
                  Effect.andThen(Deferred.await(releaseFirst)),
                  Effect.andThen(Effect.sync(() => order.push("path-end"))),
                )
              : Effect.sync(() => order.push(event.type)),
        },
      ),
    );
    yield* Deferred.await(firstEvent);
    yield* Effect.yieldNow;
    assert.deepEqual(order, ["path-start"]);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(ordered);
    assert.deepEqual(order, ["path-start", "path-end", "setup-started"]);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fences native work when a request consumer exceeds its budget", () =>
  Effect.gen(function* () {
    const infrastructureErrors: string[] = [];
    const { runtime, scope, retired } = yield* acquire(
      (error) => infrastructureErrors.push(error.message),
      {
        requestInboxCapacity: 2,
      },
    );
    const flooded = yield* Effect.result(
      runtime.request(
        { operation: "create", input: createInput("flood") },
        { onEvent: () => Effect.never },
      ),
    );
    assert.isTrue(Result.isFailure(flooded));
    yield* Deferred.await(retired);
    assert.isTrue(infrastructureErrors.some((message) => message.includes("ingress exceeded")));

    const next = yield* Effect.result(
      runtime.request({
        operation: "create",
        input: createInput("must-not-retry"),
      }),
    );
    assert.isTrue(Result.isFailure(next));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(scope, Exit.void))));
  }),
);

it.effect("rejects protocol drift before spawning a worker", () =>
  Effect.gen(function* () {
    let infrastructureErrors = 0;
    const { runtime, scope } = yield* acquire(() => {
      infrastructureErrors += 1;
    });
    const invalid = yield* Effect.result(
      runtime.request({
        operation: "create",
        input: {
          ...createInput("invalid"),
          localEnvironmentConfigPath: "/repo/.codex/environments/environment.toml",
        },
      }),
    );
    assert.isTrue(Result.isFailure(invalid));
    if (Result.isFailure(invalid)) assert.match(invalid.failure.message, /protocol version/u);
    assert.strictEqual(infrastructureErrors, 0);

    const result = yield* runtime.request({
      operation: "create",
      input: {
        ...createInput("success"),
        localEnvironmentConfigPath: ".codex/environments/environment.toml",
      },
    });
    assert.isNull(result.setupError);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("closes active work and future admission with its Scope", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* acquire();
    const allocated = yield* Deferred.make<void>();
    const pending = yield* Effect.forkChild(
      runtime.request(
        { operation: "create", input: createInput("hang") },
        {
          onEvent: (event) =>
            event.type === "path-allocated"
              ? Deferred.succeed(allocated, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      ),
    );
    yield* Deferred.await(allocated);
    yield* Scope.close(scope, Exit.void);
    const closed = yield* Fiber.await(pending);
    assert.isTrue(Exit.isFailure(closed));
    const late = yield* Effect.result(
      runtime.request({ operation: "create", input: createInput("late") }),
    );
    assert.isTrue(Result.isFailure(late));
    if (Result.isFailure(late)) assert.match(late.failure.message, /shutting down/u);
  }),
);

type RequestMessage = Extract<CodexWorktreeWorkerHostMessage, { readonly type: "request" }>;
type CancelMessage = Extract<CodexWorktreeWorkerHostMessage, { readonly type: "cancel" }>;

const acquireControlled = Effect.fnUntraced(function* (
  options: {
    readonly gracefulShutdown?: boolean;
    readonly stopNever?: boolean;
    readonly holdStop?: boolean;
    readonly startup?: Deferred.Deferred<void>;
  } = {},
) {
  const scope = yield* Scope.make();
  const outgoing = yield* Queue.unbounded<RequestMessage>();
  const canceled = yield* Queue.unbounded<CancelMessage>();
  const shutdown = yield* Deferred.make<void>();
  const spawning = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  const retired = yield* Deferred.make<void>();
  const messages = new Set<(message: unknown) => void>();
  const errors = new Set<(error: Error) => void>();
  const exits = new Set<(code: number) => void>();
  const sent: CodexWorktreeWorkerHostMessage[] = [];
  const active = new Map<string, RequestMessage>();
  let processCount = 0;
  let terminateCount = 0;
  let releasing = false;
  let resolveStop: ((code: number) => void) | undefined;
  // EventEmitter dispatches a snapshot even when a callback replaces the worker generation.
  const emit = (message: CodexWorktreeWorkerThreadMessage) => {
    if (message.type === "result") active.delete(message.id);
    for (const listener of [...messages]) listener(message);
  };
  const acknowledge = (request: Pick<RequestMessage, "id" | "request">) =>
    emit({
      type: "result",
      id: request.id,
      operation: request.request.operation,
      result: { type: "error", code: "canceled", message: "Request canceled", retryable: true },
    });
  const exit = () => {
    for (const listener of [...exits]) listener(0);
  };
  const process: WorktreeWorkerProcess = {
    send: (message) => {
      sent.push(message);
      if (message.type === "request") {
        active.set(message.id, message);
        Queue.offerUnsafe(outgoing, message);
        return;
      }
      if (message.type === "cancel") {
        Queue.offerUnsafe(canceled, message);
        const request = active.get(message.id);
        if (releasing && request) acknowledge(request);
        return;
      }
      Deferred.doneUnsafe(shutdown, Effect.void);
      if (releasing || options.gracefulShutdown !== false) exit();
    },
    onMessage: (listener) => {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError: (listener) => {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    onExit: (listener) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    terminate: () => {
      terminateCount += 1;
      // @effect-diagnostics-next-line newPromise:off -- Gates the real endpoint-termination Promise contract.
      const stopped = new Promise<number>((resolve) => {
        if (options.stopNever) return;
        if (options.holdStop) {
          resolveStop = resolve;
          return;
        }
        resolve(0);
      });
      // A Deferred can resume the test immediately, so publish after its native handle exists.
      Deferred.doneUnsafe(stopping, Effect.void);
      if (!options.stopNever && !options.holdStop) exit();
      return stopped;
    },
  };
  const context = yield* Layer.buildWithScope(
    Layer.effect(
      WorktreeWorkerRuntime,
      makeWorktreeWorkerClient({
        hostId: "local",
        onInfrastructureError: () => {
          Deferred.doneUnsafe(retired, Effect.void);
        },
        createProcess: () =>
          Effect.gen(function* () {
            processCount += 1;
            yield* Deferred.succeed(spawning, undefined);
            if (options.startup) yield* Deferred.await(options.startup);
            return process;
          }),
      }),
    ),
    scope,
  );
  const runtime = Context.get(context, WorktreeWorkerRuntime);
  return {
    runtime,
    scope,
    outgoing,
    canceled,
    shutdown,
    spawning,
    stopping,
    retired,
    sent,
    emit,
    acknowledge,
    fail: (error: Error) => {
      for (const listener of [...errors]) listener(error);
    },
    completeTermination: () => {
      exit();
      resolveStop?.(0);
    },
    exit,
    get errorListeners() {
      return errors.size;
    },
    get processCount() {
      return processCount;
    },
    get terminateCount() {
      return terminateCount;
    },
    close: Effect.gen(function* () {
      releasing = true;
      resolveStop?.(0);
      for (const request of active.values()) acknowledge(request);
      // Let Scope drive graceful shutdown before releasing any remaining native listeners.
      yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
      exit();
      yield* Queue.shutdown(outgoing);
      yield* Queue.shutdown(canceled);
    }),
  };
});

const emitAllocated = (
  harness: Effect.Success<ReturnType<typeof acquireControlled>>,
  request: RequestMessage,
) =>
  Effect.sync(() => {
    const operation = request.request.operation;
    if (
      operation !== "create" &&
      operation !== "prepare-handoff" &&
      operation !== "import-handoff"
    ) {
      throw new Error(`Operation ${operation} cannot allocate a worktree path`);
    }
    harness.emit({
      type: "event",
      id: request.id,
      operation,
      event: {
        operation,
        type: "path-allocated",
        worktreeGitRoot: "/worktrees/abcd/repo",
        worktreeWorkspaceRoot: "/worktrees/abcd/repo/packages/app",
      },
    });
  });

const removeAllocated = (runtime: WorktreeWorkerRuntime["Service"]) =>
  runtime.request({
    operation: "remove",
    input: {
      requestId: "remove-after-cancel",
      hostId: "local",
      worktreeGitRoot: "/worktrees/abcd/repo",
      reason: "cancel",
      snapshotPolicy: "ephemeral",
    },
  });

it.effect(
  "joins a canceled event delivery before accepting the terminal cleanup acknowledgement",
  () =>
    Effect.acquireUseRelease(
      acquireControlled(),
      (harness) =>
        Effect.gen(function* () {
          const deliveryStarted = yield* Deferred.make<void>();
          const cleanupStarted = yield* Deferred.make<void>();
          const releaseDelivery = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            const pending = yield* Effect.forkChild(
              harness.runtime.request(
                { operation: "create", input: createInput("gated-cancel") },
                {
                  onEvent: () =>
                    Deferred.succeed(deliveryStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(
                        Deferred.succeed(cleanupStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseDelivery)),
                        ),
                      ),
                    ),
                },
              ),
            );
            const request = yield* Queue.take(harness.outgoing);
            yield* emitAllocated(harness, request);
            yield* Deferred.await(deliveryStarted);
            const interruption = yield* Effect.forkChild(Fiber.interrupt(pending));
            const cancel = yield* Queue.take(harness.canceled);
            assert.strictEqual(cancel.id, request.id);
            yield* Deferred.await(cleanupStarted);
            harness.acknowledge(request);
            yield* Effect.yieldNow;
            assert.isUndefined(interruption.pollUnsafe());
            yield* Deferred.succeed(releaseDelivery, undefined);
            yield* Fiber.join(interruption);
            assert.strictEqual(
              harness.sent.filter((message) => message.type === "cancel").length,
              1,
            );

            const successor = yield* Effect.forkChild(
              harness.runtime.request({
                operation: "create",
                input: createInput("successor"),
              }),
            );
            const next = yield* Queue.take(harness.outgoing);
            harness.emit({
              type: "result",
              id: request.id,
              operation: "create",
              result: {
                type: "error",
                code: "operation-failed",
                message: "Stale old result",
                retryable: true,
              },
            });
            yield* Effect.yieldNow;
            assert.isUndefined(successor.pollUnsafe());
            harness.emit({
              type: "result",
              id: next.id,
              operation: "create",
              result: {
                type: "ok",
                success: {
                  operation: "create",
                  value: {
                    worktreeGitRoot: "/worktrees/next/repo",
                    worktreeWorkspaceRoot: "/worktrees/next/repo",
                    setupError: null,
                    shellEnvironment: null,
                  },
                },
              },
            });
            assert.strictEqual(
              (yield* Fiber.join(successor)).worktreeGitRoot,
              "/worktrees/next/repo",
            );
            assert.strictEqual(harness.processCount, 1);
          }).pipe(Effect.ensuring(Deferred.succeed(releaseDelivery, undefined)));
        }),
      (harness) => harness.close,
    ),
);

it.effect("starts the worker exit window only after Scope cancellation has drained", () =>
  Effect.acquireUseRelease(
    acquireControlled({ gracefulShutdown: false }),
    (harness) =>
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(
          harness.runtime.request({
            operation: "create",
            input: createInput("scope-drain"),
          }),
        );
        const request = yield* Queue.take(harness.outgoing);
        const closing = yield* Effect.forkChild(Scope.close(harness.scope, Exit.void));
        yield* Queue.take(harness.canceled);
        yield* TestClock.adjust(5_000);
        assert.isUndefined(closing.pollUnsafe());
        assert.isFalse(harness.sent.some((message) => message.type === "shutdown"));
        assert.strictEqual(harness.terminateCount, 0);
        harness.acknowledge(request);
        yield* Deferred.await(harness.shutdown);
        yield* TestClock.adjust(1_499);
        assert.isUndefined(closing.pollUnsafe());
        assert.strictEqual(harness.terminateCount, 0);
        yield* TestClock.adjust(1);
        yield* Fiber.join(closing);
        assert.strictEqual(harness.terminateCount, 1);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      }),
    (harness) => harness.close,
  ),
);

it.effect(
  "preserves native release failure and preparation proof after an event consumer fails",
  () =>
    Effect.acquireUseRelease(
      acquireControlled(),
      (harness) =>
        Effect.gen(function* () {
          const callbackError = new Error("event observer failed");
          const pending = yield* Effect.forkChild(
            Effect.result(
              harness.runtime.request(
                { operation: "prepare-handoff", input: prepareInput("consumer-cleanup") },
                { onEvent: () => Effect.fail(callbackError) },
              ),
            ),
          );
          const request = yield* Queue.take(harness.outgoing);
          yield* emitAllocated(harness, request);
          yield* Queue.take(harness.canceled);
          assert.isUndefined(pending.pollUnsafe());
          harness.emit({
            type: "result",
            id: request.id,
            operation: "prepare-handoff",
            result: {
              type: "error",
              code: "operation-failed",
              message: "Native handles remain open",
              retryable: true,
              preparationRestored: false,
            },
          });
          const result = yield* Fiber.join(pending);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure.operation, "worker-result");
            assert.strictEqual(result.failure.message, "Native handles remain open");
            assert.isFalse(result.failure.preparationRestored);
            assert.instanceOf(result.failure.cause, AggregateError);
            const observer = (result.failure.cause as AggregateError).errors[1];
            assert.instanceOf(observer, WorktreeWorkerError);
            if (!Cause.isCause(observer.cause)) throw new Error("Expected an Effect failure cause");
            assert.strictEqual(Cause.squash(observer.cause), callbackError);
          }
          assert.strictEqual(harness.terminateCount, 0);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))));
        }),
      (harness) => harness.close,
    ),
);

it.effect(
  "fences subsequent removal even when the interrupted caller discards its failed Exit",
  () =>
    Effect.acquireUseRelease(
      acquireControlled(),
      (harness) =>
        Effect.gen(function* () {
          const pending = yield* Effect.forkChild(
            harness.runtime.request({
              operation: "create",
              input: createInput("uncertain-native-release"),
            }),
          );
          const request = yield* Queue.take(harness.outgoing);
          const interruption = yield* Effect.forkChild(Fiber.interrupt(pending));
          yield* Queue.take(harness.canceled);
          harness.emit({
            type: "result",
            id: request.id,
            operation: "create",
            result: {
              type: "error",
              code: "operation-failed",
              message: "Could not release setup shell",
              retryable: true,
            },
          });
          yield* Fiber.join(interruption);
          const removal = yield* Effect.result(removeAllocated(harness.runtime));
          assert.isTrue(Result.isFailure(removal));
          if (Result.isFailure(removal)) {
            assert.strictEqual(removal.failure.message, "Could not release setup shell");
            assert.isUndefined(removal.failure.preparationRestored);
          }
          assert.strictEqual(
            harness.sent.filter((message) => message.type === "request").length,
            1,
          );
          assert.strictEqual(harness.processCount, 1);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))));
        }),
      (harness) => harness.close,
    ),
);

it.effect("bounds a missing cleanup acknowledgement and rejects later work in the same Scope", () =>
  Effect.acquireUseRelease(
    acquireControlled(),
    (harness) =>
      Effect.gen(function* () {
        const callbackError = new Error("event consumer failed before missing cleanup ack");
        const pending = yield* Effect.forkChild(
          Effect.result(
            harness.runtime.request(
              { operation: "create", input: createInput("lost-ack") },
              { onEvent: () => Effect.fail(callbackError) },
            ),
          ),
        );
        const request = yield* Queue.take(harness.outgoing);
        yield* emitAllocated(harness, request);
        yield* Queue.take(harness.canceled);
        yield* TestClock.adjust(29_999);
        assert.isUndefined(pending.pollUnsafe());
        assert.strictEqual(harness.terminateCount, 0);
        yield* TestClock.adjust(1);
        const failed = yield* Fiber.join(pending);
        assert.isTrue(Result.isFailure(failed));
        if (Result.isFailure(failed)) {
          const transportFailure = failed.failure.cause as WorktreeWorkerError;
          assert.instanceOf(transportFailure.cause, AggregateError);
          const observer = (transportFailure.cause as AggregateError)
            .errors[1] as WorktreeWorkerError;
          assert.strictEqual(Cause.squash(observer.cause as Cause.Cause<Error>), callbackError);
        }
        assert.strictEqual(harness.terminateCount, 1);
        const removal = yield* Effect.result(removeAllocated(harness.runtime));
        assert.isTrue(Result.isFailure(removal));
        if (Result.isFailure(removal)) {
          assert.strictEqual(removal.failure.operation, "cancel-worker");
          assert.match(
            (removal.failure.cause as Error).message,
            /acknowledgement exceeded 30000ms/u,
          );
          assert.isUndefined(removal.failure.preparationRestored);
        }
        harness.acknowledge(request);
        const next = yield* Effect.result(
          harness.runtime.request({ operation: "create", input: createInput("blocked") }),
        );
        assert.isTrue(Result.isFailure(next));
        assert.strictEqual(harness.sent.filter((message) => message.type === "request").length, 1);
        assert.strictEqual(harness.processCount, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))));
      }),
    (harness) => harness.close,
  ),
);

it.effect("reports uncertain worker exit instead of hanging after the cleanup deadline", () =>
  Effect.acquireUseRelease(
    acquireControlled({ stopNever: true }),
    (harness) =>
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(
          harness.runtime.request({
            operation: "create",
            input: createInput("lost-worker-exit"),
          }),
        );
        yield* Queue.take(harness.outgoing);
        const interruption = yield* Effect.forkChild(Fiber.interrupt(pending));
        yield* Queue.take(harness.canceled);
        yield* TestClock.adjust(30_000);
        assert.strictEqual(harness.terminateCount, 1);
        assert.isUndefined(interruption.pollUnsafe());
        yield* TestClock.adjust(1_499);
        assert.isUndefined(interruption.pollUnsafe());
        yield* TestClock.adjust(1);
        yield* Fiber.join(interruption);
        assert.isTrue(Result.isFailure(yield* Effect.result(removeAllocated(harness.runtime))));
        assert.strictEqual(harness.sent.filter((message) => message.type === "request").length, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))));
        assert.strictEqual(harness.errorListeners, 1);
        assert.doesNotThrow(() => harness.fail(new Error("late endpoint error")));
        harness.exit();
        assert.strictEqual(harness.errorListeners, 0);
      }),
    (harness) => harness.close,
  ),
);

it.effect(
  "installs cancellation ownership across interrupted process acquisition and request admission",
  () =>
    Effect.gen(function* () {
      const startup = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        acquireControlled({ startup }),
        (harness) =>
          Effect.gen(function* () {
            const pending = yield* Effect.forkChild(
              harness.runtime.request({
                operation: "create",
                input: createInput("interrupted-admission"),
              }),
            );
            yield* Deferred.await(harness.spawning);
            const interruption = yield* Effect.forkChild(Fiber.interrupt(pending));
            yield* Effect.yieldNow;
            assert.isUndefined(interruption.pollUnsafe());
            yield* Deferred.succeed(startup, undefined);
            const request = yield* Queue.take(harness.outgoing);
            const cancel = yield* Queue.take(harness.canceled);
            assert.strictEqual(cancel.id, request.id);
            assert.isUndefined(interruption.pollUnsafe());
            harness.acknowledge(request);
            yield* Fiber.join(interruption);
            assert.strictEqual(
              harness.sent.filter((message) => message.type === "cancel").length,
              1,
            );
          }).pipe(Effect.ensuring(Deferred.succeed(startup, undefined))),
        (harness) => harness.close,
      );
    }),
);

it.effect("recovers an idle worker only after its previous endpoint has stopped", () =>
  Effect.acquireUseRelease(
    acquireControlled({ holdStop: true }),
    (harness) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(
          Effect.result(
            harness.runtime.request({
              operation: "create",
              input: createInput("retiring-generation"),
            }),
          ),
        );
        const original = yield* Queue.take(harness.outgoing);
        harness.emit({
          type: "result",
          id: original.id,
          operation: "create",
          result: {
            type: "ok",
            success: {
              operation: "create",
              value: {
                worktreeGitRoot: "/worktrees/first/repo",
                worktreeWorkspaceRoot: "/worktrees/first/repo",
                setupError: null,
                shellEnvironment: null,
              },
            },
          },
        });
        assert.isTrue(Result.isSuccess(yield* Fiber.join(first)));
        harness.fail(new Error("idle transport failed"));
        yield* Deferred.await(harness.stopping);
        const premature = yield* Effect.result(
          harness.runtime.request({
            operation: "create",
            input: createInput("must-not-start"),
          }),
        );
        assert.isTrue(Result.isFailure(premature));
        if (Result.isFailure(premature))
          assert.strictEqual(premature.failure.operation, "worker-retirement");
        assert.strictEqual(harness.processCount, 1);
        assert.strictEqual(harness.sent.filter((message) => message.type === "request").length, 1);
        harness.completeTermination();
        yield* Deferred.await(harness.retired);
        const recovered = yield* Effect.forkChild(
          harness.runtime.request({
            operation: "create",
            input: createInput("confirmed-replacement"),
          }),
        );
        const next = yield* Queue.take(harness.outgoing);
        harness.emit({
          type: "result",
          id: next.id,
          operation: "create",
          result: {
            type: "ok",
            success: {
              operation: "create",
              value: {
                worktreeGitRoot: "/worktrees/replacement/repo",
                worktreeWorkspaceRoot: "/worktrees/replacement/repo",
                setupError: null,
                shellEnvironment: null,
              },
            },
          },
        });
        assert.isNull((yield* Fiber.join(recovered)).setupError);
        assert.strictEqual(harness.processCount, 2);
      }),
    (harness) => harness.close,
  ),
);

it.effect("keeps late cancellation during endpoint retirement as an admission failure", () =>
  Effect.acquireUseRelease(
    acquireControlled({ holdStop: true }),
    (harness) =>
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(
          harness.runtime.request({
            operation: "create",
            input: createInput("late-retirement-cancel"),
          }),
        );
        yield* Queue.take(harness.outgoing);
        harness.fail(new Error("transport failed before cancellation"));
        yield* Deferred.await(harness.stopping);
        const interruption = yield* Effect.forkChild(Fiber.interrupt(pending));
        yield* Queue.take(harness.canceled);
        assert.isUndefined(interruption.pollUnsafe());
        harness.completeTermination();
        yield* Fiber.join(interruption);
        assert.isTrue(Result.isFailure(yield* Effect.result(removeAllocated(harness.runtime))));
        assert.strictEqual(harness.processCount, 1);
        assert.strictEqual(harness.sent.filter((message) => message.type === "request").length, 1);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))));
      }),
    (harness) => harness.close,
  ),
);

for (const activeRequest of [false, true]) {
  it.effect(
    `joins ${activeRequest ? "active" : "idle"} endpoint retirement before its Scope can finish`,
    () =>
      Effect.acquireUseRelease(
        acquireControlled({ holdStop: true }),
        (harness) =>
          Effect.gen(function* () {
            const pending = yield* Effect.forkChild(
              Effect.result(
                harness.runtime.request({
                  operation: "create",
                  input: createInput("retirement-scope"),
                }),
              ),
            );
            const request = yield* Queue.take(harness.outgoing);
            if (!activeRequest) {
              harness.emit({
                type: "result",
                id: request.id,
                operation: "create",
                result: {
                  type: "ok",
                  success: {
                    operation: "create",
                    value: {
                      worktreeGitRoot: "/worktrees/idle/repo",
                      worktreeWorkspaceRoot: "/worktrees/idle/repo",
                      setupError: null,
                      shellEnvironment: null,
                    },
                  },
                },
              });
              assert.isTrue(Result.isSuccess(yield* Fiber.join(pending)));
            }
            harness.fail(new Error("transport failed during Scope shutdown"));
            yield* Deferred.await(harness.stopping);
            const closing = yield* Effect.forkChild(
              Effect.exit(Scope.close(harness.scope, Exit.void)),
            );
            if (activeRequest) yield* Queue.take(harness.canceled);
            yield* TestClock.adjust(0);
            assert.isUndefined(closing.pollUnsafe());
            if (activeRequest) assert.isUndefined(pending.pollUnsafe());
            harness.completeTermination();
            const closed = yield* Fiber.join(closing);
            assert.strictEqual(Exit.isFailure(closed), activeRequest);
            if (activeRequest) assert.isTrue(Result.isFailure(yield* Fiber.join(pending)));
            assert.strictEqual(harness.terminateCount, 1);
          }),
        (harness) => harness.close,
      ),
  );
}

it.effect(
  "keeps active unacknowledged native work fenced after endpoint exit without caller cancellation",
  () =>
    Effect.acquireUseRelease(
      acquireControlled({ holdStop: true }),
      (harness) =>
        Effect.gen(function* () {
          const pending = yield* Effect.forkChild(
            Effect.result(
              harness.runtime.request({
                operation: "create",
                input: createInput("unacknowledged-native-work"),
              }),
            ),
          );
          const request = yield* Queue.take(harness.outgoing);
          yield* emitAllocated(harness, request);
          harness.fail(new Error("worker transport lost while native work may still run"));
          yield* Deferred.await(harness.stopping);
          harness.completeTermination();
          const failed = yield* Fiber.join(pending);
          assert.isTrue(Result.isFailure(failed));
          if (Result.isFailure(failed)) {
            assert.strictEqual(failed.failure.operation, "worker-cleanup");
            assert.isUndefined(failed.failure.preparationRestored);
          }
          assert.isTrue(Result.isFailure(yield* Effect.result(removeAllocated(harness.runtime))));
          assert.isTrue(
            Result.isFailure(
              yield* Effect.result(
                harness.runtime.request({
                  operation: "create",
                  input: createInput("must-not-replace-native-owner"),
                }),
              ),
            ),
          );
          assert.strictEqual(
            harness.sent.filter((message) => message.type === "request").length,
            1,
          );
          assert.isFalse(harness.sent.some((message) => message.type === "cancel"));
          assert.strictEqual(harness.processCount, 1);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))));
        }),
      (harness) => harness.close,
    ),
);

for (const [code, blocked] of [
  ["release-unconfirmed", true],
  ["operation-failed", false],
] as const) {
  it.effect(
    `keeps admission ${blocked ? "fenced" : "recoverable"} after an active ${code} result`,
    () =>
      Effect.acquireUseRelease(
        acquireControlled(),
        (harness) =>
          Effect.gen(function* () {
            const pending = yield* Effect.forkChild(
              Effect.result(
                harness.runtime.request({
                  operation: "create",
                  input: createInput("active-native-outcome"),
                }),
              ),
            );
            const request = yield* Queue.take(harness.outgoing);
            harness.emit({
              type: "result",
              id: request.id,
              operation: "create",
              result: {
                type: "error",
                code,
                message: "Git command failed without caller cancellation",
                retryable: true,
              },
            });
            const failed = yield* Fiber.join(pending);
            assert.isTrue(Result.isFailure(failed));
            if (Result.isFailure(failed)) {
              // A valid terminal result must not be mistaken for protocol drift or transport loss.
              assert.strictEqual(failed.failure.operation, "worker-result");
              assert.strictEqual(
                failed.failure.message,
                "Git command failed without caller cancellation",
              );
            }
            const successor = yield* Effect.forkChild(
              Effect.result(
                harness.runtime.request({
                  operation: "create",
                  input: createInput("next-mutation"),
                }),
              ),
            );
            if (!blocked) {
              const next = yield* Queue.take(harness.outgoing);
              harness.emit({
                type: "result",
                id: next.id,
                operation: "create",
                result: {
                  type: "ok",
                  success: {
                    operation: "create",
                    value: {
                      worktreeGitRoot: "/worktrees/recovered/repo",
                      worktreeWorkspaceRoot: "/worktrees/recovered/repo",
                      setupError: null,
                      shellEnvironment: null,
                    },
                  },
                },
              });
            }
            const nextResult = yield* Fiber.join(successor);
            assert.strictEqual(Result.isFailure(nextResult), blocked);
            assert.strictEqual(
              harness.sent.filter((message) => message.type === "request").length,
              blocked ? 1 : 2,
            );
            assert.isFalse(harness.sent.some((message) => message.type === "cancel"));
            assert.strictEqual(harness.processCount, 1);
            assert.strictEqual(
              Exit.isFailure(yield* Effect.exit(Scope.close(harness.scope, Exit.void))),
              blocked,
            );
          }),
        (harness) => harness.close,
      ),
  );
}
