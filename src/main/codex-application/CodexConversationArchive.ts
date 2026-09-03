import * as path from "node:path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { CodexThreadSummary } from "../../shared/types";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import {
  hasCompleteAutomationArchiveExchange,
  readBoundedAutomationArchiveExcerpt,
  resolveAutomationArchiveMessagesFromTranscript,
  type AutomationArchiveMessages,
} from "../automation-application/AutomationArchiveExcerpt";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import {
  normalizeWorktreePathForIdentity,
  resolveWorktreePathComparisonKey,
} from "../codex/codex-managed-worktree-effects";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { isCodexThreadLifecycleAlreadyAppliedRequestError } from "../codex-runtime/CodexRuntimeError";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
  type ProjectWorkspaceError,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import {
  CodexSubagentDirectory,
  type CodexSubagentLifecycleSnapshot,
} from "./CodexSubagentDirectory";
import { buildWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";
import { NodexAgentAuthorizationRuntime } from "./NodexAgentAuthorizationRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";

export class CodexConversationArchiveError extends Data.TaggedError(
  "CodexConversationArchiveError",
)<{
  readonly operation:
    | "archive"
    | "archive-worktree"
    | "delete"
    | "read-thread"
    | "resolve-root-thread"
    | "unarchive";
  readonly threadId: string;
  readonly cause: unknown;
}> {}

/**
 * Keeps an ambiguous physical lifecycle failure and the authoritative reconciliation outcome
 * together. Callers can distinguish a bounded-but-incomplete postcondition pass from a failure
 * to perform that pass without parsing error text, while retaining the original transport error.
 */
export class CodexConversationLifecycleReconciliationError extends Data.TaggedError(
  "CodexConversationLifecycleReconciliationError",
)<{
  readonly action: "archive" | "delete";
  readonly operationId: string;
  readonly reason: "postcondition-unresolved" | "reconciliation-failed";
  readonly snapshot: CodexSubagentLifecycleSnapshot | null;
  readonly physicalCause: unknown | null;
  readonly reconciliationCause: unknown | null;
  readonly message: string;
}> {}

export class CodexConversationArchive extends Context.Service<
  CodexConversationArchive,
  {
    readonly archive: (threadId: string) => Effect.Effect<boolean, CodexConversationArchiveError>;
    readonly deleteArchived: (
      threadId: string,
    ) => Effect.Effect<boolean, CodexConversationArchiveError>;
    readonly unarchive: (
      threadId: string,
    ) => Effect.Effect<CodexThreadSummary | null, CodexConversationArchiveError>;
  }
>()("nodex/main/codex-application/CodexConversationArchive") {}

type ArchiveOperation = CodexConversationArchiveError["operation"];

const isPathWithinOrEqual = (parentPath: string, candidatePath: string): boolean => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const make: Effect.Effect<
  CodexConversationArchive["Service"],
  never,
  | AutomationApplication
  | AutomationRoutingIndex
  | CodexApplicationEventHub
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexHistoryPageAdapter
  | CodexSubagentDirectory
  | ConversationEntityMap
  | ManagedWorktreeRuntime
  | NodexAgentAuthorizationRuntime
  | ProjectWorkspace
  | RemoteHostedPipRuntime
> = Effect.gen(function* () {
  const automation = yield* AutomationApplication;
  const automationRouting = yield* AutomationRoutingIndex;
  const events = yield* CodexApplicationEventHub;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const historyPages = yield* CodexHistoryPageAdapter;
  const subagents = yield* CodexSubagentDirectory;
  const conversations = yield* ConversationEntityMap;
  const managedWorktrees = yield* ManagedWorktreeRuntime;
  const authorizations = yield* NodexAgentAuthorizationRuntime;
  const workspace = yield* ProjectWorkspace;
  const remoteHostedPip = yield* RemoteHostedPipRuntime;

  const fail = (
    operation: ArchiveOperation,
    threadId: string,
    cause: unknown,
  ): CodexConversationArchiveError =>
    new CodexConversationArchiveError({ operation, threadId, cause });
  const project = <A>(
    operation: ArchiveOperation,
    threadId: string,
    effect: Effect.Effect<A, ProjectWorkspaceError>,
  ): Effect.Effect<A, CodexConversationArchiveError> =>
    effect.pipe(Effect.mapError((cause) => fail(operation, threadId, cause)));
  const resolvePath = (threadId: string, value: string) =>
    Effect.tryPromise({
      try: () => resolveWorktreePathComparisonKey(value),
      catch: (cause) => fail("archive-worktree", threadId, cause),
    });

  const reconcilePhysicalLifecycle = Effect.fn(
    "CodexConversationArchive.reconcilePhysicalLifecycle",
  )(function* (input: {
    readonly action: "archive" | "delete";
    readonly threadId: string;
    readonly operationId: string;
    readonly physicalCause: unknown | null;
  }) {
    const reconciled = yield* subagents.reconcileLifecycle({ operationId: input.operationId }).pipe(
      Effect.mapError((reconciliationCause) =>
        fail(
          input.action,
          input.threadId,
          new CodexConversationLifecycleReconciliationError({
            action: input.action,
            operationId: input.operationId,
            reason: "reconciliation-failed",
            snapshot: null,
            physicalCause: input.physicalCause,
            reconciliationCause,
            message: `${input.action === "archive" ? "Archive" : "Delete"} lifecycle ${input.operationId} could not verify its durable postconditions`,
          }),
        ),
      ),
    );
    if (!reconciled.complete) {
      return yield* fail(
        input.action,
        input.threadId,
        new CodexConversationLifecycleReconciliationError({
          action: input.action,
          operationId: reconciled.operationId,
          reason: "postcondition-unresolved",
          snapshot: reconciled,
          physicalCause: input.physicalCause,
          reconciliationCause: null,
          message: `${input.action === "archive" ? "Archived" : "Deleted"} Thread still has ${reconciled.unresolvedCount} unresolved Subagent descendants in lifecycle ${reconciled.operationId}`,
        }),
      );
    }
    if (input.physicalCause !== null) {
      yield* Effect.logWarning(
        `${input.action === "archive" ? "Archive" : "Delete"} physical request failed after its durable postconditions had converged`,
      ).pipe(
        Effect.annotateLogs({
          threadId: input.threadId,
          operationId: input.operationId,
          physicalCause: input.physicalCause,
        }),
      );
    }
    return reconciled;
  });

  const retireRemoteHostedPip = Effect.fn("CodexConversationArchive.retireRemoteHostedPip")(
    function* (action: "archive" | "delete", threadIds: readonly string[]) {
      yield* remoteHostedPip
        .retireCodexThreads({ action, threadIds })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Persisted Thread lifecycle with incomplete PiP retirement").pipe(
              Effect.annotateLogs({ action, threadCount: threadIds.length, cause }),
            ),
          ),
        );
    },
  );

  const resolveRootThreadId = Effect.fn("CodexConversationArchive.resolveRootThreadId")(function* (
    thread: DesktopProjectWorkspaceThread,
  ) {
    let current = thread;
    const visited = new Set<string>();
    while (!visited.has(current.threadId)) {
      visited.add(current.threadId);
      const parentThreadId = current.parentThreadId?.trim();
      if (!parentThreadId) return current.threadId;
      const parent = yield* project(
        "resolve-root-thread",
        thread.threadId,
        workspace.getThread(parentThreadId),
      );
      if (!parent) return current.threadId;
      current = parent;
    }
    return thread.threadId;
  });

  /**
   * Applies the physical lifecycle consequence before the Thread becomes archived. A shared
   * worktree first receives a durable replacement owner; a final consumer must finish its
   * required-snapshot removal. Failure therefore leaves Core's execution coordinates intact.
   */
  const prepareManagedWorktreeArchive = Effect.fn(
    "CodexConversationArchive.prepareManagedWorktreeArchive",
  )(function* (thread: DesktopProjectWorkspaceThread, reason: "archive" | "automation-archive") {
    const worktreeGitRoot = thread.managedWorktreePath?.trim();
    if (!worktreeGitRoot) return;

    const lifecycle = yield* project(
      "archive-worktree",
      thread.threadId,
      workspace.readManagedWorktreeLifecycleSnapshot,
    );
    const normalizedPath = normalizeWorktreePathForIdentity(worktreeGitRoot);
    const replacement = lifecycle.consumers
      .filter(
        (consumer) =>
          consumer.threadId !== thread.threadId &&
          !consumer.archived &&
          consumer.executionHostId === thread.executionHostId &&
          normalizeWorktreePathForIdentity(consumer.managedWorktreePath) === normalizedPath &&
          consumer.cwd !== null &&
          isPathWithinOrEqual(worktreeGitRoot, consumer.cwd),
      )
      .sort((left, right) => {
        const activeDelta =
          Number(right.statusType === "active") - Number(left.statusType === "active");
        return activeDelta || right.updatedAt - left.updatedAt;
      })[0];
    if (replacement) {
      yield* managedWorktrees
        .setOwner({
          hostId: thread.executionHostId,
          worktreeGitRoot,
          ownerThreadId: replacement.threadId,
        })
        .pipe(Effect.mapError((cause) => fail("archive-worktree", thread.threadId, cause)));
      return;
    }

    if (thread.executionHostId === CODEX_APP_LOCAL_HOST_ID) {
      const worktreeKey = yield* resolvePath(thread.threadId, worktreeGitRoot);
      const permanentKeys = yield* Effect.forEach(
        lifecycle.projects.flatMap((entry) => entry.sourceRoots),
        (root) => resolvePath(thread.threadId, root),
        { concurrency: "unbounded" },
      );
      if (permanentKeys.includes(worktreeKey)) return;
    }
    if (
      yield* managedWorktrees.isNewborn({
        hostId: thread.executionHostId,
        worktreeGitRoot,
      })
    ) {
      return;
    }

    yield* managedWorktrees
      .remove({
        hostId: thread.executionHostId,
        worktreeGitRoot,
        reason,
      })
      .pipe(Effect.mapError((cause) => fail("archive-worktree", thread.threadId, cause)));
  });

  const resolveAutomationMessages = (
    threadId: string,
  ): Effect.Effect<AutomationArchiveMessages> => {
    const snapshot = conversations.current(threadId)?.readSnapshot() ?? null;
    const local = snapshot
      ? resolveAutomationArchiveMessagesFromTranscript(snapshot.turns.flatMap((turn) => turn.items))
      : { archivedUserMessage: null, archivedAssistantMessage: null };
    if (hasCompleteAutomationArchiveExchange(local)) return Effect.succeed(local);
    return readBoundedAutomationArchiveExcerpt(historyPages, capabilities, threadId, local).pipe(
      Effect.tap((excerpt) =>
        excerpt.resolution === "truncated"
          ? Effect.logWarning("Automation archive excerpt reached its bounded read limit").pipe(
              Effect.annotateLogs({
                threadId,
                truncationReason: excerpt.truncationReason,
                inspectedTurnCount: excerpt.inspectedTurnCount,
                inspectedItemCount: excerpt.inspectedItemCount,
                approximateProjectedBytes: excerpt.approximateProjectedBytes,
              }),
            )
          : Effect.void,
      ),
      Effect.map((excerpt) => excerpt.messages),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read bounded Thread excerpt for Automation archive").pipe(
          Effect.annotateLogs({ threadId, cause }),
          Effect.as(local),
        ),
      ),
    );
  };

  const finishAutomationArchive = (
    threadId: string,
    automationId: string,
    messages: AutomationArchiveMessages,
  ) =>
    Effect.gen(function* () {
      const archived = yield* automation.runs.archive({
        threadId,
        archivedReason: "auto",
        ...messages,
      });
      if (archived) {
        events.publish({
          kind: "codex",
          value: {
            type: "automationRunsUpdated",
            event: { automationId, threadId, reason: "archive" },
          },
        });
      }
      const heartbeatAutomationId = automationRouting.activeHeartbeatAutomationId(threadId);
      if (!heartbeatAutomationId) return;
      const deleted = yield* automation.definitions.delete(heartbeatAutomationId);
      if (!deleted.success) return;
      events.publish({
        kind: "codex",
        value: {
          type: "scheduledAutomationChanged",
          event: {
            automationId: heartbeatAutomationId,
            targetThreadId: threadId,
            reason: "delete",
          },
        },
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Archived Thread with incomplete Automation metadata cleanup").pipe(
          Effect.annotateLogs({ threadId, automationId, cause }),
        ),
      ),
    );

  return CodexConversationArchive.of({
    archive: (threadId) => {
      let admittedCodex = false;
      let physicalAttempted = false;
      const normalizedThreadId = threadId.trim();
      return Effect.gen(function* () {
        const thread = yield* project(
          "read-thread",
          normalizedThreadId,
          workspace.getThread(normalizedThreadId),
        );
        if (!thread) return false;
        if (!isCodexAgentBackendBinding(thread.backendBinding)) {
          return yield* fail(
            "archive",
            normalizedThreadId,
            new Error("Thread is not owned by the native Codex backend"),
          );
        }
        admittedCodex = true;

        const rootThreadId = yield* resolveRootThreadId(thread);
        const automationRun = yield* automation.runs
          .get(normalizedThreadId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not inspect Automation metadata before archiving Thread",
              ).pipe(Effect.annotateLogs({ threadId: normalizedThreadId, cause }), Effect.as(null)),
            ),
          );
        const automationMessages = automationRun
          ? yield* resolveAutomationMessages(normalizedThreadId)
          : null;

        const subagentLifecycle = yield* subagents
          .beginLifecycle({ rootThreadId: normalizedThreadId, action: "archive" })
          .pipe(Effect.mapError((cause) => fail("archive", normalizedThreadId, cause)));

        yield* prepareManagedWorktreeArchive(
          thread,
          automationRun ? "automation-archive" : "archive",
        );
        physicalAttempted = true;
        const physicalArchiveCause = yield* gateway
          .requestForThread(normalizedThreadId, "thread/archive", {
            threadId: normalizedThreadId,
          })
          .pipe(
            Effect.match({
              onFailure: (cause) =>
                isCodexThreadLifecycleAlreadyAppliedRequestError(cause, {
                  method: "thread/archive",
                  threadId: normalizedThreadId,
                })
                  ? null
                  : cause,
              onSuccess: () => null,
            }),
          );
        const reconciled = yield* reconcilePhysicalLifecycle({
          action: "archive",
          threadId: normalizedThreadId,
          operationId: subagentLifecycle.operationId,
          physicalCause: physicalArchiveCause,
        });
        subagents.releaseLifecycleQuarantine(normalizedThreadId, "archive");
        yield* authorizations.revokeRoot(rootThreadId);
        yield* project(
          "archive",
          normalizedThreadId,
          workspace.setThreadArchived(normalizedThreadId, true),
        );
        yield* retireRemoteHostedPip("archive", reconciled.settledThreadIds);
        conversations.current(normalizedThreadId)?.setHasUnreadTurn(false, true);
        if (thread.hasUnreadTurn) {
          events.publish({
            kind: "hostMessage",
            value: {
              type: "threadReadStateChanged",
              hostId: DEFAULT_CODEX_HOST_ID,
              conversationId: normalizedThreadId,
              hasUnreadTurn: false,
            },
          });
        }
        events.publish({
          kind: "codex",
          value: { type: "threadArchivedState", threadId: normalizedThreadId, archived: true },
        });
        if (automationRun && automationMessages) {
          yield* finishAutomationArchive(
            normalizedThreadId,
            automationRun.automationId,
            automationMessages,
          );
        }
        return true;
      }).pipe(
        Effect.tapError(() =>
          !admittedCodex || physicalAttempted
            ? Effect.void
            : Effect.sync(() =>
                subagents.releaseLifecycleQuarantine(normalizedThreadId, "archive"),
              ),
        ),
      );
    },
    deleteArchived: (threadId) => {
      let admittedCodex = false;
      let lifecycleStarted = false;
      const normalizedThreadId = threadId.trim();
      return Effect.gen(function* () {
        const thread = yield* project(
          "read-thread",
          normalizedThreadId,
          workspace.getThread(normalizedThreadId),
        );
        if (!thread) return false;
        if (!isCodexAgentBackendBinding(thread.backendBinding)) {
          return yield* fail(
            "delete",
            normalizedThreadId,
            new Error("Thread is not owned by the native Codex backend"),
          );
        }
        admittedCodex = true;
        if (!thread.archived) {
          return yield* fail(
            "delete",
            normalizedThreadId,
            new Error("Only archived Threads can be permanently deleted"),
          );
        }
        const lifecycle = yield* subagents
          .beginLifecycle({ rootThreadId: normalizedThreadId, action: "delete" })
          .pipe(Effect.mapError((cause) => fail("delete", normalizedThreadId, cause)));
        lifecycleStarted = true;
        const physicalDeleteCause = yield* gateway
          .requestForThread(normalizedThreadId, "thread/delete", {
            threadId: normalizedThreadId,
          })
          .pipe(
            Effect.match({
              onFailure: (cause) =>
                isCodexThreadLifecycleAlreadyAppliedRequestError(cause, {
                  method: "thread/delete",
                  threadId: normalizedThreadId,
                })
                  ? null
                  : cause,
              onSuccess: () => null,
            }),
          );
        const reconciled = yield* reconcilePhysicalLifecycle({
          action: "delete",
          threadId: normalizedThreadId,
          operationId: lifecycle.operationId,
          physicalCause: physicalDeleteCause,
        });
        subagents.releaseLifecycleQuarantine(normalizedThreadId, "delete");
        yield* authorizations.revokeRoot(normalizedThreadId);
        yield* project("delete", normalizedThreadId, workspace.deleteThread(normalizedThreadId));
        yield* retireRemoteHostedPip("delete", reconciled.settledThreadIds);
        conversations.current(normalizedThreadId)?.setHasUnreadTurn(false, true);
        events.publish({
          kind: "codex",
          value: { type: "threadDeleted", threadId: normalizedThreadId },
        });
        return true;
      }).pipe(
        Effect.tapError(() =>
          !admittedCodex || lifecycleStarted
            ? Effect.void
            : Effect.sync(() => subagents.releaseLifecycleQuarantine(normalizedThreadId, "delete")),
        ),
      );
    },
    unarchive: (threadId) =>
      Effect.gen(function* () {
        const normalizedThreadId = threadId.trim();
        const existing = yield* project(
          "read-thread",
          normalizedThreadId,
          workspace.getThread(normalizedThreadId),
        );
        if (!existing) return null;
        if (!isCodexAgentBackendBinding(existing.backendBinding)) {
          return yield* fail(
            "unarchive",
            normalizedThreadId,
            new Error("Thread is not owned by the native Codex backend"),
          );
        }
        yield* gateway
          .requestForThread(normalizedThreadId, "thread/unarchive", {
            threadId: normalizedThreadId,
          })
          .pipe(Effect.mapError((cause) => fail("unarchive", normalizedThreadId, cause)));
        yield* project(
          "unarchive",
          normalizedThreadId,
          workspace.setThreadArchived(normalizedThreadId, false),
        );
        const persisted = yield* project(
          "unarchive",
          normalizedThreadId,
          workspace.getThread(normalizedThreadId),
        );
        if (!persisted) return null;
        const summary = buildWorkspaceThreadSummary(persisted);
        events.publish({ kind: "codex", value: { type: "threadSummary", thread: summary } });
        events.publish({
          kind: "codex",
          value: { type: "threadArchivedState", threadId: normalizedThreadId, archived: false },
        });
        return summary;
      }),
  });
});
