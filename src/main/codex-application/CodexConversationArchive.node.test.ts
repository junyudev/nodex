import { assert, it } from "@effect/vitest";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexTranscriptEntry } from "../../shared/types";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  RemoteHostedPipRuntime,
  type RemoteHostedPipCodexLifecycleSettlement,
} from "../host-runtime/RemoteHostedPipRuntime";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationLifecycleReconciliationError, make } from "./CodexConversationArchive";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import {
  ManagedWorktreeRuntime,
  ManagedWorktreeRuntimeError,
  type ManagedWorktreeSetOwnerInput,
} from "./ManagedWorktreeRuntime";
import { NodexAgentAuthorizationRuntime } from "./NodexAgentAuthorizationRuntime";

const thread = (overrides: Partial<DesktopProjectWorkspaceThread> = {}) =>
  ({
    threadId: "thread-a",
    projectId: "project-a",
    sessionId: "session-a",
    forkedFromId: null,
    parentThreadId: null,
    threadSource: "user",
    serviceName: null,
    agentNickname: null,
    agentRole: null,
    agentPath: null,
    threadName: "Thread A",
    threadPreview: "",
    backendBinding: { kind: "codex" },
    executionHostId: "local",
    cwd: "/worktrees/a/packages/app",
    managedWorktreePath: "/worktrees/a",
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
    statusType: "notLoaded",
    statusActiveFlags: [],
    archived: false,
    pinnedOrder: null,
    hasUnreadTurn: false,
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    linkedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  }) satisfies DesktopProjectWorkspaceThread;

const capability = {
  hostId: "local",
  generation: 1,
  userAgent: "codex-app-server/0.145.0-alpha.15",
  version: "0.145.0-alpha.15",
  flags: {
    forkLastTurnId: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: false,
    multiAgentV2Protocol: false,
    sideConversation: false,
    subagentAncestorFilter: false,
    threadRevert: false,
  },
} satisfies CodexAppServerCapabilitySnapshot;

