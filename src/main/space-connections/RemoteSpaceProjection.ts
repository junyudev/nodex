import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { CoreApplicationProjectionRuntime } from "../core-runtime/CoreApplicationProjectionRuntime";
import {
  planCoreWorkspaceNotifications,
  allProjectSessionInvalidation,
} from "../core-client/core-project-workspace-invalidation";
import { projectCoreApplicationEvent } from "../core-runtime/CoreApplicationEventProjection";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";

const mergeSessionChanges = (
  previous: ProjectSessionsChangeEvent | null,
  next: ProjectSessionsChangeEvent,
): ProjectSessionsChangeEvent => {
  const scopes = [...(previous?.summaryScopes ?? []), ...next.summaryScopes];
  const summaryScopes =
    scopes.some((scope) => scope.kind === "all") || scopes.length > 128
      ? [{ kind: "all" as const }]
      : [...new Map(scopes.map((scope) => [JSON.stringify(scope), scope])).values()];
  const details = [...(previous ? [previous.detailInvalidation] : []), next.detailInvalidation];
  const sessionIds = [
    ...new Set(details.flatMap((detail) => (detail.kind === "sessions" ? detail.sessionIds : []))),
  ];
  return {
    changeType: "update",
    summaryScopes,
    detailInvalidation:
      details.some((detail) => detail.kind === "all") || sessionIds.length > 128
        ? { kind: "all" }
        : { kind: "sessions", sessionIds },
  };
};

/** Read-model fanout only: no Coordinator, Agent Runtime, scheduler or Source producer.
 * A Space rename on the host rereads the name for this desktop's switcher and Home title. */
export const live = (spaceRenamed: Effect.Effect<void>) =>
  Layer.effect(
    CoreApplicationProjectionRuntime,
    Effect.gen(function* () {
      const notifier = yield* DatabaseNotifierRuntime;
      const scope = yield* Effect.scope;
      let sessions: ProjectSessionsChangeEvent | null = null;
      let inbox = false;
      // Host execution emits bursts of metadata commits. One bounded repair per second
      // keeps the remote Desktop within Core's request budget without delaying commit delivery.
      yield* Effect.forever(
        Effect.sleep("1 second").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const pendingSessions = sessions;
              const pendingInbox = inbox;
              sessions = null;
              inbox = false;
              if (pendingSessions)
                yield* notifier.notifyProjectSessionInvalidation(pendingSessions);
              if (pendingInbox) yield* notifier.notifyInboxChanged({ reason: "content" });
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);
      return CoreApplicationProjectionRuntime.of({
        publish: (envelope, atom, libraryId) =>
          Effect.gen(function* () {
            const projected = projectCoreApplicationEvent(envelope, atom, libraryId);
            if (!projected) return;
            if (projected.kind === "store-administration") {
              if (projected.value.operation === "rename_space")
                yield* spaceRenamed.pipe(Effect.forkIn(scope, { startImmediately: true }));
              return;
            }
            if (projected.kind === "database")
              return yield* notifier.notifyDatabaseChanged(projected.value);
            if (projected.kind === "library-navigation") {
              yield* notifier.notifyLibraryNavigationChanged(projected.value);
              if (projected.value.affectedPageIds.length > 0) inbox = true;
              return;
            }
            if (projected.kind === "automation") {
              if (projected.value.automationIds.length === 0 && projected.value.runIds.length === 0)
                return;
              inbox = true;
              return;
            }
            if (projected.kind !== "project-workspace") return;
            const planned = planCoreWorkspaceNotifications(projected.value);
            if (planned.sessions) sessions = mergeSessionChanges(sessions, planned.sessions);
            if (planned.project)
              yield* notifier.notifyProjectsChanged(
                planned.project.changeType,
                planned.project.projectId,
              );
            if (projected.value.inboxChanged || planned.sessions) inbox = true;
          }),
        publishResync: () =>
          notifier.notifyProjectsChanged("update").pipe(
            Effect.andThen(
              Effect.sync(() => {
                sessions = allProjectSessionInvalidation();
                inbox = true;
              }),
            ),
          ),
      });
    }),
  );
