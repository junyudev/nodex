import { assert, it } from "@effect/vitest";
import type { AgentRootActivity, AgentRuntimeNotification } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentRuntimeSessionActivityChange } from "../../shared/agent-runtime-api";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import { make, type AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";

const root = (
  rootThreadId: string,
  status: AgentRootActivity["status"],
  overrides: Partial<AgentRootActivity> = {},
): AgentRootActivity => ({
  rootThreadId,
  status,
  activeRunId: status === "background" ? null : `run:${rootThreadId}`,
  pendingRequestCount: status === "waiting" ? 1 : 0,
  activeTaskCount: status === "background" ? 1 : 0,
  resumesAutomatically: status === "background",
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

const fixture = (bindings: Readonly<Record<string, string>>) =>
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
      f.changes.map((change) => (change.type === "upsert" ? change.activity.status : change.type)),
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