const makeArchive = (input: {
  readonly events: string[];
  readonly lifecycleConsumers: readonly ReturnType<typeof thread>[];
  readonly remove?: ManagedWorktreeRuntime["Service"]["remove"];
  readonly currentThread?: ReturnType<typeof thread>;
  readonly automationRun?: { readonly automationId: string } | null;
  readonly archivedMessages?: unknown[];
  readonly historyPages?: CodexHistoryPageAdapter["Service"];
  readonly localTranscript?: readonly CodexTranscriptEntry[];
  readonly pipSettlements?: RemoteHostedPipCodexLifecycleSettlement[];
  readonly settledThreadIds?: readonly string[];
  readonly reconcileComplete?: boolean;
  readonly reconcileFailure?: unknown;
  readonly reconciledOperationIds?: string[];
  readonly archiveTransportFailure?: unknown;
  readonly deleteTransportFailure?: unknown;
  readonly archivePersistenceFailure?: unknown;
  readonly deletePersistenceFailure?: unknown;
}) => {
  const unsupported = () => Effect.die(new Error("unused"));
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestForThread: (_threadId: string, method: string) =>
      Effect.sync(() => input.events.push(`gateway:${method}`)).pipe(
        Effect.andThen(
          method === "thread/archive" && input.archiveTransportFailure
            ? Effect.fail(input.archiveTransportFailure)
            : method === "thread/delete" && input.deleteTransportFailure
              ? Effect.fail(input.deleteTransportFailure)
              : Effect.succeed({}),
        ),
      ) as never,
    requestRawOnHost: unsupported,
    requestRawForThread: unsupported,
    requestLocal: unsupported,
    requestOnHost: unsupported,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
  const current = input.currentThread ?? thread();
  let lifecycleAction: "archive" | "delete" = "archive";
  return make.pipe(
    Effect.provideService(
      AutomationApplication,
      AutomationApplication.of({
        runs: {
          get: () => Effect.succeed(input.automationRun ?? null),
          archive: (archiveInput: unknown) =>
            Effect.sync(() => {
              input.archivedMessages?.push(archiveInput);
              return true;
            }),
        },
      } as never),
    ),
    Effect.provideService(
      AutomationRoutingIndex,
      AutomationRoutingIndex.of({ activeHeartbeatAutomationId: () => null } as never),
    ),
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
    ),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: () => Effect.succeed(true),
      }),
    ),
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(
      RemoteHostedPipRuntime,
      RemoteHostedPipRuntime.of({
        retireCodexThreads: (settlement: RemoteHostedPipCodexLifecycleSettlement) =>
          Effect.sync(() => {
            if (!input.pipSettlements) return;
            input.pipSettlements.push(settlement);
            input.events.push(`pip:${settlement.action}:${settlement.threadIds.join(",")}`);
          }),
      } as unknown as RemoteHostedPipRuntime["Service"]),
    ),
    Effect.provideService(
      CodexHistoryPageAdapter,
      input.historyPages ??
        CodexHistoryPageAdapter.of({
          loadTurnPage: unsupported,
          loadTurnItemsPage: unsupported,
        } as never),
    ),
    Effect.provideService(
      ConversationEntityMap,
      ConversationEntityMap.of({
        current: () =>
          input.localTranscript
            ? ({
                readSnapshot: () => ({ turns: [{ items: input.localTranscript }] }),
                setHasUnreadTurn: () => undefined,
              } as never)
            : null,
      } as never),
    ),
    Effect.provideService(
      CodexSubagentDirectory,
      CodexSubagentDirectory.of({
        beginLifecycle: ({ action }: { readonly action: "archive" | "delete" }) =>
          Effect.sync(() => {
            lifecycleAction = action;
            return {
              operationId: "lifecycle-a",
              action,
              expectedCount: 1,
              processedCount: 0,
              unresolvedCount: 1,
              complete: false,
            };
          }),
        reconcileLifecycle: ({ operationId }: { readonly operationId: string }) => {
          assert.strictEqual(operationId, "lifecycle-a");
          input.reconciledOperationIds?.push(operationId);
          if (input.reconcileFailure) return Effect.fail(input.reconcileFailure) as never;
          const complete = input.reconcileComplete ?? true;
          return Effect.succeed({
            operationId,
            action: lifecycleAction,
            expectedCount: 1,
            processedCount: complete ? 1 : 0,
            unresolvedCount: complete ? 0 : 1,
            complete,
            settledThreadIds: complete ? (input.settledThreadIds ?? [current.threadId]) : [],
          });
        },
        releaseLifecycleQuarantine: (_rootThreadId: string, action: "archive" | "delete") => {
          input.events.push(`release-quarantine:${action}`);
        },
      } as unknown as CodexSubagentDirectory["Service"]),
    ),
    Effect.provideService(
      ManagedWorktreeRuntime,
      ManagedWorktreeRuntime.of({
        setOwner: ({ ownerThreadId }: ManagedWorktreeSetOwnerInput) =>
          Effect.sync(() => input.events.push(`owner:${ownerThreadId}`)),
        remove:
          input.remove ??
          (() =>
            Effect.sync(() => {
              input.events.push("remove");
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            })),
        isNewborn: () => Effect.succeed(false),
      } as never),
    ),
    Effect.provideService(
      NodexAgentAuthorizationRuntime,
      NodexAgentAuthorizationRuntime.of({
        revokeRoot: () => Effect.sync(() => input.events.push("revoke")),
      } as never),
    ),
    Effect.provideService(
      ProjectWorkspace,
      ProjectWorkspace.of({
        getThread: () => Effect.succeed(current),
        readManagedWorktreeLifecycleSnapshot: Effect.succeed({
          projectionRevision: 1,
          consumers: input.lifecycleConsumers,
          projects: [],
        }),
        setThreadArchived: () =>
          Effect.sync(() => input.events.push("core:archive")).pipe(
            Effect.andThen(
              input.archivePersistenceFailure
                ? Effect.fail(input.archivePersistenceFailure as never)
                : Effect.succeed({ threads: [] }),
            ),
          ),
        deleteThread: () =>
          Effect.sync(() => input.events.push("core:delete")).pipe(
            Effect.andThen(
              input.deletePersistenceFailure
                ? Effect.fail(input.deletePersistenceFailure as never)
                : Effect.succeed({ threads: [] }),
            ),
          ),
      } as never),
    ),
  );
};

