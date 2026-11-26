import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import type {
  AgentRuntimeMethod,
  AgentRuntimeOperations,
  AgentThreadAuthority,
  AgentSnapshot,
} from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
import { ASYNC_WAIT_TIMEOUT_MS } from "../../../config/test-timeouts";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import { make as makeAgentRuntimePresentationRelease } from "./AgentRuntimePresentationRelease";
import {
  CodexRendererPresentationRegistry,
  make as makePresentation,
} from "../codex-application/CodexRendererPresentationRegistry";
import {
  CodexUserInputAutoResolution,
  make as makeDeadlines,
} from "../codex-application/CodexUserInputAutoResolution";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";
import { make as makeAgentRuntimeUserInputAutoResolution } from "./AgentRuntimeUserInputAutoResolution";

import { subscribe } from "./AgentRuntimeExecutionChanges";
import { make as makeChatMessageDelivery } from "./ChatMessageDelivery";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";

describe("AgentRuntimeThreadExecution", () => {
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
      /** Evidence proves the stopped store has nothing to resume. */
      readonly quiet?: boolean;
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
      const connect = Effect.sync(() => {
        state.connects++;
        return connection;
      });
      const application = {
        nativeThread: () =>
          Effect.sync(() =>
            state.available ? { connection, thread: state.thread, sessionId: "session" } : null,
          ),
        executionLocation: ({ thread }: { thread: Thread }) =>
          Effect.succeed(thread.executionLocation ?? source),
        withExecutionLocation: <A, E, R>(sessionId: string, use: Effect.Effect<A, E, R>) =>
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
          get: () => connect,
          getUnlessQuiet: options.quiet ? Effect.succeed(null) : connect,
        } as unknown as AgentRuntimeSupervisor["Service"]),
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
        Effect.provideService(ManagedWorktreeHandoff, {
          selectStrategy: () => Effect.succeed("transfer"),
        } as unknown as ManagedWorktreeHandoff["Service"]),
      );
    });

  it.effect(
    "retains Runtime usage through quiescence and durable commit, then releases verified recovery",
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
        assert.deepEqual(yield* f.execution.read("thread"), destination);
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
        yield* f.execution.followUp("thread", "continue", "move", {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        yield* f.execution.followUp("thread", "continue", "move", {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        assert.deepEqual(f.messages[0], f.messages[1]);
        assert.deepEqual((f.messages[0] as { modeLimit?: unknown }).modeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        assert.strictEqual((f.messages[0] as { sessionId: string }).sessionId, "session");
        yield* f.execution.followUp("thread", "continue", "agent-move", undefined, {
          threadId: "outside",
          runId: "outside-run",
        });
        assert.deepInclude(f.messages[2], {
          senderThreadId: "outside",
          senderRunId: "outside-run",
        });
      }),
  );

  it.effect(
    "reconciles paged orphan holds while preserving exact journal ownership and quiet Profiles",
    () =>
      Effect.gen(function* () {
        const f = yield* harness({
          pending: [
            [
              { threadId: "thread", operationId: "keep", recoveryRequired: true },
              { threadId: "orphan", operationId: "missing", recoveryRequired: false },
              { threadId: "import", operationId: "native-import:pending", recoveryRequired: true },
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
        const quiet = yield* harness({ quiet: true });
        yield* quiet.execution.reconcileRecovery([]);
        assert.strictEqual(quiet.state.connects, 0);
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
});

describe("AgentRuntimePresentationRelease", () => {
  const make = makeAgentRuntimePresentationRelease;
  const proof = (threadId: string, runId = "run") =>
    ({
      threadId,
      runId,
      userMessageId: `message:${threadId}`,
      providerSessionId: "provider-session",
      nativeGeneration: 1,
    }) as AgentThreadAuthority;

  const fixture = Effect.gen(function* () {
    const events = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
    const ended = yield* Deferred.make<never>();
    const settled = yield* Deferred.make<void>();
    const live = new Set(["root", "child"]);
    const reads: string[] = [];
    const finished: unknown[][] = [];
    const observations: string[] = [];
    let subscriptions = 0;
    let hangingUnobserve = false;
    let unobserved: string[] = [];
    const request: AgentRuntimeProcessConnection["request"] = <M extends AgentRuntimeMethod>(
      method: M,
      input: AgentRuntimeOperations[M]["input"],
    ) =>
      method === "events.unobserve" && hangingUnobserve
        ? Effect.never
        : Effect.sync(() => {
            if (method === "execution.observe")
              return {
                subscribed: true,
                subscriptionId: `lifecycle:${++subscriptions}`,
                afterSequence: 0,
              } as AgentRuntimeOperations[M]["output"];
            if (method === "events.unobserve") {
              unobserved = [
                ...unobserved,
                (input as AgentRuntimeOperations["events.unobserve"]["input"]).subscriptionId,
              ];
              return { unsubscribed: true } as AgentRuntimeOperations[M]["output"];
            }
            if (method !== "thread.authority") throw Error(`Unexpected runtime request ${method}`);
            const thread = (input as AgentRuntimeOperations["thread.authority"]["input"]).threadId;
            reads.push(thread);
            return (
              live.has(thread) ? { runtimeId: "runtime", runtimeGeneration: "generation" } : null
            ) as AgentRuntimeOperations[M]["output"];
          });
    const connection: AgentRuntimeProcessConnection = {
      identity: {
        runtimeId: "runtime",
        runtimeGeneration: "generation",
        schemaVersion: 1,
        databasePath: "/runtime.sqlite",
        mcpEndpoint: "http://localhost:1/mcp",
        lastSequence: 0,
      },
      request,
      terminated: Deferred.await(ended),
      notifications: Stream.fromPubSub(events),
      subscribeNotifications: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
      liveness: Stream.make("ready" as const),
      subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
        Effect.map(Stream.fromSubscription),
      ),
    };
    const release = yield* make(connection, {
      observeRuntimeMessage: (threadId, runId) =>
        Effect.sync(() => observations.push(`${threadId}/${runId}`)),
      finish: (...args) => finished.push(["run", ...args]),
      finishRuntimeSource: (value) => finished.push(["source", value]),
      finishRuntimeLease: (...args) => {
        finished.push(["lease", ...args]);
        Deferred.doneUnsafe(settled, Effect.void);
      },
    });
    const lifecycle = (
      delivery: number,
      threadId: string,
      runStatus: "completed" | "running" | "cancelled",
      options: { readonly generation?: string; readonly subscription?: number } = {},
    ) =>
      PubSub.publish(events, {
        delivery,
        notification: {
          type: "execution.lifecycle",
          subscriptionId: `lifecycle:${options.subscription ?? 1}`,
          runtimeGeneration: options.generation ?? "generation",
          sequence: delivery,
          threadId,
          eventType: "run.updated",
          runId: "run",
          runStatus,
        },
      });
    const settle = Effect.sleep("20 millis");
    return {
      release,
      events,
      live,
      reads,
      finished,
      observations,
      lifecycle,
      settle,
      settled,
      hangUnobserve: () => {
        hangingUnobserve = true;
      },
      unobserved: () => unobserved,
    };
  });

  it.live("cancellation releases only the exact Run presentation of the current process", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.release.observe(proof("root"));
      yield* f.release.observe(proof("child"));
      yield* f.lifecycle(1, "root", "cancelled", { generation: "previous" });
      yield* f.lifecycle(2, "child", "completed");
      yield* f.lifecycle(3, "root", "cancelled");
      yield* f.settle;
      assert.deepEqual(f.observations, ["root/run", "child/run"]);
      assert.deepEqual(f.finished, [["run", "root", "run"]]);
      assert.deepEqual(f.reads, ["root", "child"]);
    }).pipe(Effect.scoped),
  );

  it.live("a cancellation delivered before the presentation existed still releases it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.live.delete("root");
      yield* f.release.observe(proof("root"));
      assert.deepEqual(f.finished, [["run", "root", "run"]]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a closed native source releases its presentations and stream loss releases the lease",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const [delivery, runtimeGeneration] of [
          [1, "previous"],
          [2, "generation"],
        ] as const)
          yield* PubSub.publish(f.events, {
            delivery,
            notification: {
              type: "execution.native-session.closed",
              runtimeId: "runtime",
              runtimeGeneration,
              providerSessionId: "provider-session",
              nativeGeneration: 1,
              incarnationId: "incarnation:one",
            },
          });
        yield* f.settle;
        assert.deepEqual(f.finished, [
          [
            "source",
            {
              runtimeId: "runtime",
              runtimeGeneration: "generation",
              providerSessionId: "provider-session",
              nativeGeneration: 1,
            },
          ],
        ]);
        yield* PubSub.shutdown(f.events);
        yield* Deferred.await(f.settled).pipe(Effect.timeout(ASYNC_WAIT_TIMEOUT_MS));
        assert.deepEqual(f.finished.at(-1), ["lease", "runtime", "generation"]);
      }).pipe(Effect.scoped),
  );

  it.effect("a lost unobserve reply cannot hold up presentation teardown", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const f = yield* fixture.pipe(Effect.provideService(Scope.Scope, scope));
      f.hangUnobserve();
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(closing);
    }),
  );
});

