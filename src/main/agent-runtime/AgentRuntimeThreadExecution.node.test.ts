import { assert, it } from "@effect/vitest";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { testLayer } from "../app/MainConfig";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { CodexThreadExecution } from "../codex-application/CodexThreadExecution";
import { make as makeHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import {
  ManagedWorktreeHandoff,
  type ManagedWorktreeHandoffPreparation,
} from "../codex-application/ManagedWorktreeHandoff";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import { ThreadExecution, make as makeThreadExecution } from "../host-runtime/ThreadExecution";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AgentRuntimeApplication } from "./AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";
import { AgentRuntimeThreadExecution, make } from "./AgentRuntimeThreadExecution";

const source: CodexThreadExecutionLocation = {
  hostId: "local",
  cwd: "/repo/project/src",
  workspaceRoots: ["/repo/project", "/repo/shared"],
  managedWorktreePath: null,
  projectId: "project",
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
};
const destination: CodexThreadExecutionLocation = {
  ...source,
  cwd: "/managed/task/src",
  workspaceRoots: ["/managed/task", "/repo/shared"],
  managedWorktreePath: "/managed/task",
};
const preparation: ManagedWorktreeHandoffPreparation = {
  destination,
  prepared: {
    direction: "to-worktree",
    sourceBranch: "main",
    localCheckoutBranch: "main",
    destinationBranch: "codex/task",
    sourceWorkspaceRoot: source.workspaceRoots[0]!,
    destinationWorkspaceRoot: destination.workspaceRoots[0]!,
    destinationGitRoot: destination.workspaceRoots[0]!,
    managedWorktreePath: destination.managedWorktreePath!,
    createdWorktree: true,
    warnings: [],
  },
};
type Thread = NonNullable<AgentRuntimeOperations["thread.read"]["output"]>;
type Pending = AgentRuntimeOperations["execution.handoff.pending"]["output"]["items"][number];
const harness = (
  options: {
    readonly savedLocation?: CodexThreadExecutionLocation;
    readonly gitRoot?: string;
    readonly cold?: boolean;
    readonly invalidateAtWriter?: boolean;
    readonly pending?: ReadonlyArray<ReadonlyArray<Pending>>;
  } = {},
) =>
  Effect.gen(function* () {
    const state = {
      thread: {
        id: "thread",
        lineage: { rootThreadId: "thread" },
        worktreePath: source.cwd,
        ...(options.savedLocation ? { executionLocation: options.savedLocation } : {}),
      } as Thread,
      writer: false,
      available: true,
      connects: 0,
      gitReads: 0,
      quiesceFails: false,
    };
    const calls: Array<{ method: AgentRuntimeMethod; input: unknown }> = [];
    const messages: unknown[] = [];
    const request = <M extends AgentRuntimeMethod>(
      method: M,
      input: AgentRuntimeOperations[M]["input"],
    ): Effect.Effect<AgentRuntimeOperations[M]["output"], Error> =>
      Effect.sync(() => {
        calls.push({ method, input });
        if (method === "thread.read") return state.thread as AgentRuntimeOperations[M]["output"];
        if (method === "execution.handoff.hold") {
          const hold = input as AgentRuntimeOperations["execution.handoff.hold"]["input"];
          state.thread = {
            ...state.thread,
            executionHandoff:
              hold.action === "release"
                ? null
                : {
                    operationId: hold.operationId,
                    recoveryRequired: hold.recoveryRequired ?? false,
                    sourceLocation:
                      hold.sourceLocation ?? state.thread.executionHandoff?.sourceLocation,
                  },
          };
        }
        if (method === "execution.handoff.commit") {
          const commit = input as AgentRuntimeOperations["execution.handoff.commit"]["input"];
          if (!commit.childrenOnly)
            state.thread = {
              ...state.thread,
              executionLocation: commit.location,
              worktreePath: commit.location.cwd,
            };
        }
        if (method === "execution.handoff.pending") {
          const page = Number((input as { cursor?: string }).cursor ?? "0");
          return {
            items: options.pending?.[page] ?? [],
            nextCursor: page + 1 < (options.pending?.length ?? 0) ? String(page + 1) : null,
          } as AgentRuntimeOperations[M]["output"];
        }
        return null as AgentRuntimeOperations[M]["output"];
      }).pipe(
        Effect.flatMap((output) =>
          method === "execution.handoff.quiesce" && state.quiesceFails
            ? Effect.fail(new Error("Old native detach is still pending"))
            : Effect.succeed(output),
        ),
      );
    const connection = { request };
    const application = {
      nativeThread: () =>
        Effect.sync(() =>
          state.available ? { connection, thread: state.thread, sessionId: "session" } : null,
        ),
      withExecutionLocationWriter: <A, E, R>(sessionId: string, use: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            assert.strictEqual(sessionId, "session");
            assert.isFalse(state.writer);
            state.writer = true;
            if (options.invalidateAtWriter) state.available = false;
          }),
          () => use,
          () =>
            Effect.sync(() => {
              state.writer = false;
            }),
        ),
      message: (input: unknown) =>
        Effect.sync(() => {
          messages.push(input);
        }),
    } as unknown as AgentRuntimeApplication["Service"];
    const execution = yield* make.pipe(
      Effect.provideService(AgentRuntimeApplication, application),
      Effect.provideService(AgentRuntimeSupervisor, {
        get: () =>
          Effect.sync(() => {
            state.connects++;
            return connection;
          }),
      } as unknown as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: () => Effect.succeed({ projectId: "project" }),
        getProject: () => Effect.succeed({ sources: [{ root: "/repo/shared" }] }),
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(
        CodexGitProbe,
        CodexGitProbe.of({
          readPath: () =>
            Effect.sync(() => {
              state.gitReads++;
              return options.gitRoot ?? "/repo/project";
            }),
          isNonGitWorkspace: () => Effect.succeed(false),
          isNonGitWorkspaceOnHost: () => Effect.succeed(false),
        }),
      ),
      Effect.provideService(ExecutionHostRuntime, {
        get: () => Effect.succeed({ descriptor: { managedRoot: "/managed" } }),
      } as unknown as ExecutionHostRuntime["Service"]),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(!options.cold),
          realPath: (value) => Effect.succeed(value),
        }),
      ),
      Effect.provide(testLayer()),
    );
    return { execution, state, calls, messages };
  });