const lifecycleRequestFailure = (
  method: "thread/archive" | "thread/delete",
  code: number,
  message: string,
) =>
  codexRuntimeError({
    operation: "gateway.request",
    reason: "request",
    retryable: false,
    hostId: "local",
    generation: 1,
    method,
    cause: new CodexAppServerRequestError({
      code,
      errorMessage: message,
      method,
      requestId: "request-a",
      operation: "receive-response",
    }),
  });

const assertLifecycleReconciliationError = (
  cause: unknown,
): CodexConversationLifecycleReconciliationError => {
  assert.isTrue(cause instanceof CodexConversationLifecycleReconciliationError);
  return cause as CodexConversationLifecycleReconciliationError;
};

it.effect("writes a shared worktree replacement owner before archiving the Thread", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const archive = yield* makeArchive({
      events,
      lifecycleConsumers: [
        thread(),
        thread({
          threadId: "thread-b",
          cwd: "/worktrees/a/packages/other",
          statusType: "active",
          updatedAt: 2,
        }),
      ],
    });
    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(events, [
      "owner:thread-b",
      "gateway:thread/archive",
      "release-quarantine:archive",
      "revoke",
      "core:archive",
    ]);
  }),
);

it.effect("retires the exact deferred archive cohort after durable persistence", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const pipSettlements: RemoteHostedPipCodexLifecycleSettlement[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      pipSettlements,
      settledThreadIds: ["thread-a", "thread-child"],
    });

    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(pipSettlements, [
      { action: "archive", threadIds: ["thread-a", "thread-child"] },
    ]);
    assert.deepEqual(events, [
      "gateway:thread/archive",
      "release-quarantine:archive",
      "revoke",
      "core:archive",
      "pip:archive:thread-a,thread-child",
    ]);
  }),
);

it.effect("does not retire deferred archive PiP before durable persistence succeeds", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const pipSettlements: RemoteHostedPipCodexLifecycleSettlement[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      pipSettlements,
      settledThreadIds: ["thread-a", "thread-child"],
      archivePersistenceFailure: new Error("archive persistence failed"),
    });

    const exit = yield* Effect.exit(archive.archive("thread-a"));

    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(pipSettlements, []);
    assert.deepEqual(events, [
      "gateway:thread/archive",
      "release-quarantine:archive",
      "revoke",
      "core:archive",
    ]);
  }),
);

it.effect("rejects ACP lifecycle before invoking any Codex owner", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({
      backendBinding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-local",
      },
      archived: true,
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
    });

    yield* Effect.flip(archive.archive("thread-a"));
    yield* Effect.flip(archive.deleteArchived("thread-a"));
    yield* Effect.flip(archive.unarchive("thread-a"));
    assert.deepEqual(events, []);
  }),
);

it.effect("does not archive when required-snapshot removal fails", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const archive = yield* makeArchive({
      events,
      lifecycleConsumers: [thread()],
      remove: () =>
        Effect.fail(
          new ManagedWorktreeRuntimeError({
            operation: "remove",
            hostId: "local",
            worktreeGitRoot: "/worktrees/a",
            cause: new Error("snapshot failed"),
          }),
        ),
    });
    const exit = yield* Effect.exit(archive.archive("thread-a"));
    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(events, ["release-quarantine:archive"]);
  }),
);

it.effect(
  "keeps a physically archived root visible while descendant reconciliation is incomplete",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const currentThread = thread({
        cwd: "/repo",
        managedWorktreePath: null,
      });
      const archive = yield* makeArchive({
        events,
        currentThread,
        lifecycleConsumers: [currentThread],
        reconcileComplete: false,
      });

      const failure = yield* Effect.flip(archive.archive("thread-a"));
      const cause = assertLifecycleReconciliationError(failure.cause);
      assert.strictEqual(cause.reason, "postcondition-unresolved");
      assert.strictEqual(cause.snapshot?.operationId, "lifecycle-a");
      assert.strictEqual(cause.snapshot?.unresolvedCount, 1);
      assert.isNull(cause.physicalCause);
      assert.include(events, "gateway:thread/archive");
      assert.notInclude(events, "core:archive");
      assert.notInclude(events, "revoke");
    }),
);

