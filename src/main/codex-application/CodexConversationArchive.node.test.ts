import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexTranscriptEntry } from "../../shared/types";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { make } from "./CodexConversationArchive";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
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
    modelProvider: "openai",
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
    sideConversation: false,
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
}) => {
  const unsupported = () => Effect.die(new Error("unused"));
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestForThread: (_threadId: string, method: string) =>
      Effect.sync(() => {
        input.events.push(`gateway:${method}`);
        return {};
      }) as never,
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
          Effect.sync(() => {
            input.events.push("core:archive");
            return { threads: [] };
          }),
      } as never),
    ),
  );
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
      "revoke",
      "core:archive",
    ]);
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
