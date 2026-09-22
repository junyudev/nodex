import * as path from "node:path";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
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
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
  type ProjectWorkspaceError,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";
import { NodexAgentAuthorizationRuntime } from "./NodexAgentAuthorizationRuntime";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { CodexInactiveThreadArchive } from "../platform/node/CodexInactiveThreadArchive";
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
  | CodexConversationLifecycle
  | CodexGateway
  | CodexHistoryPageAdapter
  | CodexMainConversationManagers
  | CodexThreadDirectory
  | ConversationEntityMap
  | ManagedWorktreeRuntime
  | NodexAgentAuthorizationRuntime
  | ProjectWorkspace
  | RemoteHostedPipRuntime
  | ExecutionHostRuntime
  | CodexInactiveThreadArchive
> = Effect.gen(function* () {
  const automation = yield* AutomationApplication;
  const automationRouting = yield* AutomationRoutingIndex;
  const events = yield* CodexApplicationEventHub;
  const capabilities = yield* CodexAppServerCapabilities;
  const conversationLifecycle = yield* CodexConversationLifecycle;
  const gateway = yield* CodexGateway;
  const historyPages = yield* CodexHistoryPageAdapter;
  const mainManagers = yield* CodexMainConversationManagers;
  const threadDirectory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;
  const managedWorktrees = yield* ManagedWorktreeRuntime;
  const authorizations = yield* NodexAgentAuthorizationRuntime;
  const workspace = yield* ProjectWorkspace;
  const remoteHostedPip = yield* RemoteHostedPipRuntime;
  const executionHosts = yield* ExecutionHostRuntime;
  const inactiveArchive = yield* CodexInactiveThreadArchive;

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

  const nativeMessage = (cause: CodexRuntimeError): string =>
    Schema.is(CodexAppServerRequestError)(cause.cause) ? cause.cause.message : cause.message;

  const recoverInactiveArchive = Effect.fn("CodexConversationArchive.recoverInactiveArchive")(
    function* (thread: DesktopProjectWorkspaceThread, physicalCause: CodexRuntimeError) {
      if (
        thread.executionHostId !== gateway.localHostId ||
        !nativeMessage(physicalCause).includes(`no rollout found for thread id ${thread.threadId}`)
      )
        return yield* fail("archive", thread.threadId, physicalCause);
      const host = yield* executionHosts
        .resolve(thread.executionHostId)
        .pipe(Effect.mapError((cause) => fail("archive", thread.threadId, cause)));
      if (host.descriptor.kind !== "local")
        return yield* fail("archive", thread.threadId, physicalCause);
      const result = yield* inactiveArchive
        .archive({
          codexHome: host.descriptor.codexHome,
          threadId: thread.threadId,
        })
        .pipe(Effect.mapError((cause) => fail("archive", thread.threadId, cause)));
      if (result === "archived") return false;
      if (result !== "missing") return yield* fail("archive", thread.threadId, physicalCause);
      // A stale catalog identity is retired only after the native owner confirms it is absent.
      const missing = yield* gateway
        .requestForThread(thread.threadId, "thread/read", {
          threadId: thread.threadId,
          includeTurns: false,
        })
        .pipe(
          Effect.as(false),
          Effect.catch((cause) =>
            nativeMessage(cause) === `thread not loaded: ${thread.threadId}`
              ? Effect.succeed(true)
              : Effect.fail(fail("archive", thread.threadId, cause)),
          ),
        );
      if (!missing) return yield* fail("archive", thread.threadId, physicalCause);
      return true;
    },
  );

  const prepareOwnedThreadForUnarchive = Effect.fn(
    "CodexConversationArchive.prepareOwnedThreadForUnarchive",
  )(function* (thread: DesktopProjectWorkspaceThread) {
    const manager = mainManagers.current(thread.executionHostId);
    if (manager?.stream.getRole(thread.threadId)?.role !== "owner") return;
    const generation = manager.generation;
    yield* Effect.try({
      try: () => manager.assertCurrent(generation),
      catch: (cause) => fail("unarchive", thread.threadId, cause),
    });
    yield* gateway
      .requestOnHost(
        thread.executionHostId,
        "thread/unsubscribe",
        { threadId: thread.threadId },
        {
          expectedHostId: thread.executionHostId,
          expectedGeneration: generation,
          conversationId: thread.threadId,
        },
      )
      .pipe(Effect.mapError((cause) => fail("unarchive", thread.threadId, cause)));
    yield* Effect.try({
      try: () => {
        manager.assertCurrent(generation);
        manager.stream.removeConversation(thread.threadId);
      },
      catch: (cause) => fail("unarchive", thread.threadId, cause),
    });
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
      const thread = yield* workspace.getThread(threadId);
      const heartbeatAutomationId = thread?.sessionId
        ? automationRouting.activeHeartbeatAutomationId(thread.sessionId)
        : null;
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

        yield* prepareManagedWorktreeArchive(
          thread,
          automationRun ? "automation-archive" : "archive",
        );
        const threadMissing = yield* gateway
          .requestForThread(normalizedThreadId, "thread/archive", {
            threadId: normalizedThreadId,
          })
          .pipe(
            Effect.as(false),
            Effect.catch((cause) => recoverInactiveArchive(thread, cause)),
          );
        yield* authorizations.revokeRoot(rootThreadId);
        yield* project(
          "archive",
          normalizedThreadId,
          threadMissing
            ? workspace.deleteThread(normalizedThreadId).pipe(Effect.asVoid)
            : workspace.setThreadArchived(normalizedThreadId, true).pipe(Effect.asVoid),
        );
        yield* retireRemoteHostedPip("archive", [normalizedThreadId]);
        yield* conversationLifecycle.close(
          normalizedThreadId,
          new Error(`Codex Thread '${normalizedThreadId}' was archived`),
        );
        if (thread.hasUnreadTurn) {
          events.publish({
            kind: "hostMessage",
            value: {
              type: "threadReadStateChanged",
              hostId: thread.executionHostId,
              conversationId: normalizedThreadId,
              hasUnreadTurn: false,
            },
          });
        }
        events.publish({
          kind: "codex",
          value: threadMissing
            ? { type: "threadDeleted", threadId: normalizedThreadId }
            : { type: "threadArchivedState", threadId: normalizedThreadId, archived: true },
        });
        if (automationRun && automationMessages) {
          yield* finishAutomationArchive(
            normalizedThreadId,
            automationRun.automationId,
            automationMessages,
          );
        }
        return true;
      });
    },
    deleteArchived: (threadId) => {
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
        // The native archive index is authoritative even when the local row is stale.
        let cursor: string | null = null;
        const archivedThreadIds = new Set<string>();
        do {
          const page: ClientRequestResponsesByMethod["thread/list"] = yield* gateway
            .requestForThread(normalizedThreadId, "thread/list", {
              archived: true,
              cursor,
              limit: 200,
              useStateDbOnly: true,
            })
            .pipe(Effect.mapError((cause) => fail("delete", normalizedThreadId, cause)));
          for (const archived of page.data) archivedThreadIds.add(archived.id);
          cursor = page.nextCursor ?? null;
        } while (cursor !== null);
        if (!archivedThreadIds.has(normalizedThreadId)) return false;

        yield* gateway
          .requestForThread(normalizedThreadId, "thread/delete", {
            threadId: normalizedThreadId,
          })
          .pipe(
            Effect.catch((cause) => {
              const nativeCause = Schema.is(CodexRuntimeError)(cause) ? cause.cause : cause;
              const message = Schema.is(CodexAppServerRequestError)(nativeCause)
                ? nativeCause.message
                : cause.message;
              if (message !== `no rollout found for thread id ${normalizedThreadId}`)
                return Effect.fail(cause);
              return gateway.requestRawForThread(normalizedThreadId, "thread/delete", {
                threadId: normalizedThreadId,
                missingRolloutRecovery: true,
              });
            }),
            Effect.mapError((cause) => fail("delete", normalizedThreadId, cause)),
          );
        yield* automation.runs
          .delete(normalizedThreadId)
          .pipe(Effect.mapError((cause) => fail("delete", normalizedThreadId, cause)));
        yield* authorizations.revokeRoot(normalizedThreadId);
        yield* project("delete", normalizedThreadId, workspace.deleteThread(normalizedThreadId));
        yield* retireRemoteHostedPip("delete", [normalizedThreadId]);
        yield* conversationLifecycle.close(
          normalizedThreadId,
          new Error(`Codex Thread '${normalizedThreadId}' was deleted`),
        );
        events.publish({
          kind: "codex",
          value: { type: "threadDeleted", threadId: normalizedThreadId },
        });
        return true;
      });
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
        yield* prepareOwnedThreadForUnarchive(existing);
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
        const hydrated = yield* threadDirectory
          .refreshMetadataInCurrentLane({
            threadId: normalizedThreadId,
            hostId: existing.executionHostId,
          })
          .pipe(Effect.mapError((cause) => fail("unarchive", normalizedThreadId, cause)));
        if (!hydrated) {
          return yield* fail(
            "unarchive",
            normalizedThreadId,
            new Error("Unarchived Thread could not be loaded"),
          );
        }
        const summary = hydrated.summary;
        events.publish({ kind: "codex", value: { type: "threadSummary", thread: summary } });
        events.publish({
          kind: "codex",
          value: { type: "threadArchivedState", threadId: normalizedThreadId, archived: false },
        });
        return summary;
      }),
  });
});
