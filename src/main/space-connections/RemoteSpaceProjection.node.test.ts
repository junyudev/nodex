import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import { CoreApplicationProjectionRuntime } from "../core-runtime/CoreApplicationProjectionRuntime";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { live } from "./RemoteSpaceProjection";

it.effect(
  "refreshes remote Inbox and Activity for Automation-only and Run-only commits without a producer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inboxChanges: unknown[] = [];
        const notifier = DatabaseNotifierRuntime.of({
          notifyDatabaseChanged: () => Effect.void,
          notifyLibraryNavigationChanged: () => Effect.void,
          notifyProjectsChanged: () =>
            Effect.die("Automation changes must not refresh Project metadata"),
          notifyProjectSessionInvalidation: () => Effect.void,
          notifyInboxChanged: (event) =>
            Effect.sync(() => {
              inboxChanges.push(event);
            }),
          projectSessionInvalidations: Stream.empty,
          inboxInvalidations: Stream.empty,
          workInvalidations: Stream.empty,
          projectInvalidations: Stream.empty,
        });
        const context = yield* Layer.build(
          live(Effect.void).pipe(Layer.provide(Layer.succeed(DatabaseNotifierRuntime, notifier))),
        );
        const projection = Context.get(context, CoreApplicationProjectionRuntime);
        for (const [automationIds, runIds] of [
          [["automation-a"], []],
          [[], ["run-a"]],
          [[], []],
        ]) {
          const packet = createCoreLocalCommitFixture({
            commitSeq: 8,
            storeEpoch: "epoch:test",
            payload: {
              module: "automation",
              library_id: "team",
              project_id: null,
              event: {
                kind: "automation_changed",
                automation_ids: automationIds!,
                run_ids: runIds!,
                lease_ids: [],
                reminder_lease_ids: [],
                snooze_ids: [],
                page_ids: [],
                document_ids: [],
                database_ids: [],
              },
            },
          });
          yield* projection.publish({ transport_version: 4, packet }, packet.atoms[0]!, "team");
        }
        assert.deepEqual(inboxChanges, []);
        yield* TestClock.adjust("1 second");
        assert.deepEqual(inboxChanges, [{ reason: "content" }]);
      }),
    ),
);

it.effect("publishes hosted chat changes and resync to the team's Session catalog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes: unknown[] = [];
      let projectRefreshes = 0;
      const inboxChanges: unknown[] = [];
      const notifier = DatabaseNotifierRuntime.of({
        notifyDatabaseChanged: () => Effect.void,
        notifyLibraryNavigationChanged: () => Effect.void,
        notifyProjectsChanged: () =>
          Effect.sync(() => {
            projectRefreshes++;
          }),
        notifyProjectSessionInvalidation: (event) =>
          Effect.sync(() => {
            changes.push(event);
          }),
        notifyInboxChanged: (event) =>
          Effect.sync(() => {
            inboxChanges.push(event);
          }),
        projectSessionInvalidations: Stream.empty,
        inboxInvalidations: Stream.empty,
        workInvalidations: Stream.empty,
        projectInvalidations: Stream.empty,
      });
      const context = yield* Layer.build(
        live(Effect.void).pipe(Layer.provide(Layer.succeed(DatabaseNotifierRuntime, notifier))),
      );
      const projection = Context.get(context, CoreApplicationProjectionRuntime);
      const packet = createCoreLocalCommitFixture({
        commitSeq: 9,
        storeEpoch: "epoch:test",
        payload: {
          module: "project_workspace",
          library_id: "team",
          event: {
            kind: "workspace_changed",
            project_ids: ["project:host"],
            session_ids: ["session:host"],
            thread_ids: [],
            session_summary_scopes: [{ kind: "project", project_id: "project:host" }],
            session_detail_ids: ["session:host"],
            inbox_changed: false,
          },
        },
      });
      for (let index = 0; index < 100; index++)
        yield* projection.publish({ transport_version: 4, packet }, packet.atoms[0]!, "team");
      assert.deepEqual(changes, []);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(changes, [
        {
          summaryScopes: [{ kind: "project", projectId: "project:host" }],
          detailInvalidation: { kind: "sessions", sessionIds: ["session:host"] },
          changeType: "update",
        },
      ]);
      assert.equal(projectRefreshes, 0);
      assert.deepEqual(inboxChanges, [{ reason: "content" }]);
      yield* projection.publishResync({
        commitSeq: 9,
        libraryId: "team",
        storeEpoch: "epoch:test",
      });
      assert.equal(projectRefreshes, 1);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(changes[1], {
        summaryScopes: [{ kind: "all" }],
        detailInvalidation: { kind: "all" },
        changeType: "update",
      });
    }),
  ),
);

it.effect("a Space rename on the host rereads the name a connected desktop shows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let rereads = 0;
      const quiet = DatabaseNotifierRuntime.of({
        notifyDatabaseChanged: () => Effect.void,
        notifyLibraryNavigationChanged: () => Effect.void,
        notifyProjectsChanged: () => Effect.void,
        notifyProjectSessionInvalidation: () => Effect.void,
        notifyInboxChanged: () => Effect.void,
        projectSessionInvalidations: Stream.empty,
        inboxInvalidations: Stream.empty,
        workInvalidations: Stream.empty,
        projectInvalidations: Stream.empty,
      });
      const context = yield* Layer.build(
        live(
          Effect.sync(() => {
            rereads++;
          }),
        ).pipe(Layer.provide(Layer.succeed(DatabaseNotifierRuntime, quiet))),
      );
      const projection = Context.get(context, CoreApplicationProjectionRuntime);
      for (const operation of ["create_backup", "rename_space"]) {
        const packet = createCoreLocalCommitFixture({
          commitSeq: 10,
          storeEpoch: "epoch:test",
          payload: {
            module: "store_administration",
            library_id: "team",
            event: {
              kind: "store_administration_changed",
              operation,
              backup_ids: [],
              readiness_changed: false,
            },
          },
        });
        yield* projection.publish({ transport_version: 4, packet }, packet.atoms[0]!, "team");
      }
      yield* Effect.yieldNow;
      assert.strictEqual(rereads, 1);
    }),
  ),
);
