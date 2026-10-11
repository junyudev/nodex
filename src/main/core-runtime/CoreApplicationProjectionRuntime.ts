import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CoreAuthorizedDeliveryAtom, CoreEventEnvelope } from "../core-client";
import {
  allProjectSessionInvalidation,
  planCoreWorkspaceNotifications,
} from "../core-client/core-project-workspace-invalidation";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../logging/logger";
import { AutomationRoutingIndex } from "./AutomationRoutingIndex";
import { projectCoreApplicationEvent } from "./CoreApplicationEventProjection";

export class CoreApplicationProjectionRuntime extends Context.Service<
  CoreApplicationProjectionRuntime,
  {
    readonly publish: (
      envelope: CoreEventEnvelope,
      atom: CoreAuthorizedDeliveryAtom,
      libraryId: string,
    ) => Effect.Effect<void>;
    readonly publishResync: (input: {
      readonly commitSeq: number;
      readonly libraryId: string;
      readonly storeEpoch: string | null;
    }) => Effect.Effect<void>;
  }
>()("nodex/main/core-runtime/CoreApplicationProjectionRuntime") {}

/** Projects causal Core atoms directly into their owning application capabilities. */
export const live: Layer.Layer<
  CoreApplicationProjectionRuntime,
  never,
  AutomationRoutingIndex | CodexApplicationEventHub | DatabaseNotifierRuntime
> = Layer.effect(
  CoreApplicationProjectionRuntime,
  Effect.gen(function* () {
    const automationRouting = yield* AutomationRoutingIndex;
    const codexEvents = yield* CodexApplicationEventHub;
    const notifications = yield* DatabaseNotifierRuntime;
    const logger = getLogger({ component: "core-application-projection-runtime" });

    const publish = Effect.fn("CoreApplicationProjectionRuntime.publish")(function* (
      envelope: CoreEventEnvelope,
      atom: CoreAuthorizedDeliveryAtom,
      libraryId: string,
    ) {
      const projected = projectCoreApplicationEvent(envelope, atom, libraryId);
      if (!projected || projected.kind === "store-administration") return;

      if (projected.kind === "automation") {
        const automationEvent = projected.value;
        yield* automationRouting.synchronize.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              logger.warn("Failed to refresh Automation routing projection", { cause });
            }),
          ),
        );
        for (const automationId of automationEvent.automationIds) {
          codexEvents.publish({
            kind: "codex",
            value: {
              type: "scheduledAutomationChanged",
              event: { automationId, targetThreadId: null, reason: "upsert" },
            },
          });
        }
        if (automationEvent.automationIds.length > 0 || automationEvent.runIds.length > 0) {
          codexEvents.publish({
            kind: "codex",
            value: {
              type: "automationRunsUpdated",
              event: {
                automationId:
                  automationEvent.automationIds.length === 1
                    ? (automationEvent.automationIds[0] ?? null)
                    : null,
                threadId:
                  automationEvent.runIds.length === 1 ? (automationEvent.runIds[0] ?? null) : null,
                reason: "settle",
              },
            },
          });
        }
        return;
      }

      if (projected.kind === "database") {
        const databaseEvent = projected.value;
        yield* notifications.notifyDatabaseChanged(databaseEvent);
        if ((databaseEvent.affectedViewIds ?? []).length > 0) {
          // The Project catalog projects a Database's primary default View.
          yield* notifications.notifyProjectsChanged("update", databaseEvent.projectId);
        }
        return;
      }

      if (projected.kind === "library-navigation") {
        yield* notifications.notifyLibraryNavigationChanged(projected.value);
        return;
      }

      const workspaceEvent = projected.value;
      const planned = planCoreWorkspaceNotifications(workspaceEvent);
      if (planned.project) {
        yield* notifications.notifyProjectsChanged(
          planned.project.changeType,
          planned.project.projectId,
        );
      }
      if (planned.invalidateStandaloneRoots) {
        yield* notifications.notifyLibraryNavigationChanged({
          version: 1,
          libraryId,
          storeEpoch: envelope.packet.manifest.identity.store_epoch,
          commitSeq: envelope.packet.manifest.identity.commit_seq,
          changeKind: "lifecycle",
          affectedParentKeys: ["standalone_roots"],
          affectedPageIds: [],
          affectedDatabaseIds: [],
          affectedViewIds: [],
        });
      }
      if (planned.sessions) {
        yield* notifications.notifyProjectSessionInvalidation(planned.sessions);
      }
      if (workspaceEvent.inboxChanged) {
        yield* notifications.notifyInboxChanged({ reason: "inbox" });
      } else if (planned.sessions) {
        // Dispatched chats render their live status in the Inbox stream.
        yield* notifications.notifyInboxChanged({ reason: "sessions" });
      }
    });

    const publishResync = Effect.fn("CoreApplicationProjectionRuntime.publishResync")(
      function* (input: {
        readonly commitSeq: number;
        readonly libraryId: string;
        readonly storeEpoch: string | null;
      }) {
        yield* notifications.notifyLibraryNavigationChanged({
          version: 1,
          libraryId: input.libraryId,
          storeEpoch: input.storeEpoch,
          commitSeq: input.commitSeq,
          changeKind: "content",
          affectedParentKeys: ["library", "catalog"],
          affectedPageIds: [],
          affectedDatabaseIds: [],
          affectedViewIds: [],
        });
        yield* notifications.notifyProjectsChanged("update");
        yield* notifications.notifyProjectSessionInvalidation(allProjectSessionInvalidation());
        yield* notifications.notifyInboxChanged({ reason: "inbox" });
      },
    );

    return CoreApplicationProjectionRuntime.of({ publish, publishResync });
  }),
);