describe("AgentRuntimeUserInputAutoResolution", () => {
  const make = makeAgentRuntimeUserInputAutoResolution;
  type Request = AgentSnapshot["projection"]["runtimeRequests"][number];
  const question = (id: string, overrides: Partial<Request> = {}): Request => ({
    id,
    nodeId: `node:${id}`,
    providerTurnId: "provider-turn",
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "native-session" },
    createdAt: "2026-10-27T00:00:00.000Z",
    resolvedAt: null,
    isBlocking: false,
    ...overrides,
  });

  const fixture = Effect.fn("RuntimeQuestionDeadlineTest.fixture")(function* (
    initial: readonly Request[],
    foreground = false,
  ) {
    const presentation = yield* makePresentation;
    presentation.setClientForegrounded("window", foreground);
    presentation.setPresented("root", "window", "surface", true);
    const deadlines = yield* makeDeadlines.pipe(
      Effect.provideService(CodexRendererPresentationRegistry, presentation),
    );
    const transitions = yield* PubSub.unbounded<AgentRuntimeActivityTransition>();
    const bridge = yield* make({ transitions: Stream.fromPubSub(transitions) }).pipe(
      Effect.provideService(CodexUserInputAutoResolution, deadlines),
    );
    let pending = initial;
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const connection: AgentRuntimeProcessConnection = {
      identity: {
        runtimeId: "runtime",
        runtimeGeneration: "generation",
        schemaVersion: 1,
        databasePath: "/unused/runtime.sqlite",
        mcpEndpoint: "http://localhost:1/mcp",
        lastSequence: 0,
      },
      terminated: Effect.never,
      notifications: Stream.never,
      subscribeNotifications: Effect.succeed(Stream.never),
      liveness: Stream.make("ready" as const),
      subscribeExecutionNotifications: Effect.succeed(Stream.never),
      request: ((method: string, input: unknown) =>
        Effect.sync(() => {
          calls.push({ method, input });
          if (method === "thread.control")
            return { projection: { runtimeRequests: pending }, snapshotSequence: 0 };
          if (method === "command.dispatch") return { sequence: 1 };
          if (method !== "execution.activity") throw new Error(`Unexpected method ${method}`);
          return {
            snapshotSequence: 0,
            items: [{ rootThreadId: "root", pendingRequestCount: pending.length }],
            nextCursor: null,
          };
        })) as AgentRuntimeProcessConnection["request"],
    };
    const generationScope = yield* Scope.make();
    yield* bridge.attach(connection).pipe(Effect.provideService(Scope.Scope, generationScope));
    const retire = () => {
      pending = [];
      return PubSub.publish(transitions, {
        connection,
        rootThreadId: "root",
        sessionId: "session",
        before: null,
        after: null,
        endedRun: null,
      });
    };
    return {
      calls,
      deadlines,
      retire,
      close: Scope.close(generationScope, Exit.void),
      dispatched: () => calls.filter(({ method }) => method === "command.dispatch"),
    };
  });

  it.effect("resolves only live nonblocking questions through their original Runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture([
        question("optional"),
        question("blocking", { isBlocking: true }),
        question("async", { responseCapability: { type: "message" } }),
      ]);
      assert.strictEqual((yield* f.deadlines.snapshot)[0]?.requestId, "optional");
      yield* TestClock.adjust("90 seconds");
      assert.deepEqual(f.dispatched(), [
        {
          method: "command.dispatch",
          input: {
            command: {
              type: "runtime-request.respond",
              commandId: "auto-user-input:optional",
              threadId: "root",
              requestId: "optional",
              answers: {},
            },
          },
        },
      ]);
      assert.deepEqual(f.calls.filter(({ method }) => method === "thread.control").at(-1), {
        method: "thread.control",
        input: { threadId: "root", requestId: "optional" },
      });
      assert.isTrue(
        f.calls.every(({ method }) =>
          ["execution.activity", "thread.control", "command.dispatch"].includes(method),
        ),
      );
      yield* f.close;
    }),
  );

  it.effect("uses foreground inactivity and the shared question-interaction snooze", () =>
    Effect.gen(function* () {
      const f = yield* fixture([question("optional")], true);
      assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "waitingForInactivity");
      yield* TestClock.adjust("59 seconds");
      yield* f.deadlines.recordActivity({ hostId: "local", conversationId: "root" });
      yield* TestClock.adjust("59 seconds");
      assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "waitingForInactivity");
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "scheduled");
      assert.isTrue(
        yield* f.deadlines.snooze({
          hostId: "local",
          conversationId: "root",
          requestId: "optional",
        }),
      );
      yield* TestClock.adjust("5 minutes");
      assert.isEmpty(f.dispatched());
      assert.strictEqual((yield* f.deadlines.snapshot)[0]?.phase.type, "snoozed");
      yield* f.close;
    }),
  );

  it.effect("retires deadlines with the request or its process generation", () =>
    Effect.gen(function* () {
      const retired = yield* fixture([question("retired")]);
      yield* retired.retire();
      yield* Effect.yieldNow;
      assert.isEmpty(yield* retired.deadlines.snapshot);
      yield* TestClock.adjust("90 seconds");
      assert.isEmpty(retired.dispatched());
      yield* retired.close;

      const disconnected = yield* fixture([question("disconnected")]);
      yield* disconnected.close;
      assert.isEmpty(yield* disconnected.deadlines.snapshot);
      yield* TestClock.adjust("90 seconds");
      assert.isEmpty(disconnected.dispatched());
    }),
  );
});

