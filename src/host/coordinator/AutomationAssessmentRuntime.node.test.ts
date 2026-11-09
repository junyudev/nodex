import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { components } from "@nodex/core-protocol";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { assessmentIdentity, makeAssessmentDelivery } from "./automation-assessment-delivery";

type Request = components["schemas"]["AutomationAssessmentRequest"];
const request: Request = {
  request_id: "request",
  generation: 1,
  thread_id: "thread",
  policy_hash: "a".repeat(64),
  automations: [],
  trigger_ids: ["trigger"],
  coordinator_session_id: "nodex",
  handed_over_at_ms: 0,
  run_started_at_ms: null,
};
function fixture() {
  let current = { ...request };
  let run: { status: string; startedAt?: string } | null = null;
  let followup: { status: string } | null = null;
  const starts: number[] = [];
  const core = {
    workspace: {
      read: () =>
        Effect.sync(() => ({
          value: { kind: "automation_assessments", value: { kind: "request", request: current } },
        })),
      apply: ({ intent }: { intent: { command: { kind: string; started_at_ms: number } } }) =>
        Effect.sync(() => {
          if (intent.command.kind === "start_run") {
            starts.push(intent.command.started_at_ms);
            current = {
              ...current,
              run_started_at_ms: current.run_started_at_ms ?? intent.command.started_at_ms,
            };
          }
          return {};
        }),
    },
  };
  const runtime = {
    runOutcome: ({ messageId }: { messageId: string }) =>
      Effect.succeed(messageId === assessmentIdentity(request, true).messageId ? followup : run),
  };
  return {
    owner: makeAssessmentDelivery.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(AgentRuntimeApplication, runtime as never),
    ),
    starts,
    setRun: (value: typeof run) => {
      run = value;
    },
    setFollowup: (value: typeof followup) => {
      followup = value;
    },
    current: () => current,
  };
}
it.effect("starts the durable deadline with the carrying Run and retains it after restart", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.owner;
    yield* TestClock.adjust("10 minutes");
    assert.equal((yield* first.status(request)).deadline, Infinity);
    f.setRun({ status: "running", startedAt: new Date(600_000).toISOString() });
    assert.equal((yield* first.status(request)).deadline, 720_000);
    const reopened = yield* f.owner;
    yield* TestClock.adjust("1 minute");
    assert.isNull((yield* reopened.status(f.current())).failure);
    assert.deepEqual(f.starts, [600_000]);
    yield* TestClock.adjust("1 minute");
    assert.equal(
      (yield* reopened.status(f.current())).failure,
      "The automation assessment timed out",
    );
  }),
);
it.effect("allows one unanswered-turn follow-up and stops after the follow-up ends", () =>
  Effect.gen(function* () {
    const f = fixture();
    const owner = yield* f.owner;
    f.setRun({ status: "completed", startedAt: new Date(0).toISOString() });
    assert.isTrue((yield* owner.status(request)).followup);
    f.setFollowup({ status: "running" });
    assert.isTrue((yield* owner.status(f.current())).followup);
    f.setFollowup({ status: "completed" });
    assert.include((yield* owner.status(f.current())).failure ?? "", "follow-up");
    assert.notEqual(
      assessmentIdentity(request).messageId,
      assessmentIdentity({ ...request, generation: 2 }).messageId,
    );
    assert.notEqual(
      assessmentIdentity(request).messageId,
      assessmentIdentity(request, true).messageId,
    );
  }),
);

it.effect("reconciles a lost Host-input reply after reopening without sending it twice", () =>
  Effect.gen(function* () {
    const { make } = yield* Effect.promise(() => import("./AutomationAssessmentRuntime"));
    const { CoordinatorSession } = yield* Effect.promise(() => import("./CoordinatorSession"));
    const { ApplicationSettings } = yield* Effect.promise(
      () => import("../../main/settings/ApplicationSettings"),
    );
    const { DEFAULT_INBOX_SETTINGS } = yield* Effect.promise(() => import("../../shared/inbox"));
    const admissions = new Set<string>();
    let isCurrent = true;
    const failures: string[] = [];
    const sends: { origin: string; mode: string; message: { messageId: string; text: string } }[] =
      [];
    const core = {
      workspace: {
        read: (read: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
          Effect.sync(() => ({
            value:
              read.kind === "execution_holds"
                ? { kind: "execution_holds", holds: [], next_key: null }
                : {
                    kind: "automation_assessments",
                    value:
                      read.kind === "automation_assessments" && read.read.kind === "pending"
                        ? { kind: "pending", requests: [request] }
                        : { kind: "request", request },
                  },
          })),
        apply: ({ intent }: { intent: { command: { kind: string; reason: string } } }) =>
          Effect.sync(() => {
            assert.equal(intent.command.kind, "fail");
            failures.push(intent.command.reason);
            return {};
          }),
      },
    };
    const owner = make.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(CoordinatorSession, {
        ensure: () => Effect.succeed("nodex"),
        isCoordinator: () => Effect.succeed(isCurrent),
      } as never),
      Effect.provideService(ApplicationSettings, {
        snapshot: () =>
          Effect.succeed({
            inbox: {
              ...DEFAULT_INBOX_SETTINGS,
              suggestionAgent: {
                instanceId: "codex",
                model: "model",
                reasoningEffort: null,
                serviceTier: null,
              },
            },
          }),
      } as never),
      Effect.provideService(AgentRuntimeApplication, {
        runOutcome: () => Effect.succeed(null),
        messageAdmission: ({ messageId }: { messageId: string }) =>
          Effect.succeed(
            admissions.has(messageId) ? { status: "accepted", threadId: "thread:nodex" } : null,
          ),
        catalog: () =>
          Effect.succeed([
            {
              instanceId: "codex",
              driver: "codex",
              displayName: "Codex",
              enabled: true,
              installed: true,
              status: "ready",
              version: "test",
              auth: { status: "authenticated" },
              checkedAt: "2026-11-03T00:00:00Z",
              models: [
                {
                  slug: "model",
                  name: "Model",
                  isDefault: true,
                  isCustom: false,
                  capabilities: {},
                },
              ],
              skills: [],
              slashCommands: [],
            },
          ]),
        sendMessage: (input: (typeof sends)[number]) =>
          Effect.gen(function* () {
            sends.push(input);
            admissions.add(input.message.messageId);
            return yield* Effect.fail(new Error("Reply lost"));
          }),
      } as never),
    );
    yield* (yield* owner).tick;
    yield* (yield* owner).tick;
    assert.lengthOf(sends, 1);
    assert.equal(sends[0]?.origin, "host");
    assert.equal(sends[0]?.mode, "queue");
    assert.equal(sends[0]?.message.messageId, assessmentIdentity(request).messageId);
    isCurrent = false;
    yield* (yield* owner).tick;
    assert.deepEqual(failures, ["The Coordinator changed before completing this assessment"]);
  }),
);
