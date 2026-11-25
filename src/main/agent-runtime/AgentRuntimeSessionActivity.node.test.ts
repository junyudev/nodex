import { describe, expect, vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import type {
  AgentRootActivity,
  AgentRuntimeNotification,
  AgentRuntimeOperations,
  AgentRuntimeMethod,
} from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeSessionActivity as SessionActivity,
  AgentRuntimeSessionActivityChange,
} from "../../shared/agent-runtime-api";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import { make, type AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import {
  type AgentRuntimeApplicationConnection,
  AgentRuntimeApplication,
} from "./AgentRuntimeApplication";
import { make as makeAgentRuntimeSessionOrdering } from "./AgentRuntimeSessionOrdering";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { makeSessionObservation } from "./AgentRuntimeSessionObservation";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { make as makeAgentRuntimeQuiescence, reportsNoWork } from "./AgentRuntimeQuiescence";
import { readPromptTurns } from "./AgentRuntimePromptTurns";

describe("AgentRuntimeSessionActivity", () => {
  const root = (
    rootThreadId: string,
    status: AgentRootActivity["status"],
    overrides: Partial<AgentRootActivity> = {},
  ): AgentRootActivity => ({
    rootThreadId,
    status,
    hasWork: status !== "waiting",
    awaitingCommands: false,
    activeRunId: status === "background" ? null : `run:${rootThreadId}`,
    pendingRequestCount: status === "waiting" ? 1 : 0,
    backgroundTasks: [],
    providerInstanceId: "codex",
    model: "gpt",
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  });

  /** A fake execution process whose activity table and observation stream tests control. */
  const fakeRuntime = (generation: string) =>
    Effect.gen(function* () {
      const roots = new Map<string, AgentRootActivity>();
      const requests: Array<{ readonly method: string; readonly input: unknown }> = [];
      const notifications = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
      let delivery = 0;
      let sequence = 0;
      const emit = (notification: AgentRuntimeNotification, skip = 0) =>
        Effect.gen(function* () {
          delivery += 1 + skip;
          yield* PubSub.publish(notifications, { delivery, notification });
        });
      const connection: AgentRuntimeProcessConnection = {
        identity: {
          runtimeId: "runtime",
          runtimeGeneration: generation,
          schemaVersion: 1,
          databasePath: "/tmp/runtime.sqlite",
          mcpEndpoint: "http://localhost:1/mcp",
          lastSequence: 0,
        },
        terminated: Effect.never,
        notifications: Stream.empty,
        subscribeNotifications: Effect.succeed(Stream.empty),
        liveness: Stream.make("ready" as const),
        subscribeExecutionNotifications: PubSub.subscribe(notifications).pipe(
          Effect.map(Stream.fromSubscription),
        ),
        request: ((method: string, input: never) =>
          Effect.sync(() => {
            requests.push({ method, input });
            if (method === "execution.observe")
              return {
                subscribed: true,
                subscriptionId: `observation:${generation}`,
                afterSequence: 0,
              };
            if (method === "events.unobserve") return { unsubscribed: true };
            if (method !== "execution.activity") throw new Error(`Unexpected ${method}`);
            const request = input as {
              readonly cursor?: string;
              readonly limit?: number;
              readonly rootThreadIds?: readonly string[];
            };
            if (request.rootThreadIds)
              return {
                snapshotSequence: sequence,
                items: request.rootThreadIds.flatMap((id) => roots.get(id) ?? []),
                nextCursor: null,
              };
            const all = [...roots.values()];
            const start = Number(request.cursor ?? 0);
            const end = start + (request.limit ?? 200);
            return {
              snapshotSequence: sequence,
              items: all.slice(start, end),
              nextCursor: end < all.length ? String(end) : null,
            };
          })) as unknown as AgentRuntimeProcessConnection["request"],
      };
      /** Commits a root's next activity and emits its compact change notification. */
      const commit = (rootThreadId: string, next: AgentRootActivity | null, skip = 0) =>
        Effect.gen(function* () {
          sequence += 1;
          if (next) roots.set(rootThreadId, next);
          else roots.delete(rootThreadId);
          yield* emit({ type: "activity", rootThreadId, sequence }, skip);
        });
      const finishRun = (rootThreadId: string, runId: string, runStatus: string) =>
        emit({
          type: "execution.lifecycle",
          subscriptionId: `observation:${generation}`,
          runtimeGeneration: generation,
          sequence: ++sequence,
          threadId: rootThreadId,
          eventType: "run.updated",
          runId,
          runStatus: runStatus as never,
        });
      return { connection, roots, requests, commit, finishRun };
    });

  const fixture = (bindings: Readonly<Record<string, string>>, changeCapacity?: number) =>
    Effect.gen(function* () {
      const resolved: string[] = [];
      const activity = yield* make({
        resolveSessions: (_runtimeId, rootThreadIds) =>
          Effect.sync(() => {
            resolved.push(...rootThreadIds);
            return new Map(
              rootThreadIds.flatMap((id) => (bindings[id] ? [[id, bindings[id]] as const] : [])),
            );
          }),
        coalesce: "1 millis",
        pageSize: 2,
        changeCapacity,
      });
      const changes: AgentRuntimeSessionActivityChange[] = [];
      const transitions: AgentRuntimeActivityTransition[] = [];
      yield* activity.activityChanges.pipe(
        Stream.runForEach((change) => Effect.sync(() => changes.push(change))),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* activity.transitions.pipe(
        Stream.runForEach((transition) => Effect.sync(() => transitions.push(transition))),
        Effect.forkScoped({ startImmediately: true }),
      );
      const until = (condition: () => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 400 && !condition(); attempt += 1)
            yield* Effect.sleep("5 millis");
          assert.isTrue(condition(), `condition was not reached: ${JSON.stringify(changes)}`);
        });
      const attach = (connection: AgentRuntimeProcessConnection) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* activity.attach(connection).pipe(Effect.provideService(Scope.Scope, scope));
          return scope;
        });
      return { activity, changes, transitions, resolved, until, attach };
    });

  it.live("reports an empty complete snapshot without any execution process", () =>
    Effect.gen(function* () {
      const f = yield* fixture({});
      assert.deepEqual(yield* f.activity.read, { sequence: 0, items: [], complete: true });
    }).pipe(Effect.scoped),
  );

  it.live("follows running, waiting, background and idle with ordered Session changes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ "thread:a": "session:a" });
      const runtime = yield* fakeRuntime("1");
      yield* f.attach(runtime.connection);
      yield* f.until(() => f.changes.some((change) => change.type === "reset"));
      yield* runtime.commit("thread:a", root("thread:a", "running"));
      yield* f.until(() => f.changes.some((change) => change.type === "upsert"));
      yield* runtime.commit("thread:a", root("thread:a", "waiting"));
      yield* f.until(() => f.changes.length === 3);
      yield* runtime.finishRun("thread:a", "run:thread:a", "completed");
      yield* runtime.commit("thread:a", root("thread:a", "background"));
      yield* f.until(() => f.changes.length === 4);
      const background = yield* f.activity.read;
      assert.deepEqual(
        background.items.map((item) => [item.sessionId, item.threadId, item.status]),
        [["session:a", "thread:a", "background"]],
      );
      yield* runtime.commit("thread:a", null);
      yield* f.until(() => f.changes.length === 5);
      assert.deepEqual(
        f.changes.map((change) =>
          change.type === "upsert" ? change.activity.status : change.type,
        ),
        ["reset", "running", "waiting", "background", "remove"],
      );
      const sequences = f.changes.map((change) => change.sequence);
      assert.deepEqual(
        sequences,
        [...sequences].sort((left, right) => left - right),
      );
      assert.deepEqual((yield* f.activity.read).items, []);
      assert.deepEqual(
        f.transitions.map((transition) => [
          transition.before?.status ?? "idle",
          transition.after?.status ?? "idle",
          transition.endedRun,
        ]),
        [
          ["idle", "running", null],
          ["running", "waiting", null],
          ["waiting", "background", { runId: "run:thread:a", status: "completed" }],
          ["background", "idle", null],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "publishes structural background roster changes even when activity scalars stay equal",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "thread:a": "session:a" });
        const runtime = yield* fakeRuntime("1");
        yield* f.attach(runtime.connection);
        yield* f.until(() => f.changes.some((change) => change.type === "reset"));
        const task: AgentRootActivity["backgroundTasks"][number] = {
          threadId: "child",
          threadTitle: "Deploy",
          taskId: "shell",
          kind: "command",
          description: "Dev server",
          command: "vp run dev",
          startedAt: "2026-10-15T09:00:00.000Z",
          runId: null,
        };
        const base = root("thread:a", "background", { backgroundTasks: [task] });
        yield* runtime.commit("thread:a", base);
        yield* f.until(() => f.changes.length === 2);
        assert.deepEqual((yield* f.activity.read).items[0]?.backgroundTasks, [task]);
        const reads = runtime.requests.length;
        yield* runtime.commit("thread:a", { ...base, backgroundTasks: [{ ...task }] });
        yield* f.until(() => runtime.requests.length > reads);
        const changed = { ...task, command: "vp run build", threadTitle: "Build" };
        yield* runtime.commit("thread:a", { ...base, backgroundTasks: [changed] });
        yield* f.until(() => f.changes.length === 3);
        assert.deepEqual((yield* f.activity.read).items[0]?.backgroundTasks, [changed]);
        yield* runtime.commit("thread:a", { ...base, backgroundTasks: [] });
        yield* f.until(() => f.changes.length === 4);
        assert.deepEqual(
          f.changes.flatMap((change) =>
            change.type === "upsert" ? [change.activity.backgroundTasks] : [],
          ),
          [[task], [changed], []],
        );
      }).pipe(Effect.scoped),
  );

  it.live("a replacement process resets the projection and reloads its live roots", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ "thread:a": "session:a" });
      const first = yield* fakeRuntime("1");
      first.roots.set("thread:a", root("thread:a", "running"));
      const scope = yield* f.attach(first.connection);
      yield* f.until(() => f.changes.length === 1);
      assert.strictEqual((yield* f.activity.read).items.length, 1);
      yield* Scope.close(scope, Exit.void);
      yield* f.until(() => f.changes.filter((change) => change.type === "reset").length === 2);
      assert.deepEqual((yield* f.activity.read).items, []);
      const second = yield* fakeRuntime("2");
      second.roots.set("thread:a", root("thread:a", "background"));
      yield* f.attach(second.connection);
      yield* f.until(() => f.changes.filter((change) => change.type === "reset").length === 3);
      assert.deepEqual(
        (yield* f.activity.read).items.map((item) => item.status),
        ["background"],
      );
      // A process change is not a Run completion.
      assert.deepEqual(f.transitions, []);
    }).pipe(Effect.scoped),
  );

  it.live("a delivery gap rereads every live root and still announces what changed", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ "thread:a": "session:a" });
      const runtime = yield* fakeRuntime("1");
      yield* f.attach(runtime.connection);
      yield* f.until(() => f.changes.length === 1);
      yield* runtime.commit("thread:a", root("thread:a", "running"));
      yield* f.until(() => f.changes.some((change) => change.type === "upsert"));
      yield* runtime.commit("thread:a", root("thread:a", "waiting"), 3);
      yield* f.until(() => f.changes.filter((change) => change.type === "reset").length === 2);
      assert.deepEqual(
        (yield* f.activity.read).items.map((item) => item.status),
        ["waiting"],
      );
      assert.deepEqual(
        f.transitions.map((transition) => transition.after?.status),
        ["running", "waiting"],
      );
      // Only the change observed live is first-hand; the gap's reread is a replay.
      assert.deepEqual(
        f.transitions.map((transition) => transition.replay ?? false),
        [false, true],
      );
    }).pipe(Effect.scoped),
  );

  it.live("idle Sessions cost no Runtime or Core reads; only notified roots are point-read", () =>
    Effect.gen(function* () {
      const bindings = Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`thread:${index}`, `session:${index}`]),
      );
      const f = yield* fixture(bindings);
      const runtime = yield* fakeRuntime("1");
      for (const id of ["thread:1", "thread:2", "thread:3"])
        runtime.roots.set(id, root(id, "running"));
      yield* f.attach(runtime.connection);
      yield* f.until(() => f.changes.length === 1);
      assert.strictEqual((yield* f.activity.read).items.length, 3);
      yield* runtime.commit("thread:2", null);
      yield* f.until(() => f.changes.length === 2);
      const reads = runtime.requests.filter((request) => request.method === "execution.activity");
      // Two full pages for three live roots, then one point read for the notified root.
      assert.deepEqual(
        reads.map((request) => request.input),
        [{ limit: 2 }, { limit: 2, cursor: "2" }, { rootThreadIds: ["thread:2"] }],
      );
      assert.sameMembers(f.resolved, ["thread:1", "thread:2", "thread:3"]);
    }).pipe(Effect.scoped),
  );

  it.live("a root without a Session binding stays hidden until Core binds it", () =>
    Effect.gen(function* () {
      const bindings: Record<string, string> = {};
      const f = yield* fixture(bindings);
      const runtime = yield* fakeRuntime("1");
      yield* f.attach(runtime.connection);
      yield* f.until(() => f.changes.length === 1);
      yield* runtime.commit("thread:new", root("thread:new", "running"));
      yield* f.until(() => f.resolved.length === 1);
      assert.deepEqual((yield* f.activity.read).items, []);
      bindings["thread:new"] = "session:new";
      yield* runtime.commit("thread:new", root("thread:new", "waiting"));
      yield* f.until(() => f.changes.some((change) => change.type === "upsert"));
      assert.deepEqual(
        (yield* f.activity.read).items.map((item) => item.sessionId),
        ["session:new"],
      );
    }).pipe(Effect.scoped),
  );

  it.live("a slow activity observer resets after overflow without blocking other windows", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        { "thread:a": "session:a", "thread:b": "session:b", "thread:c": "session:c" },
        2,
      );
      const paused = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const observed: AgentRuntimeSessionActivityChange[] = [];
      let projection = new Map<string, SessionActivity>();
      let appliedSequence = -1;
      yield* f.activity.activityChanges.pipe(
        Stream.runForEach((change) =>
          Effect.gen(function* () {
            observed.push(change);
            if (change.sequence > appliedSequence) {
              if (change.type === "reset") {
                const snapshot = yield* f.activity.read;
                appliedSequence = snapshot.sequence;
                projection = new Map(snapshot.items.map((item) => [item.sessionId, item]));
              } else {
                appliedSequence = change.sequence;
                if (change.type === "upsert")
                  projection.set(change.activity.sessionId, change.activity);
                else projection.delete(change.sessionId);
              }
            }
            if (observed.length !== 1) return;
            yield* Deferred.succeed(paused, undefined);
            yield* Deferred.await(resume);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const runtime = yield* fakeRuntime("1");
      runtime.roots.set("thread:a", root("thread:a", "running"));
      yield* f.attach(runtime.connection);
      yield* Deferred.await(paused);
      assert.isTrue(projection.has("session:a"));

      const updates = [
        ["thread:a", null],
        ["thread:b", root("thread:b", "running")],
        ["thread:b", root("thread:b", "waiting")],
        ["thread:b", root("thread:b", "background")],
        ["thread:c", root("thread:c", "running")],
      ] as const;
      for (const [index, [threadId, next]] of updates.entries()) {
        yield* runtime.commit(threadId, next);
        yield* f.until(() => f.changes.length === index + 2);
      }
      // The fast observer and canonical snapshot advance while the other window remains paused.
      assert.strictEqual(observed.length, 1);
      assert.deepEqual(
        f.changes.map((change) => change.type),
        ["reset", "remove", "upsert", "upsert", "upsert", "upsert"],
      );
      const snapshot = yield* f.activity.read;
      yield* Deferred.succeed(resume, undefined);
      yield* f.until(() => observed.at(-1)?.sequence === snapshot.sequence);
      assert.deepEqual(
        observed.map((change) => change.type),
        ["reset", "reset", "upsert"],
      );
      assert.deepEqual([...projection.values()], snapshot.items);
      assert.isFalse(projection.has("session:a"));
    }).pipe(Effect.scoped),
  );

  it.live(
    "publishes approval attention and action changes without another policy or transcript read",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "thread:a": "session:a" });
        const runtime = yield* fakeRuntime("1");
        yield* f.attach(runtime.connection);
        yield* f.until(() => f.changes.length === 1);
        const approval = root("thread:a", "waiting", {
          activeFlags: ["waitingOnApproval"],
          approvalPrompt: "git push",
        });
        yield* runtime.commit("thread:a", approval);
        yield* f.until(() => f.changes.length === 2);
        assert.deepInclude((yield* f.activity.read).items[0], {
          activeFlags: ["waitingOnApproval"],
          approvalPrompt: "git push",
        });
        yield* runtime.commit("thread:a", { ...approval, approvalPrompt: "curl example.com" });
        yield* f.until(() => f.changes.length === 3);
        assert.equal((yield* f.activity.read).items[0]?.approvalPrompt, "curl example.com");
        yield* runtime.commit("thread:a", {
          ...approval,
          activeFlags: ["waitingOnUserInput"],
          approvalPrompt: null,
        });
        yield* f.until(() => f.changes.length === 4);
        assert.deepEqual((yield* f.activity.read).items[0]?.activeFlags, ["waitingOnUserInput"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "maps readback in snapshots and publishes every readback field change without scalar activity changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "thread:a": "session:a" });
        const runtime = yield* fakeRuntime("1");
        const base = root("thread:a", "running");
        yield* runtime.commit("thread:a", base);
        yield* f.attach(runtime.connection);
        yield* f.until(() => f.changes.some((change) => change.type === "reset"));
        const readbacks = [
          {
            runId: base.activeRunId!,
            itemId: "opening",
            text: "I'll inspect the build.",
            startedByPerson: true,
          },
          {
            runId: base.activeRunId!,
            itemId: "opening",
            text: "I'll inspect the build.",
            startedByPerson: false,
          },
          {
            runId: base.activeRunId!,
            itemId: "opening",
            text: "I'll inspect the tests.",
            startedByPerson: false,
          },
          {
            runId: base.activeRunId!,
            itemId: "other",
            text: "I'll inspect the tests.",
            startedByPerson: false,
          },
          {
            runId: "other-run",
            itemId: "other",
            text: "I'll inspect the tests.",
            startedByPerson: false,
          },
          null,
        ];
        for (const [index, readback] of readbacks.entries()) {
          yield* runtime.commit("thread:a", { ...base, readback });
          yield* f.until(() => f.changes.length === index + 2);
          assert.deepEqual((yield* f.activity.read).items[0]?.readback, readback);
          const change = f.changes.at(-1);
          assert.equal(change?.type, "upsert");
          if (change?.type === "upsert") assert.deepEqual(change.activity.readback, readback);
        }
        // Structurally equal facts cause no extra transition.
        yield* runtime.commit("thread:a", { ...base, readback: { ...readbacks[0]! } });
        yield* f.until(() => f.changes.length === 8);
        const before = f.transitions.length;
        yield* runtime.commit("thread:a", { ...base, readback: { ...readbacks[0]! } });
        yield* runtime.commit("thread:a", {
          ...base,
          status: "waiting",
          readback: { ...readbacks[0]! },
        });
        yield* f.until(() => f.changes.length === 9);
        assert.equal(f.transitions.length, before + 1);
      }).pipe(Effect.scoped),
  );
  it.live("keeps a queued chat's start across live states and resets it after idle", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ "thread:a": "session:a" });
      const runtime = yield* fakeRuntime("1");
      const start = "2026-10-15T09:00:00.000Z";
      const nextStart = "2026-10-15T10:00:00.000Z";
      runtime.roots.set(
        "thread:a",
        root("thread:a", "queued", {
          activeRunId: null,
          startedAt: start,
          queuePosition: 1,
        }),
      );
      yield* f.attach(runtime.connection);
      yield* f.until(() => f.changes.length === 1);
      assert.equal((yield* f.activity.read).items[0]?.startedAt, start);
      for (const [index, state] of (["running", "waiting", "background"] as const).entries()) {
        yield* runtime.commit("thread:a", root("thread:a", state, { startedAt: nextStart }));
        yield* f.until(() => f.changes.length === index + 2);
        assert.equal((yield* f.activity.read).items[0]?.startedAt, start);
      }
      yield* runtime.commit("thread:a", null);
      yield* f.until(() => f.changes.length === 5);
      yield* runtime.commit("thread:a", root("thread:a", "running", { startedAt: nextStart }));
      yield* f.until(() => f.changes.length === 6);
      assert.equal((yield* f.activity.read).items[0]?.startedAt, nextStart);
    }).pipe(Effect.scoped),
  );
});