describe("AgentRuntimeExecutionChanges", () => {
  const fixture = Effect.gen(function* () {
    const events = yield* PubSub.sliding<AgentRuntimeProcessDelivery>(64);
    const closed = yield* Deferred.make<void>();
    let subscriptions = 0;
    const connection = {
      terminated: Deferred.await(closed),
      liveness: Stream.make("ready" as const),
      subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            subscriptions += 1;
          }),
        ),
        Effect.map(Stream.fromSubscription),
      ),
    } as AgentRuntimeProcessConnection;
    const publish = PubSub.publish(events, {
      delivery: 1,
      notification: {
        type: "execution.lifecycle",
        subscriptionId: "lifecycle",
        runtimeGeneration: "generation",
        sequence: 1,
        threadId: "root",
        eventType: "run.updated",
        runStatus: "completed",
      },
    });
    return {
      connection,
      publish,
      close: Deferred.succeed(closed, undefined),
      subscriptions: () => subscriptions,
    };
  });

  it.effect(
    "invalidates lost execution and acquires a fresh generation without transcript reads",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture;
        const next = yield* fixture;
        let connects = 0;
        const observed = yield* Deferred.make<void>();
        const events = yield* subscribe(
          Effect.sync(() => (++connects === 1 ? first.connection : next.connection)),
        );
        const result = yield* events.pipe(
          Stream.tap(() => Deferred.succeed(observed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* first.publish;
        yield* Deferred.await(observed);
        yield* first.close;
        yield* TestClock.adjust("250 millis");
        assert.strictEqual((yield* Fiber.join(result)).length, 3);
        assert.strictEqual(connects, 2);
        assert.strictEqual(next.subscriptions(), 1);
      }),
  );
});

