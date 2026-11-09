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
import { safeBroadcastToWindows } from "../ipc-safe-send";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
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
export const live: Layer.Layer<DatabaseNotifierRuntime, never, WindowRuntime> = Layer.effect(
  DatabaseNotifierRuntime,
  Effect.gen(function* () {
    const windows = yield* WindowRuntime;
    const projectSessionInvalidations = yield* PubSub.sliding<ProjectSessionsChangeEvent>(
      MAIN_OBSERVATION_EVENT_CAPACITY,
    );
    const inboxInvalidations = yield* PubSub.sliding<InboxChangedEvent>(
      MAIN_OBSERVATION_EVENT_CAPACITY,
    );
    const projectInvalidations = yield* PubSub.sliding<ProjectsChangeEvent>(
      MAIN_OBSERVATION_EVENT_CAPACITY,
    );
    let accepting = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        accepting = false;
      }).pipe(
        Effect.andThen(PubSub.shutdown(projectSessionInvalidations)),
        Effect.andThen(PubSub.shutdown(inboxInvalidations)),
        Effect.andThen(PubSub.shutdown(projectInvalidations)),
      ),
    );

    const broadcast = Effect.fn("DatabaseNotifierRuntime.broadcast")(function* (
      channel: string,
      payload: unknown,
    ) {
      if (!accepting) return;
      yield* Effect.sync(() => safeBroadcastToWindows(windows.all(), channel, [payload]));
    });
    const notifyLibraryNavigationChanged = Effect.fn(
      "DatabaseNotifierRuntime.notifyLibraryNavigationChanged",
    )(function* (event: LibraryNavigationChangedEvent) {
      yield* broadcast("library-navigation-changed", event);
    });
    const notifyProjectsChanged = Effect.fn("DatabaseNotifierRuntime.notifyProjectsChanged")(
      function* (changeType: ProjectChangeType, projectId?: string) {
        if (!accepting) return;
        const event = { projectId, changeType } satisfies ProjectsChangeEvent;
        yield* broadcast("projects-changed", event);
        yield* PubSub.publish(projectInvalidations, event);
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
          windowCount: windows.count(),
        });
      });
        yield* PubSub.publish(workInvalidations, undefined);
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
    });
  }),
);