describe("AgentRuntimeSessionOrdering", () => {
  const make = makeAgentRuntimeSessionOrdering;
  const fixture = (options: { failRelay?: boolean } = {}) => {
    const calls: string[] = [];
    const applied: ProjectWorkspaceApplyInput[] = [];
    const catalogInputs: AgentRuntimeOperations["sessions.catalog"]["input"][] = [];
    const pages: Array<{ threadId: string; latestUserAuthoredMessageAt: string | null }[]> = [];
    const bindings = new Map([
      ["root:one", "session:one"],
      ["root:two", "session:two"],
    ]);
    const observed = new Map<string, number>();
    const connection: AgentRuntimeApplicationConnection = {
      identity: {
        runtimeId: "runtime",
        runtimeGeneration: "generation",
        schemaVersion: 1,
        databasePath: "/unused",
        mcpEndpoint: "http://unused",
        lastSequence: 0,
      },
      request: (method, input) =>
        Effect.sync(() => {
          calls.push(method);
          if (method === "sessions.catalog") {
            const query = input as AgentRuntimeOperations["sessions.catalog"]["input"];
            catalogInputs.push(query);
            const index = query.cursor ? Number(query.cursor) : 0;
            return {
              items: pages[index] ?? [],
              nextCursor: index + 1 < pages.length ? String(index + 1) : null,
            } as AgentRuntimeOperations[typeof method]["output"];
          }
          return { sequence: 17 } as AgentRuntimeOperations[typeof method]["output"];
        }),
    };
    const owner = make().pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: ProjectWorkspaceRead) =>
            Effect.sync(() => {
              calls.push("resolve");
              if (
                input.kind !== "agent_runtime_session_ids_by_execution" ||
                input.runtime_id !== "runtime"
              )
                throw new Error("Expected a batched read of Runtime Session bindings");
              const sessionIds = input.runtime_thread_ids.flatMap((root) => {
                const session = bindings.get(root);
                return session ? [[root, session] as const] : [];
              });
              return {
                value: {
                  kind: "agent_runtime_session_ids_by_execution",
                  session_ids: Object.fromEntries(sessionIds),
                },
              };
            }),
          apply: (input: ProjectWorkspaceApplyInput) =>
            Effect.gen(function* () {
              assert.isNull(yield* CoreApplicationAgent);
              calls.push("relay");
              if (options.failRelay) return yield* Effect.fail("Core unavailable");
              applied.push(input);
              if (input.intent.kind === "record_session_activity")
                for (const entry of input.intent.entries) {
                  observed.set(
                    entry.session_id,
                    Math.max(observed.get(entry.session_id) ?? 0, entry.at_ms),
                  );
                }
              return {};
            }),
        },
      } as never),
    );
    return { owner, connection, calls, applied, pages, catalogInputs, observed };
  };

  it.effect("reconciliation pages only bound roots, skips absent clocks, and is idempotent", () =>
    Effect.gen(function* () {
      const test = fixture();
      const owner = yield* test.owner;
      test.pages.push(
        [
          { threadId: "root:one", latestUserAuthoredMessageAt: "2026-01-01T00:00:00.000Z" },
          { threadId: "unknown", latestUserAuthoredMessageAt: "2026-01-02T00:00:00.000Z" },
          { threadId: "empty", latestUserAuthoredMessageAt: null },
        ],
        [{ threadId: "root:two", latestUserAuthoredMessageAt: "2026-02-01T00:00:00.000Z" }],
      );
      yield* owner.reconcile(test.connection);
      const before = [...test.observed];
      assert.deepEqual(before, [
        ["session:one", Date.parse("2026-01-01T00:00:00.000Z")],
        ["session:two", Date.parse("2026-02-01T00:00:00.000Z")],
      ]);
      assert.deepEqual(test.catalogInputs, [
        { limit: 100, includeSubagents: false },
        { cursor: "1", limit: 100, includeSubagents: false },
      ]);
      yield* owner.reconcile(test.connection);
      assert.deepEqual([...test.observed], before);
      assert.deepEqual(new Set(test.calls), new Set(["sessions.catalog", "resolve", "relay"]));
    }),
  );

  it.effect("a Core failure leaves reconciliation for the next Runtime connection", () =>
    Effect.gen(function* () {
      const test = fixture({ failRelay: true });
      const owner = yield* test.owner;
      test.pages.push([
        { threadId: "root:one", latestUserAuthoredMessageAt: "2026-01-01T00:00:00.000Z" },
      ]);
      yield* owner.reconcile(test.connection);
      assert.include(test.calls, "relay");
      assert.deepEqual(test.applied, []);
    }),
  );
});