it.effect("keeps archive recovery quarantined when transport fails after partial mutation", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const reconciledOperationIds: string[] = [];
    const physicalCause = new Error("archive failed after moving one descendant");
    const currentThread = thread({
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      reconcileComplete: false,
      reconciledOperationIds,
      archiveTransportFailure: physicalCause,
    });

    const failure = yield* Effect.flip(archive.archive("thread-a"));
    const cause = assertLifecycleReconciliationError(failure.cause);

    assert.strictEqual(cause.reason, "postcondition-unresolved");
    assert.strictEqual(cause.snapshot?.unresolvedCount, 1);
    assert.strictEqual(cause.physicalCause, physicalCause);
    assert.isNull(cause.reconciliationCause);
    assert.deepEqual(reconciledOperationIds, ["lifecycle-a"]);
    assert.include(events, "gateway:thread/archive");
    assert.notInclude(events, "release-quarantine:archive");
    assert.notInclude(events, "core:archive");
    assert.notInclude(events, "revoke");
  }),
);

it.effect(
  "commits archive when reconciliation proves an ambiguous physical request converged",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const reconciledOperationIds: string[] = [];
      const currentThread = thread({
        cwd: "/repo",
        managedWorktreePath: null,
      });
      const archive = yield* makeArchive({
        events,
        currentThread,
        lifecycleConsumers: [currentThread],
        reconcileComplete: true,
        reconciledOperationIds,
        archiveTransportFailure: new Error("host endpoint not found after archive"),
      });

      assert.isTrue(yield* archive.archive("thread-a"));
      assert.deepEqual(reconciledOperationIds, ["lifecycle-a"]);
      assert.deepEqual(events, [
        "gateway:thread/archive",
        "release-quarantine:archive",
        "revoke",
        "core:archive",
      ]);
    }),
);

it.effect("preserves physical and reconciliation errors when postconditions cannot be read", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const physicalCause = new Error("archive response connection closed");
    const reconciliationCause = new Error("archived index unavailable");
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      archiveTransportFailure: physicalCause,
      reconcileFailure: reconciliationCause,
    });

    const failure = yield* Effect.flip(archive.archive("thread-a"));
    const cause = assertLifecycleReconciliationError(failure.cause);

    assert.strictEqual(cause.reason, "reconciliation-failed");
    assert.isNull(cause.snapshot);
    assert.strictEqual(cause.physicalCause, physicalCause);
    assert.strictEqual(cause.reconciliationCause, reconciliationCause);
    assert.notInclude(events, "release-quarantine:archive");
    assert.notInclude(events, "core:archive");
  }),
);

it.effect("reconciles the exact app-server already-archived response", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      reconcileComplete: true,
      archiveTransportFailure: lifecycleRequestFailure(
        "thread/archive",
        -32_603,
        "failed to archive session: thread thread-a not found",
      ),
    });

    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(events, [
      "gateway:thread/archive",
      "release-quarantine:archive",
      "revoke",
      "core:archive",
    ]);
  }),
);

it.effect("keeps delete recovery quarantined when transport fails after partial mutation", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const reconciledOperationIds: string[] = [];
    const physicalCause = new Error("delete failed after removing one descendant");
    const currentThread = thread({
      archived: true,
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      reconcileComplete: false,
      reconciledOperationIds,
      deleteTransportFailure: physicalCause,
    });

    const failure = yield* Effect.flip(archive.deleteArchived("thread-a"));
    const cause = assertLifecycleReconciliationError(failure.cause);

    assert.strictEqual(cause.reason, "postcondition-unresolved");
    assert.strictEqual(cause.snapshot?.unresolvedCount, 1);
    assert.strictEqual(cause.physicalCause, physicalCause);
    assert.deepEqual(reconciledOperationIds, ["lifecycle-a"]);
    assert.include(events, "gateway:thread/delete");
    assert.notInclude(events, "release-quarantine:delete");
    assert.notInclude(events, "core:delete");
    assert.notInclude(events, "revoke");
  }),
);

