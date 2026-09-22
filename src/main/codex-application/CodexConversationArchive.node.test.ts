import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import {
  CodexInactiveThreadArchive,
  CodexInactiveThreadArchiveError,
} from "../platform/node/CodexInactiveThreadArchive";
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
import { make } from "./CodexConversationArchive";
import { CodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { buildWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
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
  nativeAppTools: false,
  flags: {
    turnApprovalsReviewer: false,

    turnToolOutput: false,
    forkLastTurnId: true,
    paginatedFork: false,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: false,
    multiAgentV2Protocol: false,
    sideConversation: false,
    subagentAncestorFilter: false,
    threadRevert: false,
    threadQueue: false,
  },
} satisfies CodexAppServerCapabilitySnapshot;

const makeArchive = (input: {
  readonly events: string[];
  readonly applicationEvents?: unknown[];
  readonly lifecycleConsumers: readonly ReturnType<typeof thread>[];
  readonly remove?: ManagedWorktreeRuntime["Service"]["remove"];
  readonly currentThread?: ReturnType<typeof thread>;
  readonly automationRun?: { readonly automationId: string } | null;
  readonly archivedMessages?: unknown[];
  readonly historyPages?: CodexHistoryPageAdapter["Service"];
  readonly localTranscript?: readonly CodexTranscriptEntry[];
  readonly pipSettlements?: RemoteHostedPipCodexLifecycleSettlement[];
  readonly nativeArchivedPages?: readonly (readonly string[])[];
  readonly nativeRequests?: Array<{ method: string; params: unknown }>;
  readonly deleteRecoveryFailure?: unknown;
  readonly archiveTransportFailure?: unknown;
  readonly nativeReadFailure?: unknown;
  readonly inactiveArchiveResult?: "archived" | "missing" | "unrecoverable";
  readonly inactiveArchiveFailure?: CodexInactiveThreadArchiveError;
  readonly deleteTransportFailure?: unknown;
  readonly archivePersistenceFailure?: unknown;
  readonly deletePersistenceFailure?: unknown;
  readonly unarchiveOwner?: boolean;
  readonly unarchiveUnsubscribeFailure?: unknown;
  readonly unarchiveHydrationFailure?: unknown;
  readonly unarchiveHydrationMissing?: boolean;
  readonly lifecycleClosures?: Array<{ readonly threadId: string; readonly reason: unknown }>;
}) => {
  const unsupported = () => Effect.die(new Error("unused"));
  let archivedPage = 0;
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestForThread: (_threadId: string, method: string, params: unknown) =>
      Effect.sync(() => {
        input.events.push(`gateway:${method}`);
        input.nativeRequests?.push({ method, params });
      }).pipe(
        Effect.andThen(
          method === "thread/archive" && input.archiveTransportFailure
            ? Effect.fail(input.archiveTransportFailure)
            : method === "thread/read" && input.nativeReadFailure
              ? Effect.fail(input.nativeReadFailure)
              : method === "thread/delete" && input.deleteTransportFailure
                ? Effect.fail(input.deleteTransportFailure)
                : method === "thread/list"
                  ? Effect.sync(() => {
                      const pages = input.nativeArchivedPages ?? [["thread-a"]];
                      const ids = pages[archivedPage++] ?? [];
                      return {
                        data: ids.map((id) => ({ id })),
                        nextCursor: archivedPage < pages.length ? `page-${archivedPage}` : null,
                      };
                    })
                  : Effect.succeed({}),
        ),
      ) as never,
    requestRawOnHost: unsupported,
    requestRawForThread: (_threadId, method, params) =>
      Effect.sync(() => {
        input.events.push(`extension:${method}`);
        input.nativeRequests?.push({ method, params });
      }).pipe(
        Effect.andThen(
          input.deleteRecoveryFailure
            ? Effect.fail(input.deleteRecoveryFailure as never)
            : Effect.succeed({}),
        ),
      ),
    requestLocal: unsupported,
    requestOnHost: (hostId: string, method: string) =>
      Effect.sync(() => input.events.push(`gateway:${hostId}:${method}`)).pipe(
        Effect.andThen(
          method === "thread/unsubscribe" && input.unarchiveUnsubscribeFailure
            ? Effect.fail(input.unarchiveUnsubscribeFailure)
            : Effect.succeed({}),
        ),
      ) as never,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
  const current = input.currentThread ?? thread();
  return make.pipe(
    Effect.provideService(ExecutionHostRuntime, {
      resolve: () => Effect.succeed({ descriptor: { kind: "local", codexHome: "/codex-home" } }),
    } as unknown as ExecutionHostRuntime["Service"]),
    Effect.provideService(CodexInactiveThreadArchive, {
      archive: (inputValue) =>
        Effect.sync(() => {
          input.events.push("inactive:archive");
          assert.deepEqual(inputValue, { threadId: "thread-a", codexHome: "/codex-home" });
        }).pipe(
          Effect.andThen(
            input.inactiveArchiveFailure
              ? Effect.fail(input.inactiveArchiveFailure)
              : Effect.succeed(input.inactiveArchiveResult ?? "unrecoverable"),
          ),
        ),
    }),
    Effect.provideService(
      AutomationApplication,
      AutomationApplication.of({
        runs: {
          get: () => Effect.succeed(input.automationRun ?? null),
          delete: () =>
            Effect.sync(() => {
              input.events.push("automation:delete");
              return true;
            }),
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
      CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => {
          input.applicationEvents?.push(event);
        },
      }),
    ),
    Effect.provideService(
      CodexConversationLifecycle,
      CodexConversationLifecycle.of({
        close: (threadId, reason) =>
          Effect.sync(() => {
            input.lifecycleClosures?.push({ threadId, reason });
          }),
      }),
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
      CodexMainConversationManagers,
      CodexMainConversationManagers.of({
        current: (hostId: string) =>
          input.unarchiveOwner
            ? ({
                hostId,
                generation: 1,
                assertCurrent: (generation?: number) => {
                  input.events.push(`manager:assert:${generation ?? "current"}`);
                },
                stream: {
                  getRole: () => ({ role: "owner" }),
                  removeConversation: (threadId: string) =>
                    input.events.push(`manager:clear:${threadId}`),
                },
              } as never)
            : null,
      } as never),
    ),
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
        registerThreadMetadata: () => {},
        readThreadMetadata: () => null,
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
      CodexThreadDirectory,
      CodexThreadDirectory.of({
        refreshMetadataInCurrentLane: ({ threadId }: { readonly threadId: string }) =>
          Effect.sync(() => input.events.push(`directory:metadata:${threadId}`)).pipe(
            Effect.andThen(
              input.unarchiveHydrationFailure
                ? Effect.fail(input.unarchiveHydrationFailure as never)
                : input.unarchiveHydrationMissing
                  ? Effect.succeed(null)
                  : Effect.succeed({
                      fidelity: "metadata",
                      historyMode: null,
                      durable: { ...current, archived: false },
                      summary: buildWorkspaceThreadSummary({ ...current, archived: false }),
                      canonical: null,
                      snapshot: null,
                    }),
            ),
          ),
      } as never),
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
  method: "thread/archive" | "thread/delete" | "thread/read",
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
      "revoke",
      "core:archive",
    ]);
  }),
);

