import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalWorkspacePermissionContext,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { buildCoreWorkspaceThreadSummary, parseThreadStatus } from "./CodexThreadCatalogProjection";
import {
  projectCodexThreadDirectoryMaterialization,
  projectCoreWorkspaceThread,
} from "./CodexThreadDirectoryProjection";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export type CodexThreadDurableProjectionNotification = Extract<
  CodexServerNotification,
  {
    method:
      | "thread/archived"
      | "thread/deleted"
      | "thread/goal/cleared"
      | "thread/goal/updated"
      | "thread/name/updated"
      | "thread/settings/updated"
      | "thread/started"
      | "thread/status/changed"
      | "thread/unarchived"
      | "turn/completed";
  }
>;

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];

export interface CodexThreadDurableProjectionInput {
  readonly hostId: string;
  readonly generation: number;
  readonly notification: CodexThreadDurableProjectionNotification;
  readonly occurrenceId: string;
  readonly occurrenceToken: number;
}

export class CodexThreadDurableProjectionError extends Schema.TaggedError<CodexThreadDurableProjectionError>()(
  "CodexThreadDurableProjectionError",
  { operation: Schema.String, threadId: Schema.String, cause: Schema.Defect() },
) {}

export class CodexThreadDurableProjection extends Context.Service<
  CodexThreadDurableProjection,
  {
    readonly observe: (
      input: CodexThreadDurableProjectionInput,
    ) => Effect.Effect<void, CodexThreadDurableProjectionError>;
  }
>()("nodex/main/codex-application/CodexThreadDurableProjection") {}

export const isCodexThreadDurableProjectionNotification = (
  notification: CodexServerNotification,
): notification is CodexThreadDurableProjectionNotification =>
  notification.method === "thread/archived" ||
  notification.method === "thread/deleted" ||
  notification.method === "thread/goal/cleared" ||
  notification.method === "thread/goal/updated" ||
  notification.method === "thread/name/updated" ||
  notification.method === "thread/settings/updated" ||
  notification.method === "thread/started" ||
  notification.method === "thread/status/changed" ||
  notification.method === "thread/unarchived" ||
  notification.method === "turn/completed";

const threadId = (notification: CodexThreadDurableProjectionNotification): string =>
  notification.method === "thread/started"
    ? notification.params.thread.id
    : notification.params.threadId;

const isCoreNotFound = (cause: unknown): boolean =>
  cause instanceof CoreRuntimeError &&
  cause.cause instanceof CoreModuleResponseError &&
  cause.cause.coreError.code === "not_found";

const fullPagination = (thread: Thread) => ({
  olderCursor: null,
  backwardsCursor: null,
  oldestLoadedTurnId: thread.turns[0]?.id ?? null,
  isLoadingOlder: false,
  hasLoadedOldest: true,
  loadedTurnCount: thread.turns.length,
  itemsView: "full" as const,
});

/**
 * Owns the durable/sidebar meaning of app-server Thread observations. The caller serializes this
 * Effect in the same per-Thread lane as conversation reduction, so deletion and archival cannot
 * race a late item or turn notification.
 */
