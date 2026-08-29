import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vite-plus/test";
import type { CodexWorktreeWorkerCreateInput } from "../codex/codex-worktree-worker-protocol";
import { CODEX_WORKTREE_WORKER_PROTOCOL_VERSION } from "../worktree-worker/worktree-worker-protocol";
import { localLive, WorktreeWorkerRuntime } from "./WorktreeWorkerRuntime";

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
  if (message.type === "cancel") return;
  const request = message.request;
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

const acquire = (
  onInfrastructureError?: (error: Error) => void,
  capacity?: { readonly requestInboxCapacity: number },
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      localLive({ hostId: "local", workerPath: fixturePath, onInfrastructureError, ...capacity }),
      scope,
    );
    return { runtime: Context.get(context, WorktreeWorkerRuntime), scope };
  });

it.effect("streams events and replaces a crashed worker generation", () =>
  Effect.gen(function* () {
    const infrastructureErrors: string[] = [];
    const { runtime, scope } = yield* acquire((error) => infrastructureErrors.push(error.message));
    const crashed = yield* Effect.result(
      runtime.request({ operation: "create", input: createInput("crash") }),
    );
    assert.isTrue(Result.isFailure(crashed));
    if (Result.isFailure(crashed)) {
      assert.strictEqual(crashed.failure.message, "Worktree worker is temporarily unavailable");
    }
    assert.strictEqual(infrastructureErrors.length, 1);

    const events: string[] = [];
    const result = yield* runtime.request(
      { operation: "create", input: createInput("success") },
      { onEvent: (event) => Effect.sync(() => events.push(event.type)) },
    );
    assert.deepEqual(events, ["path-allocated"]);
    assert.strictEqual(result.worktreeWorkspaceRoot, "/worktrees/abcd/repo/packages/app");
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

it.effect("fails and replaces a worker generation when a request consumer exceeds its budget", () =>
  Effect.gen(function* () {
    const infrastructureErrors: string[] = [];
    const { runtime, scope } = yield* acquire((error) => infrastructureErrors.push(error.message), {
      requestInboxCapacity: 2,
    });
    const flooded = yield* Effect.result(
      runtime.request(
        { operation: "create", input: createInput("flood") },
        { onEvent: () => Effect.never },
      ),
    );
    assert.isTrue(Result.isFailure(flooded));
    assert.isTrue(infrastructureErrors.some((message) => message.includes("ingress exceeded")));

    const recovered = yield* runtime.request({
      operation: "create",
      input: createInput("success"),
    });
    assert.isNull(recovered.setupError);
    yield* Scope.close(scope, Exit.void);
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