it.effect("publishes archived remote read state on the Thread execution host", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const applicationEvents: unknown[] = [];
    const currentThread = thread({
      executionHostId: "ssh:builder",
      managedWorktreePath: null,
      hasUnreadTurn: true,
    });
    const archive = yield* makeArchive({
      events,
      applicationEvents,
      currentThread,
      lifecycleConsumers: [currentThread],
    });

    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(
      applicationEvents.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          event.kind === "hostMessage",
      ),
      {
        kind: "hostMessage",
        value: {
          type: "threadReadStateChanged",
          hostId: "ssh:builder",
          conversationId: "thread-a",
          hasUnreadTurn: false,
        },
      },
    );
  }),
);

it.effect("retires the archived root after native success and durable persistence", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const pipSettlements: RemoteHostedPipCodexLifecycleSettlement[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      pipSettlements,
    });

    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(pipSettlements, [{ action: "archive", threadIds: ["thread-a"] }]);
    assert.deepEqual(events, [
      "gateway:thread/archive",
      "revoke",
      "core:archive",
      "pip:archive:thread-a",
    ]);
  }),
);

it.effect("retires process-local conversation state after durable archive persistence", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const lifecycleClosures: Array<{ readonly threadId: string; readonly reason: unknown }> = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      lifecycleClosures,
    });

    assert.isTrue(yield* archive.archive("thread-a"));
    assert.strictEqual(lifecycleClosures.length, 1);
    assert.strictEqual(lifecycleClosures[0]?.threadId, "thread-a");
    assert.match(String(lifecycleClosures[0]?.reason), /was archived/);
    assert.isTrue(events.indexOf("core:archive") < events.length);
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
      archivePersistenceFailure: new Error("archive persistence failed"),
    });

    const exit = yield* Effect.exit(archive.archive("thread-a"));

    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(pipSettlements, []);
    assert.deepEqual(events, ["gateway:thread/archive", "revoke", "core:archive"]);
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

