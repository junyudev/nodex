import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import { makeSessionDetailsFixture } from "@nodex/agent-runtime/orchestration/testkit/SessionDetailsFixture";
import { layerMemory } from "../../../packages/agent-runtime/src/persistence/Sqlite";
import { readSessionDetails } from "@nodex/agent-runtime/orchestration/SessionReadDetails";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CodexThreadDirectory } from "../../main/codex-application/CodexThreadDirectory";
import { CodexNativeThreadLookup } from "../../main/codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../../main/codex-runtime/CodexGateway";
import { live as nativeManagedChatFacts } from "../../main/codex-application/NativeManagedChatFacts";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { make } from "./ManagedChatFacts";
import { diffManagedChatObservation as diff } from "./managed-chat-observation";

const runtimeSession = {
  id: "chat",
  archived: false,
  thread_id: null,
  execution_ref: { runtime_id: "runtime", thread_id: "thread" },
};
const owner = (
  core: unknown,
  runtime: unknown,
  directory: unknown = {},
  lookup: unknown = {},
  gateway: unknown = {},
) =>
  make.pipe(
    Effect.provide(nativeManagedChatFacts),
    Effect.provideService(CoreModules, core as never),
    Effect.provideService(AgentRuntimeApplication, runtime as never),
    Effect.provideService(CodexThreadDirectory, directory as never),
    Effect.provideService(CodexNativeThreadLookup, lookup as never),
    Effect.provideService(CodexGateway, gateway as never),
  );