export const make: Effect.Effect<
  CodexThreadDurableProjection["Service"],
  never,
  | CodexApplicationEventHub
  | CodexConversationProjection
  | CodexSidebarSyncRuntime
  | ConversationEntityMap
  | CoreModules
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const conversationsProjection = yield* CodexConversationProjection;
  const sidebar = yield* CodexSidebarSyncRuntime;
  const conversations = yield* ConversationEntityMap;
  const core = yield* CoreModules;

  const error = (operation: string, id: string, cause: unknown) =>
    new CodexThreadDurableProjectionError({ operation, threadId: id, cause });

  const read = (id: string): Effect.Effect<CoreThread | null, CodexThreadDurableProjectionError> =>
    core.workspace.read({ kind: "thread", thread_id: id }).pipe(
      Effect.flatMap((snapshot) =>
        snapshot.value.kind === "thread"
          ? Effect.succeed(snapshot.value.thread)
          : Effect.fail(error("read", id, new Error("Core returned a non-Thread read variant"))),
      ),
      Effect.catch((cause) =>
        isCoreNotFound(cause)
          ? Effect.succeed(null)
          : Effect.fail(
              cause instanceof CodexThreadDurableProjectionError ? cause : error("read", id, cause),
            ),
      ),
    );

  const publishSummary = (thread: CoreThread): void => {
    events.publish({
      kind: "codex",
      value: { type: "threadSummary", thread: buildCoreWorkspaceThreadSummary(thread) },
    });
  };

  const observeStarted = Effect.fn("CodexThreadDurableProjection.observeStarted")(function* (
    input: CodexThreadDurableProjectionInput & {
      readonly notification: Extract<
        CodexThreadDurableProjectionNotification,
        { method: "thread/started" }
      >;
    },
  ) {
    const observedThread = input.notification.params.thread;
    const thread = { ...observedThread, turns: [] };
    const id = thread.id;
    const existing = yield* read(id);
    const parentId = extractCodexThreadSubagentMetadata(thread).parentThreadId;
    const parent = parentId ? yield* read(parentId) : null;
    const observedAtMs = yield* Clock.currentTimeMillis;
    const materialization = projectCodexThreadDirectoryMaterialization({
      thread,
      existing: existing ? projectCoreWorkspaceThread(existing) : null,
      parent: parent ? projectCoreWorkspaceThread(parent) : null,
      observedExecutionHostId: input.hostId,
      nowMs: observedAtMs,
    });
    if (!materialization) {
      return yield* error("materialize", id, new Error("Thread observation has no identity"));
    }
    yield* core.workspace
      .apply({
        operationId: `codex:notification:${input.occurrenceId}:thread/started:${id}`,
        intent: { kind: "upsert_thread", thread_id: id, patch: materialization.patch },
      })
      .pipe(Effect.mapError((cause) => error("materialize", id, cause)));
    const persisted = yield* read(id);
    if (!persisted) {
      return yield* error("materialize", id, new Error("Core omitted the observed Thread"));
    }
    publishSummary(persisted);

    // thread/started is an identity and metadata notification, never a history transport.
    // A duplicate notification must not replace an already bounded canonical projection.
    if (conversations.current(id)?.readCanonicalState()) return;

    const permissions = createCodexCanonicalWorkspacePermissionContext(persisted.writable_roots);
    const canonical = yield* Effect.try({
      try: () =>
        createCodexCanonicalHydratedConversationState(thread, {
          model: persisted.model_id ?? thread.modelProvider,
          reasoningEffort: persisted.reasoning_effort ?? null,
          cwd: persisted.cwd || thread.cwd || "/",
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          sandboxPolicy: permissions.sandboxPolicy,
          activePermissionProfile: permissions.activePermissionProfile,
          runtimeWorkspaceRoots: [...permissions.runtimeWorkspaceRoots],
          pendingRequests: conversations.current(id)?.readServerRequests() ?? [],
          hasUnreadTurn: persisted.has_unread_turn,
        }),
      catch: (cause) => error("hydrate", id, cause),
    });
    yield* conversationsProjection
      .hydrate({
        threadId: id,
        summary: buildCoreWorkspaceThreadSummary(persisted),
        canonical,
        pagination: fullPagination(thread),
        observedAtMs,
      })
      .pipe(Effect.mapError((cause) => error("hydrate", id, cause)));
  });

  const observe = Effect.fn("CodexThreadDurableProjection.observe")(function* (
    input: CodexThreadDurableProjectionInput,
  ) {
    const notification = input.notification;
    const id = threadId(notification);
    const before = yield* read(id);
    if (notification.method === "thread/started") {
      yield* observeStarted({ ...input, notification });
    } else if (notification.method === "thread/deleted") {
      yield* core.workspace
        .apply({
          operationId: `codex:notification:${input.occurrenceId}:thread/deleted:${id}`,
          intent: { kind: "delete_thread", thread_id: id },
        })
        .pipe(
          Effect.catch((cause) =>
            isCoreNotFound(cause) ? Effect.void : Effect.fail(error("delete", id, cause)),
          ),
        );
      events.publish({ kind: "codex", value: { type: "threadDeleted", threadId: id } });
    } else if (
      notification.method === "thread/archived" ||
      notification.method === "thread/unarchived"
    ) {
      const archived = notification.method === "thread/archived";
      yield* core.workspace
        .apply({
          operationId: `codex:notification:${input.occurrenceId}:${notification.method}:${id}`,
          intent: { kind: "set_thread_archived", thread_id: id, archived },
        })
        .pipe(Effect.mapError((cause) => error("archive", id, cause)));
      const persisted = yield* read(id);
      if (persisted) publishSummary(persisted);
      events.publish({
        kind: "codex",
        value: { type: "threadArchivedState", threadId: id, archived },
      });
    } else if (notification.method === "thread/status/changed") {
      const status = parseThreadStatus(notification.params.status);
      const observedAtMs = yield* Clock.currentTimeMillis;
      yield* core.workspace
        .apply({
          operationId: `codex:notification:${input.occurrenceId}:thread/status/changed:${id}`,
          intent: {
            kind: "update_thread",
            thread_id: id,
            patch: {
              status: {
                status_type: status.statusType,
                active_flags: [...status.statusActiveFlags],
              },
              updated_at: observedAtMs,
            },
          },
        })
        .pipe(Effect.mapError((cause) => error("status", id, cause)));
      const persisted = yield* read(id);
      if (persisted) publishSummary(persisted);
    } else if (notification.method === "thread/name/updated") {
      const observedAtMs = yield* Clock.currentTimeMillis;
      yield* core.workspace
        .apply({
          operationId: `codex:notification:${input.occurrenceId}:thread/name/updated:${id}`,
          intent: {
            kind: "update_thread",
            thread_id: id,
            patch: { thread_name: notification.params.threadName, updated_at: observedAtMs },
          },
        })
        .pipe(Effect.mapError((cause) => error("name", id, cause)));
      const persisted = yield* read(id);
      if (persisted) publishSummary(persisted);
    }

    const after = notification.method === "thread/deleted" ? null : yield* read(id);
    const affectedParents = new Set(
      [before?.parent_thread_id, after?.parent_thread_id].filter(
        (parentThreadId): parentThreadId is string => Boolean(parentThreadId?.trim()),
      ),
    );
    if (affectedParents.size > 0) {
      events.publish({
        kind: "conversationRelationshipsInvalidated",
        value: {
          parentThreadIds: [...affectedParents],
          ...(notification.method === "thread/deleted" ? { removedThreadIds: [id] } : {}),
          ...(notification.method === "thread/started" ? { restoredThreadIds: [id] } : {}),
        },
      });
    }

    sidebar.scheduleNotification({ notificationMethod: notification.method, threadId: id });
  });

  return CodexThreadDurableProjection.of({ observe });
});

export const live = Layer.effect(CodexThreadDurableProjection, make);