it.effect("releases owned stream state before unarchive and refreshes metadata afterwards", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const applicationEvents: unknown[] = [];
    const currentThread = thread({
      archived: true,
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      applicationEvents,
      currentThread,
      lifecycleConsumers: [currentThread],
      unarchiveOwner: true,
    });

    const summary = yield* archive.unarchive("thread-a");

    assert.strictEqual(summary?.archived, false);
    assert.deepEqual(events, [
      "manager:assert:1",
      "gateway:local:thread/unsubscribe",
      "manager:assert:1",
      "manager:clear:thread-a",
      "gateway:thread/unarchive",
      "core:archive",
      "directory:metadata:thread-a",
    ]);
    assert.deepEqual(applicationEvents, [
      { kind: "codex", value: { type: "threadSummary", thread: summary } },
      {
        kind: "codex",
        value: { type: "threadArchivedState", threadId: "thread-a", archived: false },
      },
    ]);
  }),
);

it.effect("does not clear ownership or unarchive when owner unsubscribe fails", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({ archived: true, managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      unarchiveOwner: true,
      unarchiveUnsubscribeFailure: new Error("unsubscribe failed"),
    });

    const exit = yield* Effect.exit(archive.unarchive("thread-a"));

    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(events, ["manager:assert:1", "gateway:local:thread/unsubscribe"]);
  }),
);

it.effect("requires metadata hydration before publishing an unarchived Thread", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const applicationEvents: unknown[] = [];
    const currentThread = thread({ archived: true, managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      applicationEvents,
      currentThread,
      lifecycleConsumers: [currentThread],
      unarchiveHydrationMissing: true,
    });

    const exit = yield* Effect.exit(archive.unarchive("thread-a"));

    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(events, [
      "gateway:thread/unarchive",
      "core:archive",
      "directory:metadata:thread-a",
    ]);
    assert.deepEqual(applicationEvents, []);
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
    assert.deepEqual(events, []);
  }),
);

