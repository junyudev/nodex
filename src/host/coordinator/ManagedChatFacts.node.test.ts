import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import { makeSessionDetailsFixture } from "@nodex/agent-runtime/orchestration/testkit/SessionDetailsFixture";
import { layerMemory } from "../../../packages/agent-runtime/src/persistence/Sqlite";
import { readSessionDetails } from "@nodex/agent-runtime/orchestration/SessionReadDetails";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CodexSubagentDirectory } from "../../main/codex-application/CodexSubagentDirectory";
import { CodexThreadDirectory } from "../../main/codex-application/CodexThreadDirectory";
import { CodexNativeThreadLookup } from "../../main/codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../../main/codex-runtime/CodexGateway";
import { live as nativeManagedChatFacts } from "../../main/codex-application/NativeManagedChatFacts";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { make } from "./ManagedChatFacts";
import {
  diffManagedChatObservation as diff,
  MANAGED_CHAT_STALL_MS as STALL,
  type ManagedChatObservation,
} from "./managed-chat-observation";

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
  subagents: unknown = {
    readKnownOverview: () => Effect.succeed({ rows: [], completeness: "complete" }),
  },
) =>
  make.pipe(
    Effect.provide(nativeManagedChatFacts),
    Effect.provideService(CoreModules, core as never),
    Effect.provideService(AgentRuntimeApplication, runtime as never),
    Effect.provideService(CodexThreadDirectory, directory as never),
    Effect.provideService(CodexNativeThreadLookup, lookup as never),
    Effect.provideService(CodexGateway, gateway as never),
    Effect.provideService(CodexSubagentDirectory, subagents as never),
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
                position: 2,
                waitingSince: "2026-11-03T00:00:00Z",
              },
            ],
            recentRuns: [{ runId: "run", startedAt: "2026-11-03T00:00:00Z" }],
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
      { runId: "queued", position: 2, waitingSince: "2026-11-03T00:00:00Z" },
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
it.effect.each(["running", "background"] as const)(
  "waits for the sidebar's %s execution tree before reporting a root Run ended",
  (status) =>
    Effect.gen(function* () {
      let activity: { status: string; hasWork: boolean; updatedAt: string } | null = {
        status,
        hasWork: true,
        updatedAt: "first",
      };
      const source = yield* owner(
        {
          workspace: {
            read: () => Effect.succeed({ value: { kind: "session", session: runtimeSession } }),
          },
        },
        {
          observeSessionMetadata: () =>
            Effect.sync(() => ({
              metadata: { itemCount: 4, providerInstanceId: "codex", model: "gpt", effort: "high" },
              execution: { runId: "root", status: "completed", revision: "end" },
              details: {
                recentRuns: [{ runId: "root", startedAt: "2026-11-03T00:00:00Z" }],
                pendingRequests: [],
              },
              activity,
            })),
        },
      );
      const live = yield* source.read("chat");
      assert.equal(live.state, "working");
      assert.isNull(live.terminalStatus);
      activity = { status, hasWork: true, updatedAt: "child progressed" };
      const progress = yield* source.read("chat");
      assert.notEqual(progress.progressFingerprint, live.progressFingerprint);
      const previous = diff({
        sessionId: "chat",
        facts: progress,
        previous: null,
        now: 0,
        latestReportAt: null,
      });
      activity = null;
      const quiet = yield* source.read("chat");
      assert.equal(quiet.state, "idle");
      assert.deepEqual(
        diff({
          sessionId: "chat",
          facts: quiet,
          previous: previous.observed,
          now: 1,
          latestReportAt: null,
        }).events.map((event) => event.kind),
        ["turn_ended"],
      );
    }),
);
it.effect("never stalls while the chat only waits on commands, then restarts the stall clock", () =>
  Effect.gen(function* () {
    let awaitingCommands = true;
    const source = yield* owner(
      {
        workspace: {
          read: () => Effect.succeed({ value: { kind: "session", session: runtimeSession } }),
        },
      },
      {
        observeSessionMetadata: () =>
          Effect.sync(() => ({
            metadata: { itemCount: 4, providerInstanceId: "claude", model: "opus", effort: null },
            execution: { runId: "root", status: "completed", revision: "end" },
            details: {
              recentRuns: [{ runId: "root", startedAt: "2026-11-03T00:00:00Z" }],
              pendingRequests: [],
            },
            activity: { status: "background", hasWork: true, awaitingCommands, updatedAt: "t" },
          })),
      },
    );
    const observe = (previous: ManagedChatObservation | null, now: number) =>
      source.read("chat").pipe(
        Effect.map((facts) =>
          diff({ sessionId: "chat", facts, previous, now, latestReportAt: null }),
        ),
      );
    let step = yield* observe(null, 0);
    assert.equal(step.observed.state, "working");
    // A background command can run quietly for far longer than the stall grace.
    for (const now of [STALL, STALL * 3]) {
      step = yield* observe(step.observed, now);
      assert.isFalse(step.observed.stalled);
      assert.deepEqual(step.events, []);
    }
    // Once the command ends, quiet time counts again from that moment.
    awaitingCommands = false;
    step = yield* observe(step.observed, STALL * 3 + 1);
    assert.equal(step.observed.progressSince, STALL * 3 + 1);
    step = yield* observe(step.observed, STALL * 4);
    assert.isFalse(step.observed.stalled);
    step = yield* observe(step.observed, STALL * 4 + 1);
    assert.deepEqual(
      step.events.map((event) => event.kind),
      ["stalled"],
    );
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
      let rootDone = false;
      const directory = {
        resolve: () =>
          Effect.succeed({
            durable: {
              backendBinding: { driver: "codex", instanceId: "codex" },
              executionHostId: "local",
              updatedAt: "2026-11-03T00:01:00Z",
            },
            summary: { statusActiveFlags: ["waitingOnUserInput"] },
            canonical: null,
            snapshot: {
              requests: rootDone
                ? []
                : [
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
              status: rootDone
                ? { type: "idle" }
                : { type: "active", activeFlags: ["waitingOnUserInput"] },
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
            data: [{ id: "turn", status: rootDone ? "completed" : "inProgress", startedAt: 12 }],
            nextCursor: null,
          });
        },
      };
      let children: Array<{ threadId: string; status: string; lastActivityAtMs: number }> = [];
      const source = yield* owner(core, {}, directory, lookup, gateway, {
        readKnownOverview: () => Effect.sync(() => ({ rows: children, completeness: "complete" })),
      });
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
      rootDone = true;
      assert.equal((yield* source.read("chat")).state, "idle");
      children = [{ threadId: "native:child", status: "active", lastActivityAtMs: 42 }];
      const liveChild = yield* source.read("chat");
      assert.equal(liveChild.state, "working");
      assert.isNull(liveChild.terminalStatus);
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
              activity: { hasWork: true, status: "background", pendingRequestCount: 0 },
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