const coordinatorFor = (execution: AgentRuntimeThreadExecution["Service"]) =>
  Effect.gen(function* () {
    const unused = () => Effect.die("A native writer must not run for a Runtime Session");
    const threadExecution = yield* makeThreadExecution.pipe(
      Effect.provideService(AgentRuntimeThreadExecution, execution),
      Effect.provideService(ProjectWorkspace, {
        getThread: unused,
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(
        CodexThreadExecution,
        CodexThreadExecution.of({
          read: unused,
          stop: unused,
          setRecoveryRequired: unused,
          withHandoff: unused,
          switchRuntime: unused,
          relocate: unused,
          commit: unused,
          followUp: unused,
        }),
      ),
    );
    return yield* makeHandoffRuntime({
      storage: { load: Effect.succeed([]), persist: () => Effect.void },
    }).pipe(
      Effect.provideService(ThreadExecution, threadExecution),
      Effect.provideService(ExecutionHostRuntime, {
        get: () => Effect.succeed(null),
      } as unknown as ExecutionHostRuntime["Service"]),
      Effect.provideService(ManagedWorktreeHandoff, {} as ManagedWorktreeHandoff["Service"]),
    );
  });

it.effect(
  "reads persisted execution metadata and derives an initial local workspace without history",
  () =>
    Effect.gen(function* () {
      const saved = yield* harness({ savedLocation: destination });
      assert.deepEqual(yield* saved.execution.read("thread"), destination);
      assert.strictEqual(saved.state.gitReads, 0);
      assert.deepEqual(saved.calls, []);
      const initial = yield* harness({ gitRoot: "/managed/task" });
      assert.deepEqual(yield* initial.execution.read("thread"), {
        ...source,
        workspaceRoots: ["/managed/task", "/repo/shared"],
        managedWorktreePath: "/managed/task",
      });
      assert.strictEqual(initial.state.gitReads, 1);
    }),
);

it.effect(
  "holds the snapshot writer through quiescence and durable commit, then releases verified recovery",
  () =>
    Effect.gen(function* () {
      const f = yield* harness();
      const result = yield* f.execution.withHandoff(
        "thread",
        Effect.gen(function* () {
          assert.isTrue(f.state.writer);
          assert.deepEqual(f.state.thread.executionHandoff?.sourceLocation, source);
          yield* f.execution.setRecoveryRequired("thread", true, "move");
          yield* f.execution.stop("thread");
          yield* f.execution.withRuntimeLocation(
            "thread",
            destination,
            null,
            f.execution.commit("thread", destination),
          );
          yield* f.execution.setRecoveryRequired("thread", false, "move");
          return "moved";
        }),
        "move",
      );
      assert.strictEqual(result, "moved");
      assert.isFalse(f.state.writer);
      assert.isNull(f.state.thread.executionHandoff);
      assert.deepEqual(f.state.thread.executionLocation, destination);
      assert.deepEqual(
        f.calls.map((call) => call.method),
        [
          "execution.handoff.hold",
          "execution.handoff.hold",
          "execution.handoff.quiesce",
          "execution.handoff.commit",
          "execution.handoff.quiesce",
          "execution.handoff.hold",
          "thread.read",
          "execution.handoff.hold",
        ],
      );
      assert.deepEqual(f.calls.at(-1)?.input, {
        threadId: "thread",
        operationId: "move",
        action: "release",
      });
    }),
);

it.effect("rechecks the Session binding after entering its handoff writer lane", () =>
  Effect.gen(function* () {
    const f = yield* harness({ invalidateAtWriter: true });
    assert.isTrue(
      Exit.isFailure(
        yield* f.execution
          .withHandoff("thread", Effect.die("An invalidated Session must not move"), "move")
          .pipe(Effect.exit),
      ),
    );
    assert.deepEqual(f.calls, []);
    assert.isFalse(f.state.writer);
  }),
);

it.effect("keeps failed and interrupted physical handoffs sealed for recovery", () =>
  Effect.gen(function* () {
    const failed = yield* harness();
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          failed.execution.withHandoff("thread", Effect.fail("Git failed"), "failed"),
        ),
      ),
    );
    assert.strictEqual(failed.state.thread.executionHandoff?.recoveryRequired, true);
    assert.isFalse(failed.state.writer);
    const cancelled = yield* harness();
    const started = yield* Deferred.make<void>();
    const fiber = yield* cancelled.execution
      .withHandoff(
        "thread",
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        "cancelled",
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    assert.strictEqual(cancelled.state.thread.executionHandoff?.recoveryRequired, true);
    assert.isFalse(cancelled.state.writer);
  }),
);

