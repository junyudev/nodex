import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { components } from "@nodex/core-protocol";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
} from "../../main/core-client/types";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { ManagedChatFacts } from "./ManagedChatFacts";
import { make } from "./CoordinatorMonitor";
import {
  MANAGED_CHAT_STALL_MS,
  type ManagedChatFacts as Facts,
  unavailableManagedChatFacts,
} from "./managed-chat-observation";
type Observer = components["schemas"]["SessionExecutionObserver"];
const working: Facts = {
  state: "working",
  runId: "run:1",
  runStartedAt: 0,
  terminalStatus: null,
  pendingRequests: [],
  progressFingerprint: "p1",
};
const observer = (session_id: string, managed = true): Observer => ({
  session_id,
  since: "2026-11-03T00:00:00Z",
  revision: 0,
  observation: null,
  managed: managed
    ? {
        session_id,
        since: "2026-11-03T00:00:00Z",
        observed_json: null,
        observed_revision: 0,
        latest_report_at: null,
        active_page_ids: [],
      }
    : null,
});
function fixture(initial: Observer[]) {
  const observers = new Map(initial.map((item) => [item.session_id, item]));
  const captures: Extract<
    ProjectWorkspaceApplyInput["intent"],
    { kind: "record_session_execution" }
  >[] = [];
  const events = new Set<string>();
  const reads: string[] = [];
  const limits: number[] = [];
  let facts: Facts = working;
  let fail = false;
  const core = {
    workspace: {
      read: (input: ProjectWorkspaceRead) =>
        Effect.sync(() => ({
          value:
            input.kind === "session_execution_observers"
              ? {
                  kind: input.kind,
                  observers: [...observers.values()]
                    .filter(
                      (item) => !input.after_session_id || item.session_id > input.after_session_id,
                    )
                    .slice(0, input.limit)
                    .map((item) => {
                      limits.push(input.limit);
                      return item;
                    }),
                }
              : {
                  kind: "session_execution_observer",
                  observer:
                    input.kind === "session_execution_observer"
                      ? (observers.get(input.session_id) ?? null)
                      : null,
                },
        })),
      apply: (input: ProjectWorkspaceApplyInput) =>
        Effect.sync(() => {
          if (fail) throw new Error("Core unavailable");
          assert.equal(input.intent.kind, "record_session_execution");
          if (input.intent.kind !== "record_session_execution") return {};
          const capture = input.intent;
          const before = observers.get(capture.session_id)!;
          assert.equal(capture.expected_revision, before.revision);
          observers.set(before.session_id, {
            ...before,
            revision: before.revision + 1,
            observation: capture.observation,
            managed:
              before.managed && capture.observation.state !== "unavailable"
                ? {
                    ...before.managed,
                    observed_json: capture.observation,
                    observed_revision: before.managed.observed_revision + 1,
                  }
                : before.managed,
          });
          captures.push(capture);
          for (const event of capture.events) events.add(event.dedupe_key);
          return {};
        }),
    },
  };
  const owner = make.pipe(
    Effect.provideService(CoreModules, core as never),
    Effect.provideService(ManagedChatFacts, {
      read: (id) =>
        Effect.sync(() => {
          reads.push(id);
          return facts;
        }),
    }),
  );
  return {
    owner,
    observers,
    captures,
    events,
    reads,
    limits,
    setFacts: (next: Facts) => {
      facts = next;
    },
    setFail: (next: boolean) => {
      fail = next;
    },
  };
}
it.effect("records unmanaged active chats, queue metadata, unavailable and failed distinctly", () =>
  Effect.gen(function* () {
    const f = fixture([observer("unmanaged", false)]);
    const monitor = yield* f.owner;
    f.setFacts({
      ...working,
      state: "queued",
      waitingAdmissions: [
        { runId: "run:1", class: "start", position: 2, waitingSince: "2026-11-03T00:00:00Z" },
      ],
    });
    yield* monitor.wake("unmanaged");
    assert.equal(f.captures[0]?.observation.state, "queued");
    assert.equal(f.captures[0]?.observation.queue?.position, 2);
    assert.equal(f.captures[0]?.observation.queue?.class, "start");
    f.setFacts({ ...working, state: "waiting", pendingRequests: [{ id: "q", kind: "question" }] });
    yield* monitor.sweep;
    assert.deepEqual(f.captures.at(-1)?.observation.pendingRequests, [
      { id: "q", kind: "question", options: [] },
    ]);
    assert.isEmpty(f.captures.at(-1)!.events);
    f.setFacts(unavailableManagedChatFacts);
    yield* monitor.sweep;
    assert.equal(f.captures.at(-1)?.observation.state, "unavailable");
    f.setFacts({ ...working, state: "failed", terminalStatus: "failed" });
    yield* monitor.sweep;
    assert.equal(f.captures.at(-1)?.observation.state, "failed");
    assert.isEmpty([...f.events]);
    const count = f.captures.length;
    yield* monitor.sweep;
    assert.equal(f.captures.length, count);
  }),
);
it.effect("keeps managed attention, stall, completion and restart events idempotent", () =>
  Effect.gen(function* () {
    const f = fixture([observer("chat")]);
    const monitor = yield* f.owner;
    yield* monitor.sweep;
    yield* TestClock.adjust(MANAGED_CHAT_STALL_MS);
    yield* monitor.sweep;
    yield* monitor.sweep;
    assert.deepEqual([...f.events], ["stalled:chat:run:1:p1"]);
    f.setFacts({ ...working, state: "waiting", pendingRequests: [{ id: "q", kind: "question" }] });
    f.setFail(true);
    yield* monitor.sweep;
    f.setFail(false);
    yield* monitor.wake("chat");
    yield* monitor.sweep;
    assert.equal(f.events.size, 2);
    f.setFacts({ ...working, state: "idle", terminalStatus: "completed" });
    yield* monitor.sweep;
    assert.deepEqual(f.captures.at(-1)?.resolved_request_ids, ["q"]);
    const restarted = yield* f.owner;
    yield* restarted.sweep;
    assert.equal(f.events.size, 3);
    f.setFacts({
      ...working,
      runId: "run:2",
      state: "failed",
      terminalStatus: "interrupted",
      interruptRequested: true,
    });
    yield* restarted.sweep;
    assert.equal(f.events.size, 3);
    assert.equal(f.captures.at(-1)?.observation.personStopped, true);
  }),
);
it.effect("initializes managed notifications after observing an unmanaged active chat", () =>
  Effect.gen(function* () {
    for (const pendingRequests of [[], [{ id: "q", kind: "question" as const }]]) {
      const f = fixture([observer("chat", false)]);
      const monitor = yield* f.owner;
      f.setFacts({
        ...working,
        state: pendingRequests.length ? "waiting" : "working",
        pendingRequests,
      });
      yield* monitor.sweep;
      assert.equal(f.captures.length, 1);
      assert.isEmpty([...f.events]);
      const before = f.observers.get("chat")!;
      f.observers.set("chat", { ...before, managed: observer("chat").managed });
      yield* monitor.sweep;
      assert.equal(f.captures.length, 2);
      assert.deepEqual([...f.events], pendingRequests.length ? ["attention:chat:q"] : []);
      yield* monitor.sweep;
      assert.equal(f.captures.length, 2);
      f.setFacts({ ...working, state: "idle", terminalStatus: "completed" });
      yield* monitor.sweep;
      assert.isTrue(f.events.has("turn_ended:chat:run:1"));
      assert.deepEqual(
        f.captures.at(-1)?.resolved_request_ids,
        pendingRequests.length ? ["q"] : [],
      );
    }
  }),
);
it.effect("does not consume unmanaged requests when the provider becomes unavailable", () =>
  Effect.gen(function* () {
    const f = fixture([observer("chat", false)]);
    const monitor = yield* f.owner;
    const waiting: Facts = {
      ...working,
      state: "waiting",
      pendingRequests: [{ id: "q", kind: "question" }],
    };
    f.setFacts(waiting);
    yield* monitor.sweep;
    f.observers.set("chat", { ...f.observers.get("chat")!, managed: observer("chat").managed });
    f.setFacts(unavailableManagedChatFacts);
    yield* monitor.sweep;
    const count = f.captures.length;
    yield* monitor.sweep;
    assert.equal(f.captures.length, count);
    assert.isEmpty([...f.events]);
    f.setFacts(waiting);
    yield* monitor.sweep;
    assert.deepEqual([...f.events], ["attention:chat:q"]);
  }),
);
it.effect("visits every observation target in bounded identity windows", () =>
  Effect.gen(function* () {
    const f = fixture(
      Array.from({ length: 123 }, (_, i) =>
        observer(`chat:${String(i).padStart(3, "0")}`, i % 2 === 0),
      ),
    );
    yield* (yield* f.owner).sweep;
    assert.equal(new Set(f.reads).size, 123);
    assert.isTrue(f.limits.every((limit) => limit === 50));
  }),
);