it.effect("reads Runtime Run, question choices and progress using metadata-only operations", () =>
  Effect.gen(function* () {
    let session = runtimeSession;
    const requests: string[] = [];
    const runtime = {
      observeSessionMetadata: () => {
        requests.push("observe");
        return Effect.succeed({
          metadata: { itemCount: 4, providerInstanceId: "codex", model: "gpt", effort: "high" },
          execution: {
            runId: "run",
            status: "running",
            continuationPending: false,
            revision: "revision",
          },
          details: {
            waitingAdmissions: [
              {
                runId: "queued",
                class: "person",
                position: 2,
                waitingSince: "2026-11-03T00:00:00Z",
              },
            ],
            recentRuns: [{ runId: "run", requestedAt: "2026-11-03T00:00:00Z", startedAt: null }],
            pendingRequests: [
              {
                id: "q",
                kind: "question",
                questions: [
                  { question: "Ship?", options: [{ label: "Yes", description: "Ship it" }] },
                ],
              },
            ],
          },
        });
      },
    };
    const core = {
      workspace: { read: () => Effect.sync(() => ({ value: { kind: "session", session } })) },
    };
    const facts = yield* owner(core, runtime);
    const result = yield* facts.read("chat");
    assert.deepEqual(result.agent, { instanceId: "codex", model: "gpt", effort: "high" });
    assert.equal(result.state, "waiting");
    assert.deepEqual(result.waitingAdmissions, [
      { runId: "queued", class: "person", position: 2, waitingSince: "2026-11-03T00:00:00Z" },
    ]);
    assert.equal(result.runStartedAt, Date.parse("2026-11-03T00:00:00Z"));
    assert.equal(result.pendingRequests[0]?.id, "q");
    assert.equal(result.pendingRequests[0]?.questions?.[0]?.options?.[0]?.label, "Yes");
    assert.deepEqual(requests, ["observe"]);
    let calls = 0;
    const changed = yield* owner(
      {
        workspace: {
          read: () =>
            Effect.sync(() => ({
              value: {
                kind: "session",
                session:
                  ++calls === 1
                    ? runtimeSession
                    : {
                        ...runtimeSession,
                        execution_ref: { runtime_id: "other", thread_id: "replaced" },
                      },
              },
            })),
        },
      },
      runtime,
    );
    assert.equal((yield* changed.read("chat")).state, "unavailable");
    session = { ...runtimeSession, archived: true };
    assert.equal((yield* facts.read("chat")).state, "unavailable");
  }),
);
it.effect("records an unavailable owner on missing metadata and bounded owner timeouts", () =>
  Effect.gen(function* () {
    const core = {
      workspace: {
        read: () => Effect.succeed({ value: { kind: "session", session: runtimeSession } }),
      },
    };
    const missing = yield* owner(core, { observeSessionMetadata: () => Effect.succeed(null) });
    assert.equal((yield* missing.read("chat")).state, "unavailable");
    const stopped = yield* owner(core, { observeSessionMetadata: () => Effect.never });
    const read = yield* stopped.read("chat").pipe(Effect.forkChild);
    yield* TestClock.adjust("20 seconds");
    assert.equal((yield* Fiber.join(read)).state, "unavailable");
  }),
);
it.effect(
  "reads native Turn timestamps and real pending request identities without transcript hydration",
  () =>
    Effect.gen(function* () {
      const session = { id: "chat", archived: false, thread_id: "native", execution_ref: null };
      const core = {
        workspace: { read: () => Effect.succeed({ value: { kind: "session", session } }) },
      };
      const directory = {
        resolve: () =>
          Effect.succeed({
            durable: {
              backendBinding: { kind: "codex" },
              executionHostId: "local",
              updatedAt: "2026-11-03T00:01:00Z",
            },
            summary: { statusActiveFlags: ["waitingOnUserInput"] },
            canonical: null,
            snapshot: {
              requests: [
                {
                  type: "userInput",
                  requestId: 17,
                  questions: [{ question: "Continue?", options: [] }],
                },
                { type: "approval", requestId: 18, reason: "Push branch?" },
              ],
            },
          }),
      };
      let updatedAt = 1;
      const lookup = {
        resolve: () =>
          Effect.succeed({
            hostId: "local",
            manager: { generation: 2, assertCurrent: () => undefined },
            thread: {
              id: "native",
              get updatedAt() {
                return updatedAt;
              },
              status: { type: "active", activeFlags: ["waitingOnUserInput"] },
              get turns() {
                throw new Error("No transcript reads");
              },
            },
          }),
      };
      const gateway = {
        requestOnHost: (
          _host: string,
          method: string,
          params: { itemsView: string; limit: number },
        ) => {
          assert.equal(method, "thread/turns/list");
          assert.equal(params.itemsView, "notLoaded");
          assert.equal(params.limit, 1);
          return Effect.succeed({
            data: [{ id: "turn", status: "inProgress", startedAt: 12 }],
            nextCursor: null,
          });
        },
      };
      const source = yield* owner(core, {}, directory, lookup, gateway);
      const facts = yield* source.read("chat");
      assert.equal(facts.state, "waiting");
      assert.equal(facts.runId, "turn");
      assert.equal(facts.runStartedAt, 12000);
      updatedAt++;
      assert.notEqual((yield* source.read("chat")).progressFingerprint, facts.progressFingerprint);
      assert.deepEqual(
        facts.pendingRequests.map((r) => [r.id, r.kind]),
        [
          ["17", "question"],
          ["18", "approval"],
        ],
      );
    }),
);

it.effect.each([true, false])(
  "observes the Runtime's durable stop intent (%s)",
  (interruptRequested) =>
    Effect.gen(function* () {
      const core = {
        workspace: {
          read: () => Effect.succeed({ value: { kind: "session", session: runtimeSession } }),
        },
      };
      const source = yield* owner(core, {
        observeSessionMetadata: () =>
          Effect.succeed({
            metadata: { itemCount: 4, providerInstanceId: "codex", model: "gpt", effort: "high" },
            execution: {
              runId: "run",
              status: "interrupted",
              continuationPending: false,
              revision: "end",
            },
            details: {
              recentRuns: [
                { runId: "run", requestedAt: "2026-11-03T00:00:00Z", interruptRequested },
              ],
              pendingRequests: [],
            },
          }),
      });
      const facts = yield* source.read("chat");
      assert.equal(facts.interruptRequested, interruptRequested);
      assert.equal(facts.terminalStatus, "interrupted");
      assert.isEmpty(facts.pendingRequests);
    }),
);

