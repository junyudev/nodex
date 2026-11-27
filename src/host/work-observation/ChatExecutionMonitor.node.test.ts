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
import { make } from "./ChatExecutionMonitor";
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
  managed,
});
function fixture(initial: Observer[]) {
  const observers = new Map(initial.map((item) => [item.session_id, item]));
  const captures: Extract<
    ProjectWorkspaceApplyInput["intent"],
    { kind: "record_session_execution" }
  >[] = [];
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
            scopes: before.scopes?.map((watch) => ({
              ...watch,
              observation:
                capture.scoped_observations?.find(
                  (fact) =>
                    fact.scope.kind === watch.scope.kind && fact.scope.id === watch.scope.id,
                )?.observation ?? watch.observation,
            })),
            observation: Object.fromEntries(
              Object.entries(capture.observation).reverse(),
            ) as Observer["observation"],
          });
          captures.push(capture);
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
      waitingAdmissions: [{ runId: "run:1", position: 2, waitingSince: "2026-11-03T00:00:00Z" }],
    });
    yield* monitor.wake("unmanaged");
    assert.equal(f.captures[0]?.observation.state, "queued");
    assert.equal(f.captures[0]?.observation.queue?.position, 2);
    f.setFacts({ ...working, state: "waiting", pendingRequests: [{ id: "q", kind: "question" }] });
    yield* monitor.sweep;
    assert.deepEqual(f.captures.at(-1)?.observation.pendingRequests, [
      { id: "q", kind: "question", options: [] },
    ]);
    f.setFacts(unavailableManagedChatFacts);
    yield* monitor.sweep;
    assert.equal(f.captures.at(-1)?.observation.state, "unavailable");
    f.setFacts({ ...working, state: "failed", terminalStatus: "failed" });
    yield* monitor.sweep;
    assert.equal(f.captures.at(-1)?.observation.state, "failed");
    const count = f.captures.length;
    yield* monitor.sweep;
    assert.equal(f.captures.length, count);
  }),
);
it.effect("persists the latest reply once and keeps it while the owner is unavailable", () =>
  Effect.gen(function* () {
    const f = fixture([observer("chat")]);
    const monitor = yield* f.owner;
    yield* monitor.sweep;
    yield* TestClock.adjust(MANAGED_CHAT_STALL_MS);
    yield* monitor.sweep;
    assert.isTrue(f.captures.at(-1)?.observation.stalled);
    f.setFacts({
      ...working,
      state: "idle",
      terminalStatus: "completed",
      lastReplyExcerpt: "  Which option should I use?  ",
    });
    yield* monitor.sweep;
    assert.equal(f.captures.at(-1)?.observation.lastReplyExcerpt, "Which option should I use?");
    const count = f.captures.length;
    f.setFacts(unavailableManagedChatFacts);
    yield* (yield* f.owner).sweep;
    assert.equal(f.captures.length, count);
  }),
);

it.effect(
  "replays missed delivery and Run observations without republishing them on unrelated Runs",
  () =>
    Effect.gen(function* () {
      const direct = { kind: "run", id: "run:1" } as const;
      const delivery = { kind: "delivery", id: "page-delivery" } as const;
      const watch = {
        ...observer("chat"),
        scopes: [direct, delivery].map((scope) => ({ scope, observation: null })),
      };
      const f = fixture([watch]);
      const monitor = yield* f.owner;
      const scoped = [
        {
          scope: direct,
          facts: {
            ...working,
            state: "idle",
            terminalStatus: "completed",
            lastReplyExcerpt: "The Page's result",
          },
        },
        { scope: delivery, facts: { ...working, runId: "run:2" } },
      ] as const;
      f.setFacts({ ...working, runId: "later", scoped });
      f.setFail(true);
      yield* monitor.sweep;
      assert.isEmpty(f.captures);
      f.setFail(false);
      yield* monitor.sweep;
      const captured = f.captures[0]?.scoped_observations ?? [];
      assert.deepEqual(
        captured.map((current) => current.scope),
        [direct, delivery],
      );
      assert.deepInclude(captured[0]?.observation, {
        runId: "run:1",
        terminalStatus: "completed",
        lastReplyExcerpt: "The Page's result",
      });
      assert.equal(captured[1]?.observation.runId, "run:2");
      f.setFacts({ ...working, runId: "later-again", scoped });
      yield* (yield* f.owner).sweep;
      assert.isEmpty(f.captures[1]?.scoped_observations ?? []);
      assert.equal(f.captures[1]?.observation.runId, "later-again");
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
