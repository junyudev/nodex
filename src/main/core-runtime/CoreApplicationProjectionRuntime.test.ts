import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { AutomationRoutingIndex } from "./AutomationRoutingIndex";
import { CoreApplicationProjectionRuntime, live } from "./CoreApplicationProjectionRuntime";

it.effect(
  "projects Automation commits and full resynchronization through owning capabilities",
  () =>
    Effect.gen(function* () {
      const scheduledEvents: unknown[] = [];
      const runEvents: unknown[] = [];
      const libraryEvents: unknown[] = [];
      const projectEvents: unknown[] = [];
      const sessionEvents: unknown[] = [];
      let synchronizeCount = 0;
      const notifications = DatabaseNotifierRuntime.of({
        notifyDatabaseChanged: () => Effect.void,
        notifyLibraryNavigationChanged: (event) =>
          Effect.sync(() => {
            libraryEvents.push(event);
          }),
        notifyProjectsChanged: (changeType, projectId) =>
          Effect.sync(() => {
            projectEvents.push({ changeType, projectId });
          }),
        notifyProjectSessionInvalidation: (event) =>
          Effect.sync(() => {
            sessionEvents.push(event);
          }),
        notifyInboxChanged: () => Effect.void,
        projectSessionInvalidations: Stream.empty,
        inboxInvalidations: Stream.empty,
      });
      const automationRouting = AutomationRoutingIndex.of({
        activeHeartbeatAutomationId: () => null,
        commit: () => undefined,
        runAutomationId: () => null,
        synchronize: Effect.sync(() => {
          synchronizeCount += 1;
        }),
      });
      const codexEvents = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => {
          if (event.kind !== "codex") return;
          if (event.value.type === "scheduledAutomationChanged") {
            scheduledEvents.push(event.value.event);
          }
          if (event.value.type === "automationRunsUpdated") runEvents.push(event.value.event);
        },
      });

      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AutomationRoutingIndex, automationRouting),
              Layer.succeed(CodexApplicationEventHub, codexEvents),
              Layer.succeed(DatabaseNotifierRuntime, notifications),
            ),
          ),
        ),
        scope,
      );
      const runtime = Context.get(context, CoreApplicationProjectionRuntime);
      const packet = createCoreLocalCommitFixture({
        commitSeq: 8,
        storeEpoch: "epoch:test",
        payload: {
          module: "automation",
          library_id: "library-1",
          project_id: "project-1",
          event: {
            kind: "automation_changed",
            automation_ids: ["daily-report"],
            lease_ids: [],
            run_ids: ["thread:daily-report"],
            reminder_lease_ids: [],
            snooze_ids: [],
            page_ids: [],
            document_ids: [],
            database_ids: [],
          },
        },
      });

      yield* runtime.publish({ transport_version: 4, packet }, packet.atoms[0]!, "library-1");

      assert.strictEqual(synchronizeCount, 1);
      assert.deepEqual(scheduledEvents, [
        { automationId: "daily-report", targetThreadId: null, reason: "upsert" },
      ]);
      assert.deepEqual(runEvents, [
        { automationId: "daily-report", threadId: "thread:daily-report", reason: "settle" },
      ]);

      yield* runtime.publishResync({
        commitSeq: 9,
        libraryId: "library-1",
        storeEpoch: "epoch:test",
      });
      assert.deepEqual(libraryEvents, [
        {
          version: 1,
          libraryId: "library-1",
          storeEpoch: "epoch:test",
          commitSeq: 9,
          changeKind: "content",
          affectedParentKeys: ["library", "catalog"],
          affectedPageIds: [],
          affectedDatabaseIds: [],
          affectedViewIds: [],
        },
      ]);
      assert.deepEqual(projectEvents, [{ changeType: "update", projectId: undefined }]);
      assert.strictEqual(sessionEvents.length, 1);

      yield* Scope.close(scope, Exit.void);
    }),
);