it.effect.each([
  ["message", "pending", true],
  ["live", "pending", true],
  ["not_resumable", "pending", false],
  ["message", "cancelled", false],
  ["message", "resolved", false],
] as const)(
  "observes a finished Run's %s/%s question from the Runtime read path",
  ([capability, status, answerable]) =>
    Effect.gen(function* () {
      const fixture = yield* makeSessionDetailsFixture("thread", "run");
      yield* fixture.startRun;
      const source = yield* owner(
        {
          workspace: {
            read: () => Effect.succeed({ value: { kind: "session", session: runtimeSession } }),
          },
        },
        {
          observeSessionMetadata: () =>
            Effect.gen(function* () {
              const details = yield* readSessionDetails("thread", 1);
              return {
                metadata: {
                  itemCount: 4,
                  providerInstanceId: "codex",
                  model: "gpt",
                  effort: "high",
                },
                execution: {
                  runId: "run",
                  status: details.recentRuns[0]!.status,
                  continuationPending: false,
                  revision: "current",
                },
                details,
              };
            }),
        },
      );
      const before = diff({
        sessionId: "chat",
        previous: null,
        facts: yield* source.read("chat"),
        now: 0,
        latestReportAt: null,
      }).observed;
      const questions = [
        {
          id: "wood",
          header: "Label",
          question: "Cedar or Maple?",
          options: [{ label: "Cedar", description: "Cedar" }],
        },
      ];
      yield* fixture.addQuestion({
        requestId: "question",
        status,
        responseCapability: { type: capability },
        questions,
      });
      yield* fixture.completeRun;
      const facts = yield* source.read("chat");
      assert.equal(facts.terminalStatus, "completed");
      assert.equal(facts.state, answerable ? "waiting" : "idle");
      assert.deepEqual(
        facts.pendingRequests.map((request) => request.id),
        answerable ? ["question"] : [],
      );
      const ended = diff({
        sessionId: "chat",
        previous: before,
        facts,
        now: 1,
        latestReportAt: null,
      });
      assert.deepEqual(
        ended.events.map((event) => event.kind),
        answerable ? ["attention"] : ["turn_ended"],
      );
      if (!answerable) return;
      assert.equal(facts.pendingRequests[0]?.question, "Cedar or Maple?");
      assert.deepEqual(
        diff({ sessionId: "chat", previous: ended.observed, facts, now: 2, latestReportAt: null })
          .resolvedRequestIds,
        [],
      );
      yield* fixture.updateQuestion("question", {
        status: capability === "message" ? "resolved" : "pending",
        responseCapability: {
          type: "not_resumable",
          reason: "The response capability ended",
        },
      });
      const resolved = diff({
        sessionId: "chat",
        previous: ended.observed,
        facts: yield* source.read("chat"),
        now: 3,
        latestReportAt: null,
      });
      assert.deepEqual(resolved.resolvedRequestIds, ["question"]);
      assert.isEmpty(resolved.events);
    }).pipe(Effect.provide(layerMemory)),
);

it.effect(
  "keeps Runtime queued admission distinct from healthy working, including its ordinal",
  () =>
    Effect.gen(function* () {
      const facts = yield* owner(
        {
          workspace: {
            read: () => Effect.succeed({ value: { kind: "session", session: runtimeSession } }),
          },
        },
        {
          observeSessionMetadata: () =>
            Effect.succeed({
              metadata: { itemCount: 0 },
              execution: {
                runId: "queued",
                status: "queued",
                continuationPending: true,
                revision: 1,
              },
              details: {
                recentRuns: [{ runId: "queued", requestedAt: "2026-11-03T00:00:00Z" }],
                pendingRequests: [],
                waitingAdmissions: [
                  {
                    runId: "queued",
                    class: "start",
                    position: 3,
                    waitingSince: "2026-11-03T00:00:00Z",
                  },
                ],
              },
            }),
        },
      );
      const observation = yield* facts.read("chat");
      assert.equal(observation.state, "queued");
      assert.equal(observation.waitingAdmissions?.[0]?.position, 3);
    }),
);
