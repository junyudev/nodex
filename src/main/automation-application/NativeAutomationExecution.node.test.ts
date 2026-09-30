import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { CodexScheduledAutomation } from "../../shared/types";
import { NativeConversationExtension } from "../app-tools/NativeConversationExtension";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AutomationApplication } from "./AutomationApplication";
import { make } from "./NativeAutomationExecution";

const definition: CodexScheduledAutomation = {
  id: "automation",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  targetThreadId: null,
  notificationPolicy: null,
  name: "Review builds",
  prompt: "Review builds",
  rrule: "FREQ=HOURLY;INTERVAL=1",
  model: "opus",
  reasoningEffort: "high",
  serviceTier: null,
  backendBinding: { kind: "claude", instanceConfigId: "work" },
  cwds: ["/workspace"],
  executionEnvironment: "local",
  localEnvironmentConfigPath: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 1,
  updatedAt: 1,
};
const setup = (
  options: {
    heartbeat?: boolean;
    busy?: boolean;
    revision?: number;
    wait?: boolean;
    outcome?: "completed" | "failed";
  } = {},
) => {
  const candidate = options.heartbeat
    ? {
        ...definition,
        kind: "heartbeat" as const,
        targetSessionId: "session",
        targetThreadId: "target",
      }
    : definition;
  const submits: Parameters<NativeConversationExtension["Service"]["submit"]>[0][] = [];
  const creates: Parameters<
    NativeConversationExtension["Service"]["createAutomationSession"]
  >[0][] = [];
  const complete: unknown[] = [];
  const archives: unknown[] = [];
  const cancelled: string[] = [];
  return {
    candidate,
    submits,
    creates,
    complete,
    archives,
    cancelled,
    execute: make.pipe(
      Effect.provideService(AutomationApplication, {
        definitions: {
          getForExecution: () =>
            Effect.succeed({ ...candidate, definitionRevision: options.revision ?? 1 }),
        },
        runs: {
          begin: () => Effect.succeed(true),
          replacePendingThread: () => Effect.succeed(true),
          completeForReview: (input: unknown) =>
            Effect.sync(() => {
              complete.push(input);
              return true;
            }),
          archive: (input: unknown) =>
            Effect.sync(() => {
              archives.push(input);
              return true;
            }),
        },
      } as never),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: () =>
          Effect.succeed({ archived: false, thread: { threadId: "target" } }),
      } as never),
      Effect.provideService(NativeConversationExtension, {
        validateAutomation: () => Effect.void,
        read: () =>
          Effect.succeed({
            threadId: "target",
            backendBinding: definition.backendBinding,
            archived: false,
            busy: options.busy ?? false,
            updatedAt: 0,
            title: "Target",
          }),
        createAutomationSession: (input) =>
          Effect.sync(() => {
            creates.push(input);
            return { threadId: "created" };
          }),
        submit: (input) =>
          Effect.sync(() => {
            submits.push(input);
            return { turnId: "accepted" };
          }),
        wait: () =>
          options.wait
            ? Effect.never
            : Effect.succeed({
                turnId: "accepted",
                outcome: options.outcome ?? "completed",
                assistantText: "Build passed",
              }),
        cancel: (threadId) =>
          Effect.sync(() => {
            cancelled.push(threadId);
          }),
        stopExecution: () => Effect.void,
        withExecutionHandoff: (_threadId, use) => use,
        setExecutionRecoveryRequired: () => Effect.void,
        withExecutionLocation: (_threadId, _location, use) => use,
      }),
    ),
  };
};

it.effect("native scheduled work uses the frozen instance and existing Core Run lifecycle", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const execute = yield* fixture.execute;
    yield* execute(fixture.candidate, { now: 1, reason: "scheduled", leaseId: "lease" });
    assert.deepEqual(fixture.creates[0]?.definition.backendBinding, {
      kind: "claude",
      instanceConfigId: "work",
    });
    assert.deepInclude(fixture.submits[0], {
      threadId: "created",
      model: "opus",
      effort: "high",
      unattended: true,
      operationId: "automation:automation:lease:0:turn",
    });
    assert.deepEqual(fixture.complete, [
      { threadId: "created", inboxTitle: "Review builds", inboxSummary: "Build passed" },
    ]);
    assert.lengthOf(fixture.archives, 0);
  }),
);

it.effect(
  "stale definitions and busy heartbeat targets do not dispatch, failed runs retain a durable terminal record",
  () =>
    Effect.gen(function* () {
      const stale = setup({ revision: 2 });
      const staleExecute = yield* stale.execute;
      yield* Effect.flip(
        staleExecute(stale.candidate, { now: 1, reason: "scheduled", leaseId: "lease" }),
      );
      assert.lengthOf(stale.submits, 0);
      const busy = setup({ heartbeat: true, busy: true });
      const heartbeat = yield* busy.execute;
      const error = yield* Effect.flip(
        heartbeat(busy.candidate, { now: 1, reason: "scheduled", leaseId: "lease" }),
      );
      assert.equal((error as { reasonCode?: string }).reasonCode, "heartbeat_busy");
      assert.lengthOf(busy.submits, 0);
      const failed = setup({ outcome: "failed" });
      const run = yield* failed.execute;
      yield* Effect.flip(run(failed.candidate, { now: 1, reason: "scheduled", leaseId: "lease" }));
      assert.lengthOf(failed.archives, 1);
      assert.lengthOf(failed.complete, 0);
    }),
);

it.effect(
  "interrupted scheduling cancels the exact accepted native Turn and settles its pending Run",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ wait: true });
      const execute = yield* fixture.execute;
      const fiber = yield* execute(fixture.candidate, {
        now: 1,
        reason: "scheduled",
        leaseId: "lease",
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(fixture.cancelled, ["created"]);
      assert.lengthOf(fixture.archives, 1);
    }),
);