describe("ChatMessageDelivery", () => {
  const make = makeChatMessageDelivery;
  const fixture = (managed: boolean) =>
    Effect.gen(function* () {
      const writes: ProjectWorkspaceApplyInput[] = [];
      const record = yield* make.pipe(
        Effect.provideService(CoreModules, {
          workspace: {
            read: () => Effect.succeed({ value: { kind: "session", session: { managed } } }),
            apply: (command: ProjectWorkspaceApplyInput) =>
              Effect.sync(() => {
                writes.push(command);
                return {};
              }),
          },
        } as never),
      );
      return { writes, record };
    });
  it.effect("fences question answers even before an unmanaged chat becomes managed", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      yield* f
        .record("chat", { messageId: "ordinary", text: "Hello" })
        .pipe(Effect.provideService(CoreApplicationAgent, null));
      assert.isEmpty(f.writes);
      yield* f
        .record(
          "chat",
          { messageId: "answer", text: "Yes" },
          {
            question: { runId: "answered-run", requestId: "question" },
          },
        )
        .pipe(Effect.provideService(CoreApplicationAgent, null));
      assert.deepInclude(f.writes[0]!.intent, {
        delivery_id: "answer",
        question_answer_run_id: "answered-run",
        question_answer_request_id: "question",
      });
    }),
  );
});