it.effect(
  "waits for native quiescence before clearing recovery and retains the coordinator seal on failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* harness();
        const coordinator = yield* coordinatorFor(f.execution);
        f.state.quiesceFails = true;
        const result = yield* coordinator.start({
          operationId: "move",
          threadId: "thread",
          destinationHostId: null,
          followUpPrompt: null,
        });
        assert.strictEqual(result.phase, "recovery-required");
        assert.strictEqual(f.state.thread.executionHandoff?.recoveryRequired, true);
        assert.isFalse(
          f.calls.some(
            (call) =>
              call.method === "execution.handoff.hold" &&
              (call.input as { action: string; recoveryRequired?: boolean }).action === "release",
          ),
        );
        assert.isFalse(
          f.calls.some(
            (call) =>
              call.method === "execution.handoff.hold" &&
              (call.input as { recoveryRequired?: boolean }).recoveryRequired === false,
          ),
        );
        assert.strictEqual(
          f.calls.filter((call) => call.method === "execution.handoff.quiesce").length,
          2,
        );
      }),
    ),
);

it.effect(
  "reconciles prepared child locations in both directions before root commit or rollback",
  () =>
    Effect.gen(function* () {
      const f = yield* harness();
      yield* f.execution.withHandoff(
        "thread",
        Effect.gen(function* () {
          yield* f.execution.withRuntimeLocation(
            "thread",
            destination,
            preparation,
            Effect.sync(() => {
              assert.strictEqual(
                f.state.thread.worktreePath,
                source.cwd,
                "Child reconciliation must not commit the root",
              );
            }),
          );
          yield* f.execution.withRuntimeLocation(
            "thread",
            source,
            preparation,
            Effect.sync(() => {
              assert.strictEqual(f.state.thread.worktreePath, source.cwd);
            }),
          );
          yield* f.execution.withRuntimeLocation(
            "thread",
            destination,
            preparation,
            f.execution.commit("thread", destination),
          );
          yield* f.execution.withRuntimeLocation(
            "thread",
            source,
            preparation,
            f.execution.commit("thread", source),
          );
        }),
        "move",
      );
      const commits = f.calls
        .filter((call) => call.method === "execution.handoff.commit")
        .map((call) => call.input);
      assert.deepEqual(commits, [
        {
          threadId: "thread",
          operationId: "move",
          location: destination,
          sourceWorkspaceRoot: "/repo/project",
          childrenOnly: true,
        },
        {
          threadId: "thread",
          operationId: "move",
          location: source,
          sourceWorkspaceRoot: "/managed/task",
          childrenOnly: true,
        },
        {
          threadId: "thread",
          operationId: "move",
          location: destination,
          sourceWorkspaceRoot: "/repo/project",
          childrenOnly: true,
        },
        { threadId: "thread", operationId: "move", location: destination },
        {
          threadId: "thread",
          operationId: "move",
          location: source,
          sourceWorkspaceRoot: "/managed/task",
          childrenOnly: true,
        },
        { threadId: "thread", operationId: "move", location: source },
      ]);
      assert.strictEqual(f.state.thread.worktreePath, source.cwd);
    }),
);