describe("AgentRuntimeSessionObservation", () => {
  const observerFixture = Effect.gen(function* () {
    const notifications = yield* Queue.unbounded<AgentRuntimeProcessDelivery>();
    const observing = yield* Deferred.make<void>();
    const reply = yield* Deferred.make<AgentRuntimeOperations["events.observe"]["output"]>();
    const released: string[] = [];
    const connection = {
      identity: { runtimeId: "runtime" },
      subscribeNotifications: Effect.succeed(Stream.fromQueue(notifications)),
      terminated: Effect.never,
      request: (method: AgentRuntimeMethod, input: unknown) => {
        if (method === "events.observe")
          return Deferred.succeed(observing, undefined).pipe(Effect.andThen(Deferred.await(reply)));
        if (method !== "events.unobserve") throw new Error(`Unexpected request ${method}`);
        return Effect.sync(() => {
          released.push(
            (input as AgentRuntimeOperations["events.unobserve"]["input"]).subscriptionId,
          );
          return { unsubscribed: true } as const;
        });
      },
    } as unknown as AgentRuntimeProcessConnection;
    const observe = yield* makeSessionObservation.pipe(
      Effect.provideService(AgentRuntimeSupervisor, {
        get: () => Effect.succeed(connection),
      } as unknown as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () =>
          Effect.succeed({
            sessionId: "session",
            projectId: null,
            runtimeId: "runtime",
            rootThreadId: "thread",
            threadId: "thread",
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
    );
    return { observe, observing, reply, released, notifications };
  });

  it.effect("a watcher can leave while execution has not answered its observe", () =>
    Effect.gen(function* () {
      const { observe, observing, released } = yield* observerFixture;
      const reader = yield* Effect.forkChild(Stream.runDrain(observe("session", 42)));
      yield* Deferred.await(observing);
      yield* Fiber.interrupt(reader);
      // The connection releases an observer abandoned this way; see AgentRuntimeProcess.
      expect(released).toEqual([]);
    }),
  );

  it.effect("releases the subscription a watcher was given when it leaves", () =>
    Effect.gen(function* () {
      const { observe, observing, reply, released } = yield* observerFixture;
      const reader = yield* Effect.forkChild(Stream.runDrain(observe("session", 42)));
      yield* Deferred.await(observing);
      yield* Deferred.succeed(reply, {
        subscribed: true,
        subscriptionId: "observer",
        afterSequence: 42,
      } as const);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(reader);
      expect(released).toEqual(["observer"]);
    }),
  );

  it.effect("ends with a reset when execution stops delivering to its observer", () =>
    Effect.gen(function* () {
      const { observe, observing, reply, notifications } = yield* observerFixture;
      const reader = yield* Effect.forkChild(Stream.runCollect(observe("session", 42)));
      yield* Deferred.await(observing);
      yield* Deferred.succeed(reply, {
        subscribed: true,
        subscriptionId: "observer",
        afterSequence: 42,
      } as const);
      const event = { type: "run.updated" } as never;
      yield* Queue.offerAll(notifications, [
        { delivery: 1, notification: { type: "event", subscriptionId: "other", event } },
        { delivery: 2, notification: { type: "event", subscriptionId: "observer", event } },
        {
          delivery: 3,
          notification: { type: "event.error", subscriptionId: "observer", message: "stopped" },
        },
        { delivery: 4, notification: { type: "event", subscriptionId: "observer", event } },
      ] as unknown as AgentRuntimeProcessDelivery[]);
      // The watch does not wait on a stream that will never speak again.
      expect(Array.from(yield* Fiber.join(reader))).toEqual([
        { kind: "event", event },
        { kind: "reset" },
      ]);
    }),
  );
});

describe("AgentRuntimeQuiescence", () => {
  const make = makeAgentRuntimeQuiescence;
  const home = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-quiescence-" });
    const database = join(directory, "agent-runtime.sqlite");
    return { fs, directory, database };
  });

  it.effect("a launch starts execution unless evidence matches the stopped store exactly", () =>
    Effect.gen(function* () {
      const { fs, directory, database } = yield* home;
      const evidence = yield* make(directory);
      // A never-used Profile has nothing to resume.
      assert.isFalse(yield* evidence.startRequired);
      yield* fs.writeFileString(database, "store");
      // A store without evidence may hold work left by a crash.
      assert.isTrue(yield* evidence.startRequired);
      yield* evidence.record;
      assert.isFalse(yield* evidence.startRequired);
      // A later write, such as a restore or copy, invalidates the evidence.
      yield* fs.writeFileString(database, "restored store");
      assert.isTrue(yield* evidence.startRequired);
      yield* evidence.record;
      yield* fs.writeFileString(`${database}-wal`, "uncheckpointed");
      assert.isTrue(yield* evidence.startRequired);
      yield* evidence.record;
      assert.isFalse(yield* evidence.startRequired);
      // Starting a process clears the evidence before it can change the store.
      yield* evidence.clear;
      assert.isTrue(yield* evidence.startRequired);
      yield* fs.writeFileString(join(directory, "quiescent.json"), "{not evidence");
      assert.isTrue(yield* evidence.startRequired);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const connection = (
    activity: number,
    handoffs: number,
    fail = false,
    management = { activeOperations: 0, activeAuthentication: 0 },
  ) =>
    ({
      request: (method: string) =>
        fail
          ? Effect.fail(new Error("unsupported"))
          : Effect.succeed(
              method === "acp.activity"
                ? management
                : method === "execution.activity"
                  ? {
                      snapshotSequence: 1,
                      items: Array.from({ length: activity }, () => ({})),
                      nextCursor: null,
                    }
                  : { items: Array.from({ length: handoffs }, () => ({})), nextCursor: null },
            ),
    }) as unknown as AgentRuntimeProcessConnection;

  it.effect("execution is quiet only with no live roots and no handoff holds", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* reportsNoWork(connection(0, 0)));
      assert.isFalse(yield* reportsNoWork(connection(1, 0)));
      assert.isFalse(yield* reportsNoWork(connection(0, 1)));
      assert.isFalse(
        yield* reportsNoWork(
          connection(0, 0, false, { activeOperations: 1, activeAuthentication: 0 }),
        ),
      );
      assert.isFalse(
        yield* reportsNoWork(
          connection(0, 0, false, { activeOperations: 0, activeAuthentication: 1 }),
        ),
      );
      // An unanswerable report is never treated as quiet by the supervisor.
      assert.isTrue(Exit.isFailure(yield* reportsNoWork(connection(0, 0, true)).pipe(Effect.exit)));
    }),
  );
});

describe("AgentRuntimePromptTurns", () => {
  it.effect(
    "reads only addressed metadata and shares one complete answer for messages delivered into the same Run",
    () =>
      Effect.gen(function* () {
        const calls = vi.fn();
        const request = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ): Effect.Effect<AgentRuntimeOperations[M]["output"], unknown> => {
          calls(method, input);
          const value =
            method === "thread.message-turn"
              ? {
                  runId: "run",
                  status: "completed",
                  completedAt: "2026-10-31T00:00:00Z",
                  finalAssistantItemId: "answer",
                }
              : {
                  type: "assistant_message",
                  streaming: false,
                  status: "completed",
                  text: "**Final**\n\n" + "x".repeat(40_000),
                };
          return Effect.succeed(value as AgentRuntimeOperations[M]["output"]);
        };
        const turns = yield* readPromptTurns({ request }, "root", ["opening", "steer"]);
        expect(turns.map((turn) => [turn.messageId, turn.phase, turn.reply?.length])).toEqual([
          ["opening", "done", 40_011],
          ["steer", "done", 40_011],
        ]);
        expect(calls.mock.calls.map(([method]) => method)).toEqual([
          "thread.message-turn",
          "thread.item.full",
          "thread.message-turn",
        ]);
      }),
  );
  it.effect.each(["queued", "running", "waiting", "failed", "interrupted"] as const)(
    "does not read a reply for %s work",
    (status) =>
      Effect.gen(function* () {
        const request = vi.fn().mockReturnValue(
          Effect.succeed({
            runId: "run",
            status,
            completedAt: null,
            finalAssistantItemId: "partial",
          }),
        );
        const turns = yield* readPromptTurns({ request }, "root", ["message"]);
        expect(turns[0]?.reply).toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
      }),
  );
});