it.effect("retires the exact deferred delete cohort after durable postconditions", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const reconciledOperationIds: string[] = [];
    const pipSettlements: RemoteHostedPipCodexLifecycleSettlement[] = [];
    const currentThread = thread({
      archived: true,
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      reconcileComplete: true,
      reconciledOperationIds,
      pipSettlements,
      settledThreadIds: ["thread-a", "thread-child"],
      deleteTransportFailure: lifecycleRequestFailure(
        "thread/delete",
        -32_601,
        "Method not found: thread/delete",
      ),
    });

    assert.isTrue(yield* archive.deleteArchived("thread-a"));
    assert.deepEqual(reconciledOperationIds, ["lifecycle-a"]);
    assert.deepEqual(pipSettlements, [
      { action: "delete", threadIds: ["thread-a", "thread-child"] },
    ]);
    assert.deepEqual(events, [
      "gateway:thread/delete",
      "release-quarantine:delete",
      "revoke",
      "core:delete",
      "pip:delete:thread-a,thread-child",
    ]);
  }),
);

it.effect("does not retire deferred delete PiP before durable deletion succeeds", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const pipSettlements: RemoteHostedPipCodexLifecycleSettlement[] = [];
    const currentThread = thread({
      archived: true,
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      pipSettlements,
      settledThreadIds: ["thread-a", "thread-child"],
      deletePersistenceFailure: new Error("delete persistence failed"),
    });

    const exit = yield* Effect.exit(archive.deleteArchived("thread-a"));

    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(pipSettlements, []);
    assert.deepEqual(events, [
      "gateway:thread/delete",
      "release-quarantine:delete",
      "revoke",
      "core:delete",
    ]);
  }),
);

it.effect("reconciles the exact app-server already-deleted response", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({
      archived: true,
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      reconcileComplete: true,
      deleteTransportFailure: lifecycleRequestFailure(
        "thread/delete",
        -32_600,
        "thread not found: thread-a",
      ),
    });

    assert.isTrue(yield* archive.deleteArchived("thread-a"));
    assert.deepEqual(events, [
      "gateway:thread/delete",
      "release-quarantine:delete",
      "revoke",
      "core:delete",
    ]);
  }),
);

it.effect("fills a missing local archive side from bounded history without replacing it", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const archivedMessages: unknown[] = [];
    const shellInputs: unknown[] = [];
    const itemInputs: unknown[] = [];
    const historyPages = CodexHistoryPageAdapter.of({
      loadTurnPage: (pageInput) =>
        Effect.sync(() => {
          shellInputs.push(pageInput);
          return {
            turns: [
              {
                id: "turn-latest",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
            itemsPaginationByTurnId: {},
            itemSegmentsByTurnId: {},
            loadedItemCount: 0,
          };
        }),
      loadTurnItemsPage: (pageInput) =>
        Effect.sync(() => {
          itemInputs.push(pageInput);
          return {
            items: [
              {
                type: "userMessage",
                id: "user-latest",
                clientId: null,
                content: [{ type: "text", text: "latest request", text_elements: [] }],
              },
              {
                type: "agentMessage",
                id: "assistant-latest",
                text: "older history response",
                phase: null,
                memoryCitation: null,
                delivery: null,
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
            approximateBytes: 4_096,
          };
        }),
    });
    const archive = yield* makeArchive({
      events,
      lifecycleConsumers: [],
      currentThread: thread({ managedWorktreePath: null }),
      automationRun: { automationId: "automation-a" },
      archivedMessages,
      historyPages,
      localTranscript: [
        {
          threadId: "thread-a",
          turnId: "turn-latest",
          itemId: "assistant-local",
          type: "assistantMessage",
          kind: "assistantMessage",
          source: "live",
          createdAt: 1,
          markdownText: "latest local response",
        } as CodexTranscriptEntry,
      ],
    });

    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepStrictEqual(archivedMessages, [
      {
        threadId: "thread-a",
        archivedReason: "auto",
        archivedUserMessage: "latest request",
        archivedAssistantMessage: "latest local response",
      },
    ]);
    assert.deepStrictEqual(shellInputs, [
      {
        capability,
        threadId: "thread-a",
        cursor: null,
        initialItemsCursor: null,
        limit: 5,
        itemBudget: 0,
        byteBudget: 0,
        purpose: "export",
      },
    ]);
    assert.strictEqual((itemInputs[0] as { readonly limit: number }).limit, 100);
  }),
);