it.effect(
  "rejects remote relocation and unheld commits; follow-up retries keep one message identity",
  () =>
    Effect.gen(function* () {
      const f = yield* harness();
      for (const use of [
        f.execution.read("thread", "ssh:remote"),
        f.execution.commit("thread", destination),
        f.execution.withRuntimeLocation(
          "thread",
          { ...destination, hostId: "ssh:remote" },
          null,
          Effect.void,
        ),
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(use)));
      assert.deepEqual(f.calls, []);
      yield* f.execution.followUp("thread", "continue", "move");
      yield* f.execution.followUp("thread", "continue", "move");
      assert.deepEqual(f.messages[0], f.messages[1]);
      assert.strictEqual((f.messages[0] as { sessionId: string }).sessionId, "session");
    }),
);

it.effect(
  "reconciles paged orphan holds while preserving exact journal ownership and cold Profiles",
  () =>
    Effect.gen(function* () {
      const f = yield* harness({
        pending: [
          [
            { threadId: "thread", operationId: "keep", recoveryRequired: true },
            { threadId: "orphan", operationId: "missing", recoveryRequired: false },
          ],
          [{ threadId: "thread", operationId: "terminal", recoveryRequired: true }],
        ],
      });
      yield* f.execution.reconcileRecovery([{ threadId: "thread", operationId: "keep" }]);
      assert.deepEqual(
        f.calls.map((call) => call.method),
        [
          "execution.handoff.pending",
          "execution.handoff.quiesce",
          "execution.handoff.hold",
          "execution.handoff.hold",
          "execution.handoff.pending",
          "execution.handoff.quiesce",
          "execution.handoff.hold",
          "execution.handoff.hold",
        ],
      );
      assert.deepEqual(
        f.calls
          .filter((call) => call.method === "execution.handoff.quiesce")
          .map((call) => call.input),
        [
          { threadId: "orphan", operationId: "missing" },
          { threadId: "thread", operationId: "terminal" },
        ],
      );
      assert.deepEqual(
        f.calls
          .filter((call) => call.method === "execution.handoff.pending")
          .map((call) => call.input),
        [{}, { cursor: "1" }],
      );
      assert.deepEqual(
        f.calls
          .filter((call) => call.method === "execution.handoff.hold")
          .map((call) => call.input),
        [
          {
            threadId: "orphan",
            operationId: "missing",
            action: "recovery",
            recoveryRequired: false,
          },
          { threadId: "orphan", operationId: "missing", action: "release" },
          {
            threadId: "thread",
            operationId: "terminal",
            action: "recovery",
            recoveryRequired: false,
          },
          { threadId: "thread", operationId: "terminal", action: "release" },
        ],
      );
      const cold = yield* harness({ cold: true });
      yield* cold.execution.reconcileRecovery([]);
      assert.strictEqual(cold.state.connects, 0);
    }),
);

