import type { ThreadGoal, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  CodexCanonicalWorktreeInitItem,
  CodexCanonicalConversationState,
  CodexCanonicalHydratedPermissionContext,
  CodexCanonicalLiveTurnParams,
  CodexConversationThreadSettings,
  CodexConversationSnapshot,
  CodexConversationResumeState,
  CodexConversationTurnPagination,
  CodexThreadSummary,
  CodexThreadStatusType,
} from "../../shared/types";
import type { CodexCanonicalSteeringUserMessageItem } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import { flattenCodexHistoryTopology } from "../../shared/codex-conversation-state/codex-history-topology";
import type { ConversationEntityState } from "./internal/ConversationEntityState";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { buildCodexCanonicalTurnSummary } from "./CodexConversationServerRequestProjection";
import { buildCoreWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";
import { projectCodexThreadDirectorySnapshot } from "./CodexThreadDirectoryProjection";
import { projectCodexConversationHistoryItemWindows } from "./CodexConversationHistoryProjection";
import type { CodexHydratedHistoryItemSegment } from "./CodexHistoryPageAdapter";

export interface CodexConversationProjectionState {
  readonly canonical: CodexCanonicalConversationState;
  readonly snapshot: CodexConversationSnapshot | null;
}

export class CodexConversationProjectionError extends Schema.TaggedError<CodexConversationProjectionError>()(
  "CodexConversationProjectionError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface CodexConversationProjectionService {
  readonly read: (
    threadId: string,
  ) => Effect.Effect<CodexConversationProjectionState, CodexConversationProjectionError>;
  readonly hydrate: (input: {
    readonly threadId: string;
    readonly summary: CodexThreadSummary;
    readonly canonical: CodexCanonicalConversationState;
    readonly pagination: CodexConversationTurnPagination;
    readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    readonly itemSegmentsByTurnId?: Readonly<
      Record<string, readonly CodexHydratedHistoryItemSegment[]>
    >;
    readonly observedAtMs: number;
    readonly resumeState?: CodexConversationResumeState;
  }) => Effect.Effect<CodexConversationSnapshot, CodexConversationProjectionError>;
  readonly admitTurn: (input: {
    readonly threadId: string;
    readonly params: CodexCanonicalLiveTurnParams;
    readonly currentCollaborationModel?: string;
    readonly startedAtMs: number;
    readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly configureTurn: (input: {
    readonly threadId: string;
    readonly settings: CodexConversationThreadSettings;
    readonly permissions: CodexCanonicalHydratedPermissionContext;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly renameThread: (input: {
    readonly threadId: string;
    readonly name: string;
    readonly observedAtMs: number;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly acceptThreadGoal: (input: {
    readonly threadId: string;
    readonly goal: ThreadGoal;
    readonly appendTranscriptItem: boolean;
    readonly dismissResumeConfirmation: boolean;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly admitManualCompaction: (input: {
    readonly threadId: string;
    readonly observedAtMs: number;
  }) => Effect.Effect<{ readonly turnId: string | null }, CodexConversationProjectionError>;
  readonly rollbackManualCompaction: (input: {
    readonly threadId: string;
    readonly observedAtMs: number;
  }) => Effect.Effect<void>;
  readonly relocateExecution: (input: {
    readonly threadId: string;
    readonly cwd: string;
    readonly managedWorktreePath: string | null;
    readonly projectId: string | null;
    readonly projectlessOutputDirectory: string | null;
    readonly projectlessWorkspaceBrowserRoot: string | null;
    readonly permissions: CodexCanonicalHydratedPermissionContext;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly acceptTurn: (input: {
    readonly threadId: string;
    readonly clientUserMessageId: string;
    readonly turn: Turn;
    readonly recovery?: {
      readonly params: CodexCanonicalLiveTurnParams;
      readonly currentCollaborationModel?: string;
      readonly startedAtMs: number;
    };
    readonly observedAtMs: number;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly rejectTurn: (input: {
    readonly threadId: string;
    readonly clientUserMessageId: string;
    readonly failureItemId: `${string}-${string}-${string}-${string}-${string}`;
    readonly observedAtMs: number;
  }) => Effect.Effect<void>;
  readonly admitSteer: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly item: CodexCanonicalSteeringUserMessageItem;
    readonly observedAtMs: number;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly rejectSteer: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly observedAtMs: number;
  }) => Effect.Effect<void>;
  readonly resolveInterruptTurn: (
    threadId: string,
    requestedTurnId?: string,
  ) => Effect.Effect<string, CodexConversationProjectionError>;
  readonly interruptTurn: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly observedAtMs: number;
  }) => Effect.Effect<boolean>;
  readonly backgroundTerminalTurnIds: (threadId: string) => Effect.Effect<readonly string[] | null>;
  readonly backgroundTerminalsCleaned: (
    threadId: string,
    observedAtMs: number,
  ) => Effect.Effect<void>;
  readonly markThreadActive: (
    threadId: string,
  ) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly reconcileThreadStatus: (
    threadId: string,
  ) => Effect.Effect<void, CodexConversationProjectionError>;
  readonly commitInterruptedTurn: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly observedAtMs: number;
  }) => Effect.Effect<void, CodexConversationProjectionError>;
}

export class CodexConversationProjection extends Context.Service<
  CodexConversationProjection,
  CodexConversationProjectionService
>()("nodex/main/codex-application/CodexConversationProjection") {}

/**
 * The canonical application projection for one Profile. Commands name semantic outcomes;
 * the Module keeps canonical mutation and dormant accepted-replica revisioning coherent. A live
 * renderer owner remains the sole authority for publishing and advancing its accepted replica.
 */
export const make: Effect.Effect<
  CodexConversationProjectionService,
  never,
  ConversationEntityMap | CodexRendererConversationRegistry | CodexApplicationEventHub | CoreModules
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const rendererConversations = yield* CodexRendererConversationRegistry;
  const events = yield* CodexApplicationEventHub;
  const core = yield* CoreModules;

  const aggregate = (threadId: string) => conversations.current(threadId);
  const projectReplica = (threadId: string): boolean => !rendererConversations.hasOwner(threadId);
  const publish = (value: import("../../shared/types").CodexEvent): void =>
    events.publish({ kind: "codex", value });

  const updateDurableStatus = (
    threadId: string,
    statusType: CodexThreadStatusType,
    updatedAt: number,
  ): Effect.Effect<CodexThreadSummary | null, CodexConversationProjectionError> => {
    const current = aggregate(threadId)?.readSnapshot();
    if (current?.ephemeral) return Effect.succeed(null);
    return core.workspace
      .apply({
        operationId: createOperationId("conversation.thread-status"),
        intent: {
          kind: "update_thread",
          thread_id: threadId,
          patch: {
            status: { status_type: statusType, active_flags: [] },
            updated_at: updatedAt,
          },
        },
      })
      .pipe(
        Effect.andThen(core.workspace.read({ kind: "thread", thread_id: threadId })),
        Effect.flatMap((snapshot) =>
          snapshot.value.kind === "thread"
            ? Effect.succeed(buildCoreWorkspaceThreadSummary(snapshot.value.thread))
            : Effect.fail(
                new CodexConversationProjectionError({
                  operation: "persist-thread-status",
                  threadId,
                  cause: new Error("Core returned the wrong Thread read variant"),
                }),
              ),
        ),
        Effect.catch((cause) =>
          cause.cause instanceof CoreModuleResponseError &&
          cause.cause.coreError.code === "not_found"
            ? Effect.succeed(null)
            : Effect.fail(
                cause instanceof CodexConversationProjectionError
                  ? cause
                  : new CodexConversationProjectionError({
                      operation: "persist-thread-status",
                      threadId,
                      cause,
                    }),
              ),
        ),
      );
  };

  const commitStatus = (
    threadId: string,
    statusType: CodexThreadStatusType,
    observedAtMs: number,
  ) =>
    Effect.gen(function* () {
      aggregate(threadId)?.setThreadStatus(statusType, projectReplica(threadId));
      const summary = yield* updateDurableStatus(threadId, statusType, observedAtMs);
      if (summary) publish({ type: "threadSummary", thread: summary });
      publish({ type: "threadStatus", threadId, statusType, statusActiveFlags: [] });
    });

  const canonicalStatus = (threadId: string): CodexThreadStatusType =>
    aggregate(threadId)
      ?.readCanonicalState()
      ?.turns.some((turn) => turn.protocol.status === "inProgress")
      ? "active"
      : "idle";

  const required = (operation: string, threadId: string) =>
    Effect.suspend(() => {
      const conversation = aggregate(threadId);
      return conversation
        ? Effect.succeed(conversation)
        : Effect.fail(
            new CodexConversationProjectionError({
              operation,
              threadId,
              cause: new Error(`Canonical conversation '${threadId}' is not loaded`),
            }),
          );
    });

  const requireChanged = (
    operation: string,
    threadId: string,
    change: (conversation: ConversationEntityState) => boolean,
  ) =>
    required(operation, threadId).pipe(
      Effect.flatMap((conversation) =>
        Effect.try({
          try: () => {
            if (!change(conversation)) {
              throw new Error(`Canonical ${operation} did not match '${threadId}'`);
            }
          },
          catch: (cause) => new CodexConversationProjectionError({ operation, threadId, cause }),
        }),
      ),
    );

  return CodexConversationProjection.of({
    read: (threadId) =>
      required("read", threadId).pipe(
        Effect.flatMap((conversation) => {
          const canonical = conversation.readCanonicalState();
          return canonical
            ? Effect.succeed({ canonical, snapshot: conversation.readSnapshot() })
            : Effect.fail(
                new CodexConversationProjectionError({
                  operation: "read",
                  threadId,
                  cause: new Error(`Canonical conversation '${threadId}' is not hydrated`),
                }),
              );
        }),
      ),
    hydrate: (input) =>
      Effect.try({
        try: () => {
          const conversation = conversations.entity(input.threadId);
          const before = conversation.readCanonicalState();
          const accepted = conversation.read().acceptedReplica;
          const resumeState = input.resumeState ?? "resumed";
          conversation.acceptCanonicalState(input.canonical);
          conversation.initializeHistory(
            input.pagination,
            input.canonical.turns.length,
            input.itemsPaginationByTurnId,
          );
          const projectedSnapshot = projectCodexThreadDirectorySnapshot({
            summary: input.summary,
            current: conversation.readSnapshot(),
            before,
            after: input.canonical,
            pagination: conversation.readTurnPagination(),
            itemsPaginationByTurnId: conversation.readAllTurnItemsPagination(),
            historyRows: flattenCodexHistoryTopology(conversation.readHistoryTopology()),
            historyTopologyGeneration: conversation.readHistoryTopology().generation,
            observedAtMs: input.observedAtMs,
            resumeState,
          });
          const snapshot = input.itemSegmentsByTurnId
            ? {
                ...projectedSnapshot,
                historyItemWindowsByTurnId: projectCodexConversationHistoryItemWindows({
                  canonical: input.canonical,
                  snapshot: projectedSnapshot,
                  itemsPaginationByTurnId: conversation.readAllTurnItemsPagination(),
                  itemSegmentsByTurnId: input.itemSegmentsByTurnId,
                }),
              }
            : projectedSnapshot;
          conversation.installSnapshot(snapshot);
          conversation.setResumeState(resumeState);
          const installedSnapshot = conversation.readSnapshot() ?? snapshot;
          if (projectReplica(input.threadId) && accepted) {
            return conversation.advanceReplica({
              conversation: installedSnapshot,
              ownerEpoch: accepted.checkpoint.ownerEpoch,
            }).replica.conversation;
          }
          return installedSnapshot;
        },
        catch: (cause) =>
          new CodexConversationProjectionError({
            operation: "hydrate",
            threadId: input.threadId,
            cause,
          }),
      }),
    admitTurn: (input) =>
      requireChanged("admit-turn", input.threadId, (conversation) =>
        conversation.admitOptimisticTurn({
          params: input.params,
          ...(input.currentCollaborationModel
            ? { currentCollaborationModel: input.currentCollaborationModel }
            : {}),
          startedAtMs: input.startedAtMs,
          ...(input.worktreeInit ? { worktreeInit: input.worktreeInit } : {}),
          projectReplica: projectReplica(input.threadId),
        }),
      ),
    configureTurn: (input) =>
      requireChanged("configure-turn", input.threadId, (conversation) =>
        conversation.applyTurnConfiguration({
          settings: input.settings,
          permissions: input.permissions,
          projectReplica: projectReplica(input.threadId),
        }),
      ),
    renameThread: (input) =>
      required("rename-thread", input.threadId).pipe(
        Effect.flatMap((conversation) =>
          Effect.try({
            try: () => {
              conversation.renameThread({
                name: input.name,
                observedAtMs: input.observedAtMs,
                projectReplica: projectReplica(input.threadId),
              });
            },
            catch: (cause) =>
              new CodexConversationProjectionError({
                operation: "rename-thread",
                threadId: input.threadId,
                cause,
              }),
          }),
        ),
      ),
    acceptThreadGoal: (input) =>
      required("accept-thread-goal", input.threadId).pipe(
        Effect.flatMap((conversation) =>
          Effect.try({
            try: () => {
              conversation.acceptThreadGoal({
                goal: input.goal,
                appendTranscriptItem: input.appendTranscriptItem,
                dismissResumeConfirmation: input.dismissResumeConfirmation,
                projectReplica: projectReplica(input.threadId),
              });
            },
            catch: (cause) =>
              new CodexConversationProjectionError({
                operation: "accept-thread-goal",
                threadId: input.threadId,
                cause,
              }),
          }),
        ),
      ),
    admitManualCompaction: (input) =>
      required("admit-manual-compaction", input.threadId).pipe(
        Effect.flatMap((conversation) =>
          Effect.try({
            try: () => {
              const turnId = conversation.admitManualCompaction({
                observedAtMs: input.observedAtMs,
                projectReplica: projectReplica(input.threadId),
              });
              if (turnId !== null) {
                const turn = conversation
                  .readCanonicalState()
                  ?.turns.find((candidate) => candidate.protocol.id === turnId);
                if (turn) {
                  publish({
                    type: "turn",
                    turn: buildCodexCanonicalTurnSummary(
                      input.threadId,
                      turn,
                      turn.items.map((item) => item.id),
                    ),
                  });
                }
              }
              return { turnId };
            },
            catch: (cause) =>
              new CodexConversationProjectionError({
                operation: "admit-manual-compaction",
                threadId: input.threadId,
                cause,
              }),
          }),
        ),
      ),
    rollbackManualCompaction: (input) =>
      Effect.sync(() => {
        const conversation = aggregate(input.threadId);
        if (!conversation) return;
        conversation.rollbackManualCompaction({
          observedAtMs: input.observedAtMs,
          projectReplica: projectReplica(input.threadId),
        });
      }),
    relocateExecution: (input) =>
      requireChanged("relocate-execution", input.threadId, (conversation) =>
        conversation.relocateExecution({
          cwd: input.cwd,
          managedWorktreePath: input.managedWorktreePath,
          projectId: input.projectId,
          projectlessOutputDirectory: input.projectlessOutputDirectory,
          projectlessWorkspaceBrowserRoot: input.projectlessWorkspaceBrowserRoot,
          permissions: input.permissions,
          projectReplica: projectReplica(input.threadId),
        }),
      ),
    acceptTurn: (input) =>
      requireChanged("accept-turn", input.threadId, (conversation) =>
        conversation.acceptOptimisticTurn({
          clientUserMessageId: input.clientUserMessageId,
          turn: input.turn,
          ...(input.recovery ? { recovery: input.recovery } : {}),
          observedAtMs: input.observedAtMs,
          projectReplica: projectReplica(input.threadId),
        }),
      ),
    rejectTurn: (input) =>
      Effect.sync(() => {
        const conversation = aggregate(input.threadId);
        if (!conversation) return;
        if (
          conversation.rejectOptimisticTurn({
            clientUserMessageId: input.clientUserMessageId,
            failureItemId: input.failureItemId,
            observedAtMs: input.observedAtMs,
            projectReplica: projectReplica(input.threadId),
          })
        )
          return;
      }),
    admitSteer: (input) =>
      requireChanged("admit-steer", input.threadId, (conversation) =>
        conversation.admitSteeringItem({
          turnId: input.turnId,
          item: input.item,
          observedAtMs: input.observedAtMs,
          projectReplica: projectReplica(input.threadId),
        }),
      ),
    rejectSteer: (input) =>
      Effect.sync(() => {
        const conversation = aggregate(input.threadId);
        if (!conversation) return;
        if (
          conversation.rejectSteeringItem({
            turnId: input.turnId,
            itemId: input.itemId,
            observedAtMs: input.observedAtMs,
            projectReplica: projectReplica(input.threadId),
          })
        )
          return;
      }),
    resolveInterruptTurn: (threadId, requestedTurnId) =>
      requestedTurnId?.trim()
        ? Effect.succeed(requestedTurnId.trim())
        : required("resolve-interrupt-turn", threadId).pipe(
            Effect.flatMap((conversation) => {
              const turnId = conversation.resolveInterruptTurnId(requestedTurnId);
              return turnId
                ? Effect.succeed(turnId)
                : Effect.fail(
                    new CodexConversationProjectionError({
                      operation: "resolve-interrupt-turn",
                      threadId,
                      cause: new Error("Could not determine which turn to interrupt"),
                    }),
                  );
            }),
          ),
    interruptTurn: (input) =>
      Effect.sync(() => {
        const changed =
          aggregate(input.threadId)?.interruptTurn({
            turnId: input.turnId,
            observedAtMs: input.observedAtMs,
            projectReplica: projectReplica(input.threadId),
          }) ?? false;
        return changed;
      }),
    backgroundTerminalTurnIds: (threadId) =>
      Effect.sync(() => aggregate(threadId)?.backgroundTerminalTurnIds() ?? null),
    backgroundTerminalsCleaned: (threadId, observedAtMs) =>
      Effect.sync(() => {
        aggregate(threadId)?.cleanBackgroundTerminals({
          observedAtMs,
          projectReplica: projectReplica(threadId),
        });
      }),
    markThreadActive: (threadId) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((observedAtMs) => commitStatus(threadId, "active", observedAtMs)),
      ),
    reconcileThreadStatus: (threadId) =>
      Effect.gen(function* () {
        const observedAtMs = yield* Clock.currentTimeMillis;
        const statusType = canonicalStatus(threadId);
        yield* commitStatus(threadId, statusType, observedAtMs);
      }),
    commitInterruptedTurn: (input) =>
      Effect.gen(function* () {
        aggregate(input.threadId)?.interruptTurn({
          turnId: input.turnId,
          observedAtMs: input.observedAtMs,
          projectReplica: projectReplica(input.threadId),
        });
        const canonical = aggregate(input.threadId)?.readCanonicalState() ?? null;
        const statusType = canonicalStatus(input.threadId);
        yield* commitStatus(input.threadId, statusType, input.observedAtMs);
        const turn = canonical?.turns.find((candidate) => candidate.protocol.id === input.turnId);
        if (turn) {
          publish({
            type: "turn",
            turn: buildCodexCanonicalTurnSummary(
              input.threadId,
              turn,
              turn.items.map((item) => item.id),
            ),
          });
        }
      }),
  });
});
