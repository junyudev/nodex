import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { DatabaseChangeEvent } from "../../shared/database-events";
import { parseDatabaseId, parseDatabaseViewId } from "../../shared/database-identities";
import type { InboxChangedEvent } from "../../shared/inbox";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import {
  LIBRARY_NAVIGATION_EVENT_VERSION,
  type LibraryNavigationChangedEvent,
} from "../../shared/library-events";
import { logDevRuntimeMetric } from "../dev-runtime-metrics";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export type ProjectChangeType =
  | "create"
  | "update"
  | "metadata"
  | "sources"
  | "lifecycle"
  | "delete"
  | "reorder"
  | "pin";

export interface ProjectsChangeEvent {
  readonly projectId?: string;
  readonly changeType: ProjectChangeType;
}

export interface DatabaseNotificationPublisher {
  readonly notifyDatabaseChanged: (event: DatabaseChangeEvent) => Effect.Effect<void>;
  readonly notifyLibraryNavigationChanged: (
    event: LibraryNavigationChangedEvent,
  ) => Effect.Effect<void>;
  readonly notifyProjectsChanged: (
    changeType: ProjectChangeType,
    projectId?: string,
  ) => Effect.Effect<void>;
  readonly notifyProjectSessionInvalidation: (
    event: ProjectSessionsChangeEvent,
  ) => Effect.Effect<void>;
  readonly notifyInboxChanged: (event: InboxChangedEvent) => Effect.Effect<void>;
}

export class DatabaseNotifierRuntime extends Context.Service<
  DatabaseNotifierRuntime,
  DatabaseNotificationPublisher & {
    readonly projectSessionInvalidations: Stream.Stream<ProjectSessionsChangeEvent>;
    readonly inboxInvalidations: Stream.Stream<InboxChangedEvent>;
    readonly projectInvalidations: Stream.Stream<ProjectsChangeEvent>;
    readonly workInvalidations: Stream.Stream<void>;
  }
>()("nodex/main/host-runtime/DatabaseNotifierRuntime") {}

/** Owns Core projection broadcasts and typed in-process observation for one Main Scope. */
export interface ProjectionNotificationSink {
  readonly publish: (channel: string, payload: unknown) => void;
  readonly windowCount: () => number;
}
export const layer = (sink: ProjectionNotificationSink): Layer.Layer<DatabaseNotifierRuntime> =>
  Layer.effect(
    DatabaseNotifierRuntime,
    Effect.gen(function* () {
      const projectSessionInvalidations = yield* PubSub.sliding<ProjectSessionsChangeEvent>(
        MAIN_OBSERVATION_EVENT_CAPACITY,
      );
      const inboxInvalidations = yield* PubSub.sliding<InboxChangedEvent>(
        MAIN_OBSERVATION_EVENT_CAPACITY,
      );
      const workInvalidations = yield* PubSub.sliding<void>(MAIN_OBSERVATION_EVENT_CAPACITY);
      let accepting = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
        }).pipe(
          Effect.andThen(PubSub.shutdown(projectSessionInvalidations)),
          Effect.andThen(PubSub.shutdown(inboxInvalidations)),
          Effect.andThen(PubSub.shutdown(workInvalidations)),
          Effect.andThen(PubSub.shutdown(projectInvalidations)),
        ),
      );

      const broadcast = Effect.fn("DatabaseNotifierRuntime.broadcast")(function* (
        channel: string,
        payload: unknown,
      ) {
        if (!accepting) return;
        yield* Effect.sync(() => sink.publish(channel, payload));
      });
      const notifyLibraryNavigationChanged = Effect.fn(
        "DatabaseNotifierRuntime.notifyLibraryNavigationChanged",
      )(function* (event: LibraryNavigationChangedEvent) {
        yield* broadcast("library-navigation-changed", event);
        yield* PubSub.publish(workInvalidations, undefined);
      });
      const notifyProjectsChanged = Effect.fn("DatabaseNotifierRuntime.notifyProjectsChanged")(
        function* (changeType: ProjectChangeType, projectId?: string) {
          if (!accepting) return;
          yield* PubSub.publish(workInvalidations, undefined);
          yield* PubSub.publish(projectInvalidations, { projectId, changeType });
          yield* broadcast("projects-changed", {
            projectId,
            changeType,
          } satisfies ProjectsChangeEvent);
        },
      );
      const notifyProjectSessionInvalidation = Effect.fn(
        "DatabaseNotifierRuntime.notifyProjectSessionInvalidation",
      )(function* (event: ProjectSessionsChangeEvent) {
        if (!accepting) return;
        yield* Effect.sync(() => {
          const scopeKey = event.summaryScopes
            .map((scope) => (scope.kind === "project" ? scope.projectId : scope.kind))
            .join(",");
          logDevRuntimeMetric("project_sessions_changed.notification", {
            scopeKey,
            summaryScopeCount: event.summaryScopes.length,
            changeType: event.changeType,
            detailScope: event.detailInvalidation.kind,
            detailSessionCount:
              event.detailInvalidation.kind === "sessions"
                ? event.detailInvalidation.sessionIds.length
                : 0,
            windowCount: sink.windowCount(),
          });
        });
        yield* broadcast("project-sessions-changed", event);
        yield* PubSub.publish(projectSessionInvalidations, event);
        yield* PubSub.publish(workInvalidations, undefined);
      });
      const notifyInboxChanged = Effect.fn("DatabaseNotifierRuntime.notifyInboxChanged")(function* (
        event: InboxChangedEvent,
      ) {
        if (!accepting) return;
        yield* broadcast("inbox-changed", event);
        yield* PubSub.publish(inboxInvalidations, event);
      });
      const notifyDatabaseChanged = Effect.fn("DatabaseNotifierRuntime.notifyDatabaseChanged")(
        function* (event: DatabaseChangeEvent) {
          yield* broadcast("database-changed", event);
          yield* PubSub.publish(workInvalidations, undefined);
          if (
            !event.libraryId ||
            (event.affectedDatabaseIds.length === 0 &&
              (event.affectedDataSourceIds?.length ?? 0) === 0 &&
              (event.affectedPageIds?.length ?? 0) === 0 &&
              (event.affectedViewIds?.length ?? 0) === 0)
          ) {
            return;
          }
          yield* notifyLibraryNavigationChanged({
            version: LIBRARY_NAVIGATION_EVENT_VERSION,
            libraryId: event.libraryId,
            storeEpoch: event.storeEpoch,
            commitSeq: event.commitSeq,
            changeKind: "database",
            affectedParentKeys: [
              "library",
              "catalog",
              ...event.affectedDatabaseIds.map((id) => `database:${id}`),
            ],
            affectedPageIds: event.affectedPageIds ?? [],
            affectedDatabaseIds: event.affectedDatabaseIds.map(parseDatabaseId),
            affectedViewIds: (event.affectedViewIds ?? []).map(parseDatabaseViewId),
          });
        },
      );

      return DatabaseNotifierRuntime.of({
        notifyDatabaseChanged,
        notifyLibraryNavigationChanged,
        notifyProjectsChanged,
        notifyProjectSessionInvalidation,
        notifyInboxChanged,
        projectSessionInvalidations: Stream.fromPubSub(projectSessionInvalidations),
        inboxInvalidations: Stream.fromPubSub(inboxInvalidations),
        projectInvalidations: Stream.fromPubSub(projectInvalidations),
        workInvalidations: Stream.fromPubSub(workInvalidations),
      });
    }),
  );

/** Headless consumers observe the same projections without window delivery. */
export const headless = layer({ publish: () => {}, windowCount: () => 0 });