it.effect(
  "retains orphan recovery when native retirement fails and releases only after retry",
  () =>
    Effect.gen(function* () {
      const f = yield* harness({
        pending: [[{ threadId: "thread", operationId: "orphan", recoveryRequired: true }]],
      });
      f.state.quiesceFails = true;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(f.execution.reconcileRecovery([]))));
      assert.deepEqual(f.calls, [
        { method: "execution.handoff.pending", input: {} },
        {
          method: "execution.handoff.quiesce",
          input: { threadId: "thread", operationId: "orphan" },
        },
      ]);
      f.state.quiesceFails = false;
      yield* f.execution.reconcileRecovery([]);
      assert.deepEqual(f.calls.slice(2), [
        { method: "execution.handoff.pending", input: {} },
        {
          method: "execution.handoff.quiesce",
          input: { threadId: "thread", operationId: "orphan" },
        },
        {
          method: "execution.handoff.hold",
          input: {
            threadId: "thread",
            operationId: "orphan",
            recoveryRequired: false,
            action: "recovery",
          },
        },
        {
          method: "execution.handoff.hold",
          input: { threadId: "thread", operationId: "orphan", action: "release" },
        },
      ]);
    }),
);

it.effect(
  "prepares an empty journal without connecting and retries orphan retirement in background recovery",
  () =>
    Effect.gen(function* () {
      const f = yield* harness({
        pending: [[{ threadId: "thread", operationId: "orphan", recoveryRequired: true }]],
      });
      f.state.thread = {
        ...f.state.thread,
        executionHandoff: { operationId: "orphan", recoveryRequired: true },
      };
      f.state.quiesceFails = true;
      const coordinator = yield* coordinatorFor(f.execution);
      yield* coordinator.prepareRecovery;
      assert.strictEqual(f.state.connects, 0);
      assert.deepEqual(f.calls, []);

      assert.isTrue(Exit.isFailure(yield* Effect.exit(coordinator.recover())));
      assert.deepEqual(f.calls, [
        { method: "execution.handoff.pending", input: {} },
        {
          method: "execution.handoff.quiesce",
          input: { threadId: "thread", operationId: "orphan" },
        },
      ]);
      assert.strictEqual(f.state.thread.executionHandoff?.recoveryRequired, true);
      f.state.quiesceFails = false;
      assert.deepEqual(yield* coordinator.recover(), []);
      assert.deepEqual(f.calls.slice(2), [
        { method: "execution.handoff.pending", input: {} },
        {
          method: "execution.handoff.quiesce",
          input: { threadId: "thread", operationId: "orphan" },
        },
        {
          method: "execution.handoff.hold",
          input: {
            threadId: "thread",
            operationId: "orphan",
            recoveryRequired: false,
            action: "recovery",
          },
        },
        {
          method: "execution.handoff.hold",
          input: { threadId: "thread", operationId: "orphan", action: "release" },
        },
      ]);
      assert.isNull(f.state.thread.executionHandoff);
      const connects = f.state.connects;
      const requests = f.calls.length;
      yield* coordinator.prepareRecovery;
      assert.deepEqual(yield* coordinator.recover(), []);
      assert.strictEqual(f.state.connects, connects);
      assert.strictEqual(f.calls.length, requests);
    }),
);