it.effect("retires process-local conversation state after durable deletion", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const lifecycleClosures: Array<{ readonly threadId: string; readonly reason: unknown }> = [];
    const currentThread = thread({
      archived: true,
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      lifecycleClosures,
    });

    assert.isTrue(yield* archive.deleteArchived("thread-a"));
    assert.strictEqual(lifecycleClosures.length, 1);
    assert.strictEqual(lifecycleClosures[0]?.threadId, "thread-a");
    assert.match(String(lifecycleClosures[0]?.reason), /was deleted/);
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
      deletePersistenceFailure: new Error("delete persistence failed"),
    });

    const exit = yield* Effect.exit(archive.deleteArchived("thread-a"));

    assert.isTrue(exit._tag === "Failure");
    assert.deepEqual(pipSettlements, []);
    assert.deepEqual(events, [
      "gateway:thread/list",
      "gateway:thread/delete",
      "automation:delete",
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
                questions: null,
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

for (const message of ["archive denied", "failed to archive session: thread thread-a not found"]) {
  it.effect(`does not publish archive success after ${message}`, () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const applicationEvents: unknown[] = [];
      const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
      const failure = lifecycleRequestFailure("thread/archive", -32603, message);
      const archive = yield* makeArchive({
        events,
        applicationEvents,
        currentThread,
        lifecycleConsumers: [currentThread],
        archiveTransportFailure: failure,
      });
      const result = yield* archive.archive("thread-a").pipe(Effect.flip);
      assert.strictEqual(result.cause, failure);
      assert.deepEqual(events, ["gateway:thread/archive"]);
      assert.deepEqual(applicationEvents, []);
    }),
  );
}

it.effect(
  "uses all native state DB pages to admit deletion despite stale local archived state",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const nativeRequests: Array<{ method: string; params: unknown }> = [];
      const currentThread = thread({ archived: false, cwd: "/repo", managedWorktreePath: null });
      const archive = yield* makeArchive({
        events,
        nativeRequests,
        currentThread,
        lifecycleConsumers: [currentThread],
        nativeArchivedPages: [["other"], ["thread-a"]],
      });
      assert.isTrue(yield* archive.deleteArchived("thread-a"));
      assert.deepEqual(nativeRequests, [
        {
          method: "thread/list",
          params: { archived: true, cursor: null, limit: 200, useStateDbOnly: true },
        },
        {
          method: "thread/list",
          params: { archived: true, cursor: "page-1", limit: 200, useStateDbOnly: true },
        },
        { method: "thread/delete", params: { threadId: "thread-a" } },
      ]);
    }),
);

it.effect("does not delete a target absent from the native archive index", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({ archived: true, cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      nativeArchivedPages: [[]],
    });
    assert.isFalse(yield* archive.deleteArchived("thread-a"));
    assert.deepEqual(events, ["gateway:thread/list"]);
  }),
);

it.effect("retries the exact target's missing rollout through the native extension", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const nativeRequests: Array<{ method: string; params: unknown }> = [];
    const currentThread = thread({ archived: true, cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      nativeRequests,
      currentThread,
      lifecycleConsumers: [currentThread],
      deleteTransportFailure: lifecycleRequestFailure(
        "thread/delete",
        -32603,
        "no rollout found for thread id thread-a",
      ),
    });
    assert.isTrue(yield* archive.deleteArchived("thread-a"));
    assert.deepEqual(nativeRequests.at(-1), {
      method: "thread/delete",
      params: { threadId: "thread-a", missingRolloutRecovery: true },
    });
    assert.isTrue(events.indexOf("extension:thread/delete") < events.indexOf("automation:delete"));
  }),
);

for (const message of [
  "no rollout found for thread id other",
  "thread not found: thread-a",
  "Method not found: thread/delete",
]) {
  it.effect(`propagates delete error without cleanup: ${message}`, () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const currentThread = thread({ archived: true, cwd: "/repo", managedWorktreePath: null });
      const failure = lifecycleRequestFailure("thread/delete", -32603, message);
      const archive = yield* makeArchive({
        events,
        currentThread,
        lifecycleConsumers: [currentThread],
        deleteTransportFailure: failure,
      });
      const result = yield* archive.deleteArchived("thread-a").pipe(Effect.flip);
      assert.strictEqual(result.cause, failure);
      assert.deepEqual(events, ["gateway:thread/list", "gateway:thread/delete"]);
    }),
  );
}

