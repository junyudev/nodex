import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { agentRuntimeSnapshotFixture } from "../../shared/testing/agent-runtime-snapshot";
import type { ProjectSession } from "../../shared/types";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { UserPresence } from "../host-runtime/UserPresence";
import { makeMobileTranscript } from "./transcript";

/** Records which chats the phone holds in front of the person. */
const recordingPresence = (views: string[]) =>
  ({
    showOnPhone: ({ sessionId, conversationId }) =>
      Effect.acquireRelease(
        Effect.sync(() => views.push(`show ${sessionId} ${conversationId}`)),
        () => Effect.sync(() => views.push(`hide ${sessionId}`)),
      ),
  }) as Pick<UserPresence["Service"], "showOnPhone"> as UserPresence["Service"];

it.effect(
  "watermarks a reopened snapshot ahead of queued patches and preserves revisions during recovery",
  () =>
    Effect.gen(function* () {
      const invalidations = yield* Queue.unbounded<ProjectSessionsChangeEvent>();
      const queued = yield* Queue.unbounded<{ event: string; data: unknown }>();
      let title = "Start";
      let historyRevision = 0;
      const sessionId = "session";
      const views: string[] = [];
      const refresh = (next: string) =>
        Effect.gen(function* () {
          title = next;
          yield* Queue.offer(invalidations, {
            changeType: "update",
            summaryScopes: [],
            detailInvalidation: { kind: "sessions", sessionIds: [sessionId] },
          });
          yield* TestClock.adjust("80 millis");
        });
      const makeTranscript = yield* makeMobileTranscript({
        session: () =>
          Effect.sync(
            () =>
              ({
                id: sessionId,
                projectId: null,
                displayTitle: title,
                executionRef: { runtimeId: "runtime", threadId: "thread" },
              }) as ProjectSession,
          ),
      }).pipe(
        Effect.provideService(DatabaseNotifierRuntime, {
          projectSessionInvalidations: Stream.fromQueue(invalidations),
        } as DatabaseNotifierRuntime["Service"]),
        Effect.provideService(AgentRuntimeApplication, {
          resolveTarget: () => Effect.never,
          read: () =>
            Effect.sync(() => ({
              snapshot: agentRuntimeSnapshotFixture({ thread: { historyRevision } }),
            })),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(AgentRuntimeSessionActivity, {
          read: Effect.succeed({ items: [] }),
          activityChanges: Stream.never,
        } as unknown as AgentRuntimeSessionActivity["Service"]),
        Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
        Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
        Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
        Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
        Effect.provideService(UserPresence, recordingPresence(views)),
      );

      const transcript = yield* makeTranscript((event, data) =>
        Queue.offer(queued, { event, data }).pipe(Effect.asVoid),
      );
      const open = Effect.flatten(transcript.handlers["chat.open"]({ sessionId }));
      expect(yield* open).toMatchObject({ title: "Start", revision: 0 });
      yield* refresh("First update");
      yield* refresh("First update"); // This invalidation has no changes to send.
      yield* refresh("Second update");
      expect(yield* open).toMatchObject({ title: "Second update", revision: 2 });
      // Reopening a watched chat keeps its one view in front of the person.
      expect(views).toEqual(["show session thread"]);
      expect(yield* Queue.take(queued)).toEqual({
        event: "chat.patch",
        data: { sessionId, revision: 1, ops: [{ op: "title", title: "First update" }] },
      });

      const recovered: unknown[] = [];
      yield* transcript.recover(
        (event, data) =>
          Effect.sync(() => {
            recovered.push({ event, data });
          }),
        Queue.clear(queued).pipe(Effect.asVoid),
      );
      expect(recovered).toEqual([
        {
          event: "chat.snapshot",
          data: expect.objectContaining({ title: "Second update", revision: 2 }),
        },
      ]);
      expect(yield* Queue.size(queued)).toBe(0);
      yield* refresh("Third update");
      expect(yield* Queue.take(queued)).toMatchObject({
        event: "chat.patch",
        data: { revision: 3 },
      });

      historyRevision++;
      yield* refresh("History replaced");
      expect(yield* Queue.take(queued)).toMatchObject({
        event: "chat.snapshot",
        data: { title: "History replaced", revision: 3 },
      });
      yield* transcript.handlers["chat.close"]({ sessionId });
      expect(views).toEqual(["show session thread", "hide session"]);
    }),
);

it.effect("keeps slow chat reads independent and recovery snapshots uninterrupted", () =>
  Effect.gen(function* () {
    const invalidations = yield* PubSub.unbounded<ProjectSessionsChangeEvent>();
    const activityChanges = yield* PubSub.unbounded<{ type: "reset"; sequence: number }>();
    const releaseRead = yield* Deferred.make<void>();
    const reading = yield* Deferred.make<void>();
    const recoveryStarted = yield* Deferred.make<void>();
    const releaseRecovery = yield* Deferred.make<void>();
    const events: { event: string; data: unknown }[] = [];
    const reads: string[] = [];
    let refreshing = false;
    const makeTranscript = yield* makeMobileTranscript({
      session: (id) =>
        Effect.succeed({
          id,
          projectId: null,
          displayTitle: refreshing ? "Updated" : "Start",
          executionRef: { runtimeId: "runtime", threadId: id },
        } as ProjectSession),
    }).pipe(
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.fromPubSub(invalidations),
      } as DatabaseNotifierRuntime["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () => Effect.never,
        read: ({ sessionId }: { sessionId: string }) =>
          Effect.gen(function* () {
            if (refreshing) reads.push(sessionId);
            if (refreshing && sessionId === "slow") {
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(releaseRead);
            }
            return { snapshot: agentRuntimeSnapshotFixture({}) };
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(AgentRuntimeSessionActivity, {
        read: Effect.succeed({ items: [] }),
        activityChanges: Stream.fromPubSub(activityChanges),
      } as unknown as AgentRuntimeSessionActivity["Service"]),
      Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
      Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
      Effect.provideService(UserPresence, recordingPresence([])),
    );
    const transcript = yield* makeTranscript((event, data) =>
      Effect.sync(() => {
        events.push({ event, data });
      }),
    );
    for (const sessionId of ["slow", "fast"])
      yield* Effect.flatten(transcript.handlers["chat.open"]({ sessionId }));
    yield* TestClock.adjust("1 millis");
    refreshing = true;
    yield* PubSub.publish(invalidations, {
      changeType: "update",
      summaryScopes: [],
      detailInvalidation: { kind: "sessions", sessionIds: ["slow"] },
    });
    yield* TestClock.adjust("80 millis");
    expect(yield* Deferred.isDone(reading)).toBe(true);
    yield* PubSub.publish(invalidations, {
      changeType: "update",
      summaryScopes: [],
      detailInvalidation: { kind: "sessions", sessionIds: ["fast"] },
    });
    yield* TestClock.adjust("80 millis");
    expect(events).toEqual([
      {
        event: "chat.patch",
        data: { sessionId: "fast", revision: 2, ops: [{ op: "title", title: "Updated" }] },
      },
    ]);

    // A second source must not start another read of the blocked chat.
    yield* PubSub.publish(activityChanges, { type: "reset" as const, sequence: 1 });
    yield* TestClock.adjust("80 millis");
    expect(reads.filter((id) => id === "slow")).toHaveLength(1);
    const recovering = yield* transcript
      .recover(
        (event, data) =>
          Effect.sync(() => {
            events.push({ event, data });
          }),
        Deferred.succeed(recoveryStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRecovery)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(recoveryStarted);
    yield* Deferred.succeed(releaseRead, undefined);
    yield* Effect.yieldNow;
    expect(events).toHaveLength(1);
    yield* Deferred.succeed(releaseRecovery, undefined);
    yield* Fiber.join(recovering);
    yield* TestClock.adjust("1 millis");
    expect(events.slice(1, 3)).toMatchObject([
      { event: "chat.snapshot", data: { sessionId: "slow", revision: 0, title: "Start" } },
      { event: "chat.snapshot", data: { sessionId: "fast", revision: 2, title: "Updated" } },
    ]);
    expect(events.slice(3)).toEqual([
      {
        event: "chat.patch",
        data: { sessionId: "slow", revision: 1, ops: [{ op: "title", title: "Updated" }] },
      },
    ]);
    expect(reads.filter((id) => id === "slow")).toHaveLength(2);
  }),
);