it.effect("does not report successful deletion when missing-rollout recovery fails", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({ archived: true, cwd: "/repo", managedWorktreePath: null });
    const failure = new Error("recovery denied");
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      deleteTransportFailure: lifecycleRequestFailure(
        "thread/delete",
        -32603,
        "no rollout found for thread id thread-a",
      ),
      deleteRecoveryFailure: failure,
    });
    const result = yield* archive.deleteArchived("thread-a").pipe(Effect.flip);
    assert.strictEqual(result.cause, failure);
    assert.deepEqual(events, [
      "gateway:thread/list",
      "gateway:thread/delete",
      "extension:thread/delete",
    ]);
  }),
);

it.effect("persists a local inactive rollout before reporting recovered archive success", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      archiveTransportFailure: lifecycleRequestFailure(
        "thread/archive",
        -32603,
        "no rollout found for thread id thread-a",
      ),
      inactiveArchiveResult: "archived",
    });
    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(events, [
      "gateway:thread/archive",
      "inactive:archive",
      "revoke",
      "core:archive",
    ]);
  }),
);

it.effect("retires a missing local catalog identity only after native absence confirmation", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const applicationEvents: unknown[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const archive = yield* makeArchive({
      events,
      applicationEvents,
      currentThread,
      lifecycleConsumers: [currentThread],
      archiveTransportFailure: lifecycleRequestFailure(
        "thread/archive",
        -32603,
        "no rollout found for thread id thread-a",
      ),
      inactiveArchiveResult: "missing",
      nativeReadFailure: lifecycleRequestFailure(
        "thread/read",
        -32603,
        "thread not loaded: thread-a",
      ),
    });
    assert.isTrue(yield* archive.archive("thread-a"));
    assert.deepEqual(events, [
      "gateway:thread/archive",
      "inactive:archive",
      "gateway:thread/read",
      "revoke",
      "core:delete",
    ]);
    assert.deepInclude(applicationEvents, {
      kind: "codex",
      value: { type: "threadDeleted", threadId: "thread-a" },
    });
  }),
);

for (const result of ["missing", "unrecoverable"] as const) {
  it.effect(
    `rejects inactive archive without positive persistence or absence evidence (${result})`,
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
        const physicalCause = lifecycleRequestFailure(
          "thread/archive",
          -32603,
          "no rollout found for thread id thread-a",
        );
        const archive = yield* makeArchive({
          events,
          currentThread,
          lifecycleConsumers: [currentThread],
          archiveTransportFailure: physicalCause,
          inactiveArchiveResult: result,
        });
        const failure = yield* archive.archive("thread-a").pipe(Effect.flip);
        assert.strictEqual(failure.cause, physicalCause);
        assert.notInclude(events, "core:archive");
        assert.notInclude(events, "core:delete");
        assert.notInclude(events, "revoke");
      }),
  );
}

it.effect("does not use local inactive-rollout repair for a remote execution host", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({
      executionHostId: "ssh:builder",
      cwd: "/repo",
      managedWorktreePath: null,
    });
    const physicalCause = lifecycleRequestFailure(
      "thread/archive",
      -32603,
      "no rollout found for thread id thread-a",
    );
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      archiveTransportFailure: physicalCause,
    });
    const failure = yield* archive.archive("thread-a").pipe(Effect.flip);
    assert.strictEqual(failure.cause, physicalCause);
    assert.deepEqual(events, ["gateway:thread/archive"]);
  }),
);

it.effect("does not report archive success when inactive persistence fails", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const currentThread = thread({ cwd: "/repo", managedWorktreePath: null });
    const failure = new CodexInactiveThreadArchiveError({ cause: new Error("database locked") });
    const archive = yield* makeArchive({
      events,
      currentThread,
      lifecycleConsumers: [currentThread],
      archiveTransportFailure: lifecycleRequestFailure(
        "thread/archive",
        -32603,
        "no rollout found for thread id thread-a",
      ),
      inactiveArchiveFailure: failure,
    });
    assert.strictEqual((yield* archive.archive("thread-a").pipe(Effect.flip)).cause, failure);
    assert.deepEqual(events, ["gateway:thread/archive", "inactive:archive"]);
  }),
);
