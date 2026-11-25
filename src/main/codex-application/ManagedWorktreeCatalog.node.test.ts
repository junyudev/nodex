import { describe } from "vite-plus/test";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type {
  ManagedWorktreeSettings,
  Project,
  ProjectSession,
  CodexExecutionHostSettings,
  CodexSshExecutionHostConfig,
} from "../../shared/types";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import {
  AgentChatWorktrees,
  AgentChatWorktreesUnavailable,
  type AgentChatWorktreeSource,
} from "./AgentChatWorktrees";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import {
  ManagedWorktreeConfiguration,
  ExecutionHostConfiguration,
} from "./ExecutionHostConfiguration";
import {
  ExecutionHostRuntime,
  live as executionHostRuntimeLive,
  threadHostResolverLive,
  type ExecutionHostRuntimeFactories,
  type RemoteExecutionHostTransport,
} from "./ExecutionHostRuntime";
import { ManagedWorktreeCatalogError, make } from "./ManagedWorktreeCatalog";
import {
  ManagedWorktreeRuntime,
  ManagedWorktreeRuntimeError,
  type ManagedWorktreeInspectInput,
  type ManagedWorktreeRestoreInput,
} from "./ManagedWorktreeRuntime";
import { ManagedWorktreeRetentionRuntime } from "./ManagedWorktreeRetentionRuntime";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CodexEphemeralThreadRouting } from "../codex-runtime/CodexEphemeralThreadRouting";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import type { CodexExecutionHostConfig } from "../codex-runtime/CodexEndpointMap";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { WorktreeWorkerRuntime } from "../host-runtime/WorktreeWorkerRuntime";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { DISABLED_DESKTOP_TOOL_REPL_CONFIG } from "../codex/codex-thread-config";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationCommands } from "./ConversationCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexThreadExecution, live } from "./CodexThreadExecution";

describe("ManagedWorktreeCatalog", () => {
  const makeThread = (
    overrides: Partial<DesktopProjectWorkspaceThread> = {},
  ): DesktopProjectWorkspaceThread => ({
    threadId: "thread-one",
    projectId: "project-one",
    sessionId: "session-one",
    forkedFromId: null,
    parentThreadId: null,
    threadSource: null,
    serviceName: null,
    agentNickname: null,
    agentRole: null,
    agentPath: null,
    threadName: "First",
    threadPreview: "First preview",
    backendBinding: { driver: "codex", instanceId: "codex" },
    executionHostId: "local",
    cwd: "/managed/shared/repository/packages/app",
    managedWorktreePath: "/managed/shared/repository",
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    pinnedOrder: null,
    hasUnreadTurn: false,
    createdAt: 10,
    updatedAt: 30,
    recencyAt: 30,
    linkedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  });

  const makeProjectWorkspace = (
    overrides: Partial<ProjectWorkspaceService> = {},
  ): ProjectWorkspaceService =>
    ({
      getThread: () => Effect.succeed(null),
      getProject: (id) =>
        overrides.readManagedWorktreeLifecycleSnapshot?.pipe(
          Effect.map((snapshot) => {
            const project = snapshot.projects.find((item) => item.projectId === id);
            return project
              ? ({
                  sources: project.sourceRoots.map((source, order) => ({
                    kind: "directory",
                    path: source,
                    order,
                  })),
                } as Project)
              : null;
          }),
        ) ?? Effect.succeed(null),
      getProjectSession: () => Effect.succeed(null),
      listManagedWorktreeWindow: () =>
        Effect.succeed({ items: [], nextCursor: null, projectionRevision: 1 }),
      listProjects: Effect.succeed([]),
      readManagedWorktreeLifecycleSnapshot: Effect.succeed({
        projectionRevision: 1,
        consumers: [],
        projects: [],
      }),
      ...overrides,
    }) as ProjectWorkspaceService;

  const makeExecutionHosts = (
    updateManagedRoot: (hostId: string, managedRoot: string) => void = () => undefined,
  ): ExecutionHostRuntime["Service"] =>
    ({
      hosts: () => Effect.succeed([{ hostId: "local" }]),
      resolve: (hostId: string) =>
        Effect.succeed({ descriptor: { hostId, managedRoot: path.resolve("/managed") } }),
      updateLocalManagedRoot: (managedRoot: string) =>
        Effect.sync(() => updateManagedRoot("local", managedRoot)),
    }) as unknown as ExecutionHostRuntime["Service"];

  const makeManaged = (
    overrides: Partial<ManagedWorktreeRuntime["Service"]> = {},
  ): ManagedWorktreeRuntime["Service"] =>
    ManagedWorktreeRuntime.of({
      list: () => Effect.succeed({ entries: [] }),
      inspect: () => Effect.die("Unexpected managed-worktree inspection"),
      restore: () => Effect.die("Unexpected managed-worktree restoration"),
      remove: () => Effect.die("Unexpected managed-worktree removal"),
      setOwner: () => Effect.die("Unexpected managed-worktree owner mutation"),
      registerNewborn: () => Effect.void,
      releaseNewborn: () => Effect.void,
      isNewborn: () => Effect.succeed(false),
      newborns: Effect.succeed([]),
      ...overrides,
    });

  const makeCatalog = (
    scope: Scope.Scope,
    projectWorkspace: ProjectWorkspaceService,
    managed: ManagedWorktreeRuntime["Service"],
    options: {
      readonly executionHosts?: ExecutionHostRuntime["Service"];
      readonly directories?: readonly string[];
      readonly unreadable?: string;
      readonly publish?: (event: CodexApplicationEvent) => void;
      readonly retention?: ManagedWorktreeRetentionRuntime["Service"];
      readonly agentChats?: AgentChatWorktreeSource;
      readonly pageWorkspacePaths?: Effect.Effect<readonly string[], unknown>;
      readonly settings?: {
        readonly read: () => ManagedWorktreeSettings;
        readonly update: (input: Partial<ManagedWorktreeSettings>) => ManagedWorktreeSettings;
      };
    } = {},
  ) => {
    const defaultSettings: ManagedWorktreeSettings = {
      worktreeRoot: null,
      autoDeleteEnabled: true,
      autoDeleteLimit: 15,
    };
    const settings = options.settings ?? {
      read: () => defaultSettings,
      update: () => defaultSettings,
    };
    return make({
      defaultManagedRoot: path.resolve("/managed"),
      pageWorkspacePaths: options.pageWorkspacePaths,
    }).pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: options.publish ?? (() => undefined),
        }),
      ),
      Effect.provideService(ExecutionHostRuntime, options.executionHosts ?? makeExecutionHosts()),
      Effect.provideService(
        ManagedWorktreeConfiguration,
        ManagedWorktreeConfiguration.of({
          settings: Effect.sync(settings.read),
          update: (input) => Effect.sync(() => settings.update(input)),
        }),
      ),
      Effect.provideService(
        ManagedWorktreeRetentionRuntime,
        options.retention ??
          ManagedWorktreeRetentionRuntime.of({
            request: Effect.void,
            run: Effect.die("Unexpected retention run"),
          }),
      ),
      Effect.provideService(ManagedWorktreeRuntime, managed),
      Effect.provideService(ProjectWorkspace, ProjectWorkspace.of(projectWorkspace)),
      Effect.provideService(
        AgentChatWorktrees,
        AgentChatWorktrees.of({
          register: () => Effect.void,
          source: options.agentChats
            ? Effect.succeed(options.agentChats)
            : Effect.fail(new AgentChatWorktreesUnavailable()),
        }),
      ),
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          stat: (directory) =>
            options.directories?.includes(directory)
              ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
              : Effect.fail(
                  systemError({
                    _tag: directory === options.unreadable ? "PermissionDenied" : "NotFound",
                    module: "FileSystem",
                    method: "stat",
                  }),
                ),
        }),
      ),
    );
  };

  it.effect("owns product inventory, inspection, restoration, and projection publication", () =>
    Effect.gen(function* () {
      const sharedPath = "/managed/shared/repository";
      const permanentPath = "/managed/permanent/repository";
      const threadOne = makeThread();
      const threadTwo = makeThread({
        threadId: "thread-two",
        sessionId: "session-two",
        threadName: "Second",
        cwd: `${sharedPath}/packages/worker`,
        archived: true,
        updatedAt: 20,
        recencyAt: 20,
      });
      const threads = new Map([
        [threadOne.threadId, threadOne],
        [threadTwo.threadId, threadTwo],
      ]);
      let threadReads = 0;
      let sessionReads = 0;
      const sessions = new Map<string, ProjectSession>([
        [
          "session-one",
          {
            id: "session-one",
            projectId: "project-one",
            noThreadFallbackTitle: "",
            displayTitle: "Newest",
            activityAt: 0,
            managed: false,
            pinned: false,
            pinnedOrder: null,
            archived: false,
            archivedAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            wokeAt: null,
            pageTurn: null,
            canManage: true,
            canStop: true,
            unread: false,
            thread: null,
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
          },
        ],
        [
          "session-two",
          {
            id: "session-two",
            projectId: "project-one",
            noThreadFallbackTitle: "",
            displayTitle: "Older",
            activityAt: 1,
            managed: false,
            pinned: false,
            pinnedOrder: null,
            archived: false,
            archivedAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            wokeAt: null,
            pageTurn: null,
            canManage: true,
            canStop: true,
            unread: false,
            thread: null,
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
          },
        ],
      ]);
      const projectWorkspace = makeProjectWorkspace({
        getThread: (threadId) =>
          Effect.sync(() => {
            threadReads += 1;
            return threads.get(threadId) ?? null;
          }),
        getProjectSession: (sessionId) =>
          Effect.sync(() => {
            sessionReads += 1;
            return sessions.get(sessionId) ?? null;
          }),
        listProjects: Effect.succeed([{ id: "project-one", name: "Repository" } as Project]),
        listManagedWorktreeWindow: () =>
          Effect.succeed({
            items: [
              {
                threadId: threadOne.threadId,
                projectId: "project-one",
                sessionId: "session-one",
                sessionTitle: "Newest",
                threadName: "First",
                path: sharedPath,
                linkedAt: threadOne.linkedAt,
              },
              {
                threadId: threadTwo.threadId,
                projectId: "project-one",
                sessionId: "session-two",
                sessionTitle: "Older",
                threadName: "Second",
                path: sharedPath,
                linkedAt: threadTwo.linkedAt,
              },
            ],
            nextCursor: null,
            projectionRevision: 7,
          }),
        readManagedWorktreeLifecycleSnapshot: Effect.succeed({
          projectionRevision: 7,
          consumers: [
            {
              threadId: threadOne.threadId,
              projectId: "project-one",
              sessionId: "session-one",
              executionHostId: "local",
              cwd: threadOne.cwd ?? sharedPath,
              managedWorktreePath: sharedPath,
              runtimeWorkspaceRoots: [sharedPath],
              archived: false,
              pinnedOrder: null,
              statusType: "idle",
              statusActiveFlags: [],
              createdAt: 10,
              updatedAt: 30,
              linkedAt: threadOne.linkedAt,
            },
            {
              threadId: threadTwo.threadId,
              projectId: "project-one",
              sessionId: "session-two",
              executionHostId: "local",
              cwd: threadTwo.cwd ?? sharedPath,
              managedWorktreePath: sharedPath,
              runtimeWorkspaceRoots: [sharedPath],
              archived: true,
              pinnedOrder: null,
              statusType: "idle",
              statusActiveFlags: [],
              createdAt: 11,
              updatedAt: 20,
              linkedAt: threadTwo.linkedAt,
            },
          ],
          projects: [
            {
              projectId: "project-one",
              lifecycle: "active",
              sourceRoots: [permanentPath, "/repositories/source"],
              primaryWorkspaceRoot: permanentPath,
            },
          ],
        }),
      });
      const inspected: ManagedWorktreeInspectInput[] = [];
      const restored: ManagedWorktreeRestoreInput[] = [];
      const events: CodexApplicationEvent[] = [];
      const managed = makeManaged({
        list: () =>
          Effect.succeed({
            entries: [
              {
                worktreeGitRoot: sharedPath,
                repositoryPath: "/repositories/source",
                createdAtMs: 100,
                ownerThreadId: threadOne.threadId,
                ownerReadFailed: false,
              },
              {
                worktreeGitRoot: permanentPath,
                repositoryPath: "/repositories/permanent",
                createdAtMs: 90,
                ownerThreadId: null,
                ownerReadFailed: false,
              },
            ],
          }),
        inspect: (input) =>
          Effect.sync(() => {
            inspected.push(input);
            return {
              availability: {
                state: "restorable" as const,
                repositoryPath: "/repositories/source",
                snapshotRef: "refs/codex/snapshots/one",
              },
            };
          }),
        restore: (input) =>
          Effect.sync(() => {
            restored.push(input);
            return {
              worktreeGitRoot: sharedPath,
              cwd: threadOne.cwd ?? sharedPath,
              repositoryPath: "/repositories/source",
              snapshotRef: "refs/codex/snapshots/one",
              ownerWarning: null,
            };
          }),
      });
      const scope = yield* Scope.make();
      const catalog = yield* makeCatalog(scope, projectWorkspace, managed, {
        publish: (event) => events.push(event),
      });

      assert.deepEqual(yield* catalog.list("local"), [
        {
          hostId: "local",
          path: sharedPath,
          exists: true,
          repositoryPath: "/repositories/source",
          createdAtMs: 100,
          conversations: [
            {
              threadId: "thread-one",
              projectId: "project-one",
              projectName: "Repository",
              sessionId: "session-one",
              sessionTitle: "Newest",
              threadName: "First",
              archived: false,
              updatedAt: 30,
            },
            {
              threadId: "thread-two",
              projectId: "project-one",
              projectName: "Repository",
              sessionId: "session-two",
              sessionTitle: "Older",
              threadName: "Second",
              archived: true,
              updatedAt: 20,
            },
          ],
        },
      ]);
      assert.strictEqual(threadReads, 0);
      assert.strictEqual(sessionReads, 0);
      assert.strictEqual((yield* catalog.inspectThread(threadOne.threadId)).state, "restorable");
      assert.deepEqual(inspected, [
        {
          hostId: "local",
          worktreeGitRoot: sharedPath,
          cwd: threadOne.cwd ?? sharedPath,
          candidateRepositoryPaths: [permanentPath, "/repositories/source"],
        },
      ]);
      assert.deepEqual(yield* catalog.restoreThread(threadOne.threadId), {
        availability: { state: "available" },
        ownerWarning: null,
      });
      assert.deepEqual(restored, [
        {
          hostId: "local",
          worktreeGitRoot: sharedPath,
          cwd: threadOne.cwd ?? sharedPath,
          candidateRepositoryPaths: [permanentPath, "/repositories/source"],
          ownerThreadId: threadOne.threadId,
        },
      ]);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.kind, "codex");
      if (events[0]?.kind === "codex") {
        assert.strictEqual(events[0].value.type, "threadSummary");
        if (events[0].value.type === "threadSummary") {
          assert.strictEqual(events[0].value.thread.threadId, threadOne.threadId);
        }
      }

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps inspection total while preserving restoration failures", () =>
    Effect.gen(function* () {
      let threadReads = 0;
      const thread = makeThread();
      const projectWorkspace = makeProjectWorkspace({
        getThread: (threadId) =>
          Effect.sync(() => {
            threadReads += 1;
            return threadId === thread.threadId ? thread : null;
          }),
        readManagedWorktreeLifecycleSnapshot: Effect.succeed({
          projectionRevision: 1,
          consumers: [],
          projects: [
            {
              projectId: "project-one",
              lifecycle: "active",
              sourceRoots: ["/repositories/source"],
              primaryWorkspaceRoot: "/repositories/source",
            },
          ],
        }),
      });
      const managed = makeManaged({
        inspect: (input) =>
          Effect.fail(
            new ManagedWorktreeRuntimeError({
              operation: "inspect",
              hostId: input.hostId,
              worktreeGitRoot: input.worktreeGitRoot,
              cause: new Error("offline"),
            }),
          ),
      });
      const scope = yield* Scope.make();
      const catalog = yield* makeCatalog(scope, projectWorkspace, managed);

      assert.deepEqual(yield* catalog.inspectThread("  "), {
        state: "unavailable",
        reason: "inspection-failed",
        message: "The chat has no working directory",
      });
      assert.strictEqual(threadReads, 0);
      assert.deepEqual(yield* catalog.inspectThread(thread.threadId), {
        state: "unavailable",
        reason: "inspection-failed",
        message: "offline",
      });
      const error = yield* Effect.flip(catalog.restoreThread("missing"));
      assert.instanceOf(error, ManagedWorktreeCatalogError);
      assert.strictEqual(error.operation, "restore-thread");

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("joins 100 worktrees and 500 consumers from one bulk projection", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: 100 }, (_, index) => `/managed/beef/worktree-${index}`);
      const consumers = paths.flatMap((managedWorktreePath, worktreeIndex) =>
        Array.from({ length: 5 }, (_, consumerIndex) => {
          const index = worktreeIndex * 5 + consumerIndex;
          return {
            threadId: `thread-${index}`,
            projectId: "project-one",
            sessionId: `session-${index}`,
            executionHostId: "local",
            cwd: managedWorktreePath,
            managedWorktreePath,
            runtimeWorkspaceRoots: [managedWorktreePath],
            archived: false,
            pinnedOrder: null,
            statusType: "idle" as const,
            statusActiveFlags: [],
            createdAt: index,
            updatedAt: index,
            linkedAt: "2026-08-29T00:00:00.000Z",
          };
        }),
      );
      let bulkReads = 0;
      let threadReads = 0;
      let sessionReads = 0;
      const projectWorkspace = makeProjectWorkspace({
        getThread: () =>
          Effect.sync(() => {
            threadReads += 1;
            return null;
          }),
        getProjectSession: () =>
          Effect.sync(() => {
            sessionReads += 1;
            return null;
          }),
        listProjects: Effect.succeed([{ id: "project-one", name: "Repository" } as Project]),
        listManagedWorktreeWindow: (input) =>
          Effect.sync(() => {
            bulkReads += 1;
            const start = input?.after ? Number.parseInt(input.after, 10) : 0;
            const end = Math.min(start + (input?.first ?? 200), consumers.length);
            return {
              items: consumers.slice(start, end).map((consumer) => ({
                threadId: consumer.threadId,
                projectId: "project-one",
                sessionId: consumer.sessionId,
                sessionTitle: `Session ${consumer.threadId}`,
                threadName: `Thread ${consumer.threadId}`,
                path: consumer.managedWorktreePath,
                linkedAt: consumer.linkedAt,
              })),
              nextCursor: end < consumers.length ? String(end) : null,
              projectionRevision: 9,
            };
          }),
        readManagedWorktreeLifecycleSnapshot: Effect.succeed({
          projectionRevision: 9,
          consumers,
          projects: [],
        }),
      });
      const managed = makeManaged({
        list: () =>
          Effect.succeed({
            entries: paths.map((worktreeGitRoot, index) => ({
              worktreeGitRoot,
              repositoryPath: `/repositories/source-${index}`,
              createdAtMs: index,
              ownerThreadId: null,
              ownerReadFailed: false,
            })),
          }),
      });
      const scope = yield* Scope.make();
      const catalog = yield* makeCatalog(scope, projectWorkspace, managed);
      const records = yield* catalog.list("local");

      assert.strictEqual(records.length, 100);
      assert.strictEqual(
        records.reduce((total, record) => total + record.conversations.length, 0),
        500,
      );
      assert.strictEqual(bulkReads, 3);
      assert.strictEqual(threadReads, 0);
      assert.strictEqual(sessionReads, 0);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("commits settings side effects and archives every consumer before deletion", () =>
    Effect.gen(function* () {
      const worktreePath = "/managed/shared/repository";
      const calls: string[] = [];
      let settings: ManagedWorktreeSettings = {
        worktreeRoot: null,
        autoDeleteEnabled: true,
        autoDeleteLimit: 15,
      };
      const projectWorkspace = makeProjectWorkspace({
        readManagedWorktreeLifecycleSnapshot: Effect.succeed({
          projectionRevision: 1,
          consumers: ["thread-one", "thread-two"].map((threadId, index) => ({
            threadId,
            projectId: "project-one",
            sessionId: `session-${index}`,
            executionHostId: "local",
            cwd: worktreePath,
            managedWorktreePath: worktreePath,
            runtimeWorkspaceRoots: [worktreePath],
            archived: false,
            pinnedOrder: null,
            statusType: "idle" as const,
            statusActiveFlags: [],
            createdAt: index,
            updatedAt: index,
            linkedAt: "2026-08-14T00:00:00.000Z",
          })),
          projects: [],
        }),
        setThreadArchived: (threadId, archived) =>
          Effect.sync(() => {
            calls.push(`archive:${threadId}:${archived}`);
            return {
              threads: [makeThread({ threadId, archived })],
            };
          }),
      });
      const managed = makeManaged({
        list: () =>
          Effect.succeed({
            entries: [
              {
                worktreeGitRoot: worktreePath,
                repositoryPath: null,
                createdAtMs: 1,
                ownerThreadId: null,
                ownerReadFailed: true,
              },
            ],
          }),
        remove: (input) =>
          Effect.sync(() => {
            calls.push(`remove:${input.hostId}:${input.reason}`);
            return {
              removed: true,
              alreadyMissing: false,
              snapshot: null,
              warnings: [],
            };
          }),
      });
      const roots: string[] = [];
      let retentionRequests = 0;
      const scope = yield* Scope.make();
      const catalog = yield* makeCatalog(scope, projectWorkspace, managed, {
        executionHosts: makeExecutionHosts((_hostId, root) => roots.push(root)),
        retention: ManagedWorktreeRetentionRuntime.of({
          request: Effect.sync(() => {
            retentionRequests += 1;
          }),
          run: Effect.die("Unexpected retention run"),
        }),
        settings: {
          read: () => settings,
          update: (input) => {
            settings = { ...settings, ...input };
            return settings;
          },
        },
      });

      assert.deepEqual(yield* catalog.settings, settings);
      assert.deepEqual(
        yield* catalog.updateSettings({
          worktreeRoot: "/managed/next",
          autoDeleteLimit: 20,
        }),
        {
          worktreeRoot: "/managed/next",
          autoDeleteEnabled: true,
          autoDeleteLimit: 20,
        },
      );
      assert.deepEqual(roots, ["/managed/next"]);
      assert.strictEqual(retentionRequests, 1);
      assert.isTrue(yield* catalog.delete("local", worktreePath));
      assert.deepEqual(calls, [
        "archive:thread-one:true",
        "archive:thread-two:true",
        "remove:local:settings-delete",
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("rejects a stale settings deletion before archive or worker mutation", () =>
    Effect.gen(function* () {
      let archiveCalls = 0;
      let removeCalls = 0;
      const projectWorkspace = makeProjectWorkspace({
        setThreadArchived: () =>
          Effect.sync(() => {
            archiveCalls += 1;
            return { threads: [] };
          }),
      });
      const managed = makeManaged({
        list: () => Effect.succeed({ entries: [] }),
        remove: () =>
          Effect.sync(() => {
            removeCalls += 1;
            return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
          }),
      });
      const scope = yield* Scope.make();
      const catalog = yield* makeCatalog(scope, projectWorkspace, managed);

      const result = yield* Effect.exit(catalog.delete("local", "/managed/beef/stale"));
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(archiveCalls, 0);
      assert.strictEqual(removeCalls, 0);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("lists, deletes and restores the worktree an Agent chat works in", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const agentThread = "nodex:thread:agent";
      const worktreeGitRoot = path.resolve("/old-managed/260814-1200-abcdef01");
      const cwd = path.join(worktreeGitRoot, "packages/app");
      const directories = [worktreeGitRoot, cwd];
      let present = true;
      const archived: string[] = [];
      const resumed: string[] = [];
      const removed: string[] = [];
      const inspected: ManagedWorktreeInspectInput[] = [];
      const restored: ManagedWorktreeRestoreInput[] = [];
      const catalog = yield* makeCatalog(
        scope,
        makeProjectWorkspace({
          readManagedWorktreeLifecycleSnapshot: Effect.succeed({
            projectionRevision: 1,
            consumers: [],
            projects: [
              {
                projectId: "project-one",
                lifecycle: "active" as Project["lifecycle"],
                sourceRoots: ["/repositories/repository"],
                primaryWorkspaceRoot: "/repositories/repository",
              },
            ],
          }),
        }),
        makeManaged({
          list: () =>
            Effect.succeed({
              entries: present
                ? [
                    {
                      worktreeGitRoot,
                      repositoryPath: "/repositories/repository",
                      createdAtMs: 1,
                      ownerThreadId: agentThread,
                      ownerReadFailed: false,
                    },
                  ]
                : [],
            }),
          remove: (input) =>
            Effect.sync(() => {
              removed.push(input.worktreeGitRoot);
              directories.length = 0;
              present = false;
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            }),
          restore: (input) =>
            Effect.sync(() => {
              restored.push(input);
              directories.push(worktreeGitRoot, cwd);
              present = true;
              return {
                ...input,
                repositoryPath: "/repositories/repository",
                snapshotRef: "refs/codex/snapshots/agent",
                ownerWarning: null,
              };
            }),
          inspect: (input) =>
            Effect.sync(() => {
              inspected.push(input);
              return {
                availability: {
                  state: "restorable" as const,
                  repositoryPath: "/repositories/repository",
                  snapshotRef: "refs/codex/snapshots/agent",
                },
              };
            }),
        }),
        {
          directories,
          agentChats: {
            consumers: (owners) =>
              Effect.succeed(
                owners.map((owner) => ({
                  threadId: owner.ownerThreadId,
                  projectId: "project-one",
                  sessionId: "agent-session",
                  executionHostId: owner.hostId,
                  cwd: `${owner.worktreeGitRoot}/packages/app`,
                  managedWorktreePath: owner.worktreeGitRoot,
                  runtimeWorkspaceRoots: [],
                  archived: false,
                  pinnedOrder: null,
                  statusType: "idle" as const,
                  statusActiveFlags: [],
                  createdAt: 1,
                  updatedAt: 2,
                  linkedAt: "2026-08-14T00:00:00.000Z",
                  title: "Agent chat",
                })),
              ),
            location: () =>
              Effect.succeed({
                hostId: "local",
                projectId: "project-one",
                cwd: `${worktreeGitRoot}/packages/app`,
                workspaceRoots: [worktreeGitRoot],
                managedWorktreePath: worktreeGitRoot,
                projectlessOutputDirectory: null,
                projectlessWorkspaceBrowserRoot: null,
              }),
            archive: (threadId) => Effect.sync(() => void archived.push(threadId)),
            resumeAfterRestore: (threadId) =>
              Effect.sync(() => {
                assert.include(directories, cwd);
                resumed.push(threadId);
              }),
          },
        },
      );

      const [record] = yield* catalog.list("local");
      assert.deepEqual(
        record?.conversations.map((conversation) => [
          conversation.threadId,
          conversation.sessionId,
          conversation.sessionTitle,
        ]),
        [[agentThread, "agent-session", "Agent chat"]],
      );

      assert.isTrue(yield* catalog.delete("local", worktreeGitRoot));
      assert.deepEqual(archived, [agentThread]);
      assert.deepEqual(removed, [worktreeGitRoot]);

      // Once removed, the chat's working directory still names its allocation.
      assert.deepEqual(yield* catalog.inspectThread(agentThread), {
        state: "restorable",
        repositoryPath: "/repositories/repository",
        snapshotRef: "refs/codex/snapshots/agent",
        projectCheckout: null,
      });
      assert.deepEqual(inspected, [
        {
          hostId: "local",
          worktreeGitRoot,
          cwd: `${worktreeGitRoot}/packages/app`,
          candidateRepositoryPaths: ["/repositories/repository"],
        },
      ]);
      assert.deepEqual(yield* catalog.restoreThread(agentThread), {
        availability: { state: "available" },
        ownerWarning: null,
      });
      assert.deepEqual(restored, [{ ...inspected[0], ownerThreadId: agentThread }]);
      assert.deepEqual(resumed, [agentThread]);
      assert.deepEqual(yield* catalog.inspectThread(agentThread), { state: "available" });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps Page Workspace cleanup with its Page lifecycle", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      let removed = false;
      const worktreeGitRoot = path.resolve("/managed/abcd/page");
      const catalog = yield* makeCatalog(
        scope,
        makeProjectWorkspace(),
        makeManaged({
          list: () =>
            Effect.succeed({
              entries: [
                {
                  worktreeGitRoot,
                  repositoryPath: "/repo",
                  createdAtMs: 1,
                  ownerThreadId: null,
                  ownerReadFailed: false,
                },
              ],
            }),
          remove: () =>
            Effect.sync(() => {
              removed = true;
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            }),
        }),
        { pageWorkspacePaths: Effect.succeed([worktreeGitRoot]) },
      );
      const result = yield* Effect.exit(catalog.delete("local", worktreeGitRoot));
      assert.strictEqual(result._tag, "Failure");
      assert.isFalse(removed);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "inspects local working directories and offers only the Project's available primary folder",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkout = path.resolve("/repo/primary");
          const managedRoot = path.resolve("/previous-root/abcd/primary");
          const nestedCheckout = path.resolve("/previous-root/ca11/primary");
          const missing = path.resolve("/other/missing");
          const unreadable = path.resolve("/other/unreadable");
          const catalog = yield* makeCatalog(
            yield* Scope.Scope,
            makeProjectWorkspace({
              getThread: (threadId) =>
                Effect.succeed(
                  makeThread({
                    cwd:
                      threadId === "managed"
                        ? `${managedRoot}/src`
                        : threadId === "nested"
                          ? `${nestedCheckout}/deleted-subdirectory`
                          : threadId,
                    managedWorktreePath:
                      threadId === "managed"
                        ? managedRoot
                        : threadId === "nested"
                          ? nestedCheckout
                          : null,
                  }),
                ),
              getProject: () =>
                Effect.succeed({
                  sources: [{ kind: "directory", path: checkout, order: 0 }],
                } as Project),
            }),
            makeManaged({
              inspect: () => Effect.succeed({ availability: { state: "gone", worktree: true } }),
            }),
            { directories: [checkout, nestedCheckout], unreadable },
          );
          assert.deepEqual(yield* catalog.inspectThread(checkout), { state: "available" });
          assert.deepEqual(yield* catalog.inspectThread(missing), {
            state: "gone",
            worktree: false,
            projectCheckout: checkout,
          });
          assert.deepEqual(yield* catalog.inspectThread("managed"), {
            state: "gone",
            worktree: true,
            projectCheckout: checkout,
          });
          assert.deepEqual(yield* catalog.inspectThread("nested"), {
            state: "gone",
            worktree: false,
            projectCheckout: null,
          });
          const failure = yield* catalog.inspectThread(unreadable);
          assert.strictEqual(failure.state, "unavailable");
        }),
      ),
  );
});

describe("ExecutionHostRuntime", () => {
  const sshHost = (
    id: string,
    managedRoot = `/remote/${id}/worktrees`,
  ): CodexSshExecutionHostConfig => ({
    id,
    displayName: `Host ${id}`,
    kind: "ssh",
    sshAlias: id,
    port: null,
    managedRoot,
    repositoryRoots: [`/remote/${id}/repos`],
    codexBinary: null,
    codexHome: null,
    enabled: true,
  });

  it.effect("routes ephemeral Threads before the durable Workspace authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const durableReads: string[] = [];
        const core = CoreModules.of({
          workspace: {
            read: (read: { readonly kind: string; readonly thread_id?: string }) =>
              Effect.sync(() => {
                durableReads.push(read.thread_id ?? "");
                return {
                  value: {
                    kind: "thread",
                    thread: {
                      backend_binding:
                        read.thread_id === "thread:acp"
                          ? { driver: "acpRegistry", instanceId: "claude-code" }
                          : { driver: "codex", instanceId: "codex" },
                      execution_host_id: "remote-durable",
                    },
                  },
                } as ProjectWorkspaceReadSnapshot;
              }),
          },
        } as unknown as CoreModuleClients);
        const ephemeral = CodexEphemeralThreadRouting.of({
          resolve: (threadId) =>
            Effect.succeed(threadId === "thread:ephemeral" ? "remote-ephemeral" : null),
          register: () => Effect.void,
          remove: () => Effect.void,
        });
        const context = yield* Layer.build(
          threadHostResolverLive.pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(CoreModules, core),
                Layer.succeed(CodexEphemeralThreadRouting, ephemeral),
              ),
            ),
          ),
        );
        const resolver = Context.get(context, CodexThreadHostResolver);

        assert.strictEqual(yield* resolver.resolve("thread:ephemeral"), "remote-ephemeral");
        assert.strictEqual(yield* resolver.resolve("thread:durable"), "remote-durable");
        const rejected = yield* resolver.resolve("thread:acp").pipe(Effect.flip);
        assert.strictEqual(rejected.reason, "request");
        assert.strictEqual(rejected.operation, "thread-host.resolve-backend");
        assert.deepStrictEqual(durableReads, ["thread:durable", "thread:acp"]);
      }),
    ),
  );

  const makeHarness = (
    failedHostId?: string,
    ensureReady?: (
      config: CodexSshExecutionHostConfig,
      signal?: AbortSignal,
    ) => ReturnType<RemoteExecutionHostTransport["ensureReady"]>,
    nativeEndpoints = true,
  ) => {
    let settings: CodexExecutionHostSettings = { sshHosts: [] };
    const registered = new Map<string, CodexExecutionHostConfig>();
    const removed: string[] = [];
    const shutdowns: string[] = [];
    const workerRequests: unknown[] = [];
    const failedHosts = new Set(failedHostId ? [failedHostId] : []);
    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    const gateway = CodexGateway.of({
      promoteQueuedCatalogPage: Effect.succeed(false),
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
      requestLocal: unsupported,
      requestOnHost: unsupported,
      requestForThread: unsupported,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: unsupported,
      reconcileHost: (config) =>
        Effect.sync(() => {
          registered.set(config.hostId, config);
        }),
      removeHost: (hostId) =>
        Effect.sync(() => {
          registered.delete(hostId);
          removed.push(hostId);
        }),
      restartHost: unsupported,
    });
    const factories: ExecutionHostRuntimeFactories = {
      makeTransport: ({ config }) =>
        ({
          hostId: config.id,
          config,
          ensureReady: (signal) =>
            ensureReady
              ? ensureReady(config, signal)
              : failedHosts.has(config.id)
                ? Promise.reject(new Error("host unavailable"))
                : Promise.resolve({
                    hostId: config.id,
                    home: `/remote/${config.id}`,
                    codexHome: `/remote/${config.id}/.codex`,
                    platform: "linux",
                    architecture: "arm64",
                    nodeVersion: "v24",
                    gitVersion: "git 2",
                    codexVersion: "codex 1",
                  }),
          openWorktreeWorker: () => Promise.reject(new Error("not exercised")),
          appServerClientOptions: () => ({ binaryPath: "ssh", args: [] }),
          describe: () => Promise.reject(new Error("not exercised")),
          download: () => Promise.reject(new Error("not exercised")),
          upload: () => Promise.reject(new Error("not exercised")),
          cleanup: () => Promise.reject(new Error("not exercised")),
        }) satisfies RemoteExecutionHostTransport,
      makeWorker: ({ hostId }) =>
        Effect.acquireRelease(
          Effect.succeed(
            WorktreeWorkerRuntime.of({
              hostId,
              request: ((request: { readonly operation: string }) =>
                Effect.sync(() => {
                  workerRequests.push(request);
                  if (request.operation === "git-root") return { root: `/remote/${hostId}/repo` };
                  throw new Error(`Unsupported test operation: ${request.operation}`);
                })) as WorktreeWorkerRuntime["Service"]["request"],
            }),
          ),
          () =>
            Effect.sync(() => {
              shutdowns.push(hostId);
            }),
        ),
    };
    const localWorktreeWorker = WorktreeWorkerRuntime.of({
      hostId: "local",
      request: () => Effect.die("unused"),
    });
    const configuration = ExecutionHostConfiguration.of({
      settings: Effect.sync(() => settings),
      update: (input) =>
        Effect.sync(() => {
          settings = { sshHosts: [...input.sshHosts] };
          return settings;
        }),
    });
    const managedWorktrees = ManagedWorktreeConfiguration.of({
      settings: Effect.succeed({
        worktreeRoot: null,
        autoDeleteEnabled: true,
        autoDeleteLimit: 15,
      }),
      update: () => Effect.die("unused"),
    });
    const layer = executionHostRuntimeLive({
      runtimeStateHome: "/profile/agent",
      codexHome: "/native/.codex",
      nodexHome: "/profile",
      remoteWorktreeWorkerBundlePath: "/app/remote-worktree-worker.cjs",
      factories,
      nativeEndpoints: nativeEndpoints ? gateway : undefined,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CodexGateway, gateway),
          Layer.succeed(WorktreeWorkerRuntime, localWorktreeWorker),
          Layer.succeed(ExecutionHostConfiguration, configuration),
          Layer.succeed(ManagedWorktreeConfiguration, managedWorktrees),
        ),
      ),
    );
    return { failedHosts, layer, registered, removed, shutdowns, workerRequests };
  };

  it.effect("owns local workers without native SSH sessions and refuses remote acquisition", () =>
    Effect.gen(function* () {
      const harness = makeHarness(undefined, undefined, false);
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const hosts = Context.get(context, ExecutionHostRuntime);
      assert.strictEqual((yield* hosts.resolve("local")).descriptor.kind, "local");
      const remote = yield* Effect.exit(hosts.updateSettings({ sshHosts: [sshHost("remote")] }));
      assert.isTrue(Exit.isFailure(remote));
      assert.deepEqual([...harness.registered.keys()], []);
      assert.deepEqual(harness.workerRequests, []);
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(yield* hosts.hosts(), []);
    }),
  );

  it.effect("owns local and dynamic SSH host resources until its Scope closes", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const hosts = Context.get(context, ExecutionHostRuntime);

      assert.deepEqual(
        (yield* hosts.hosts()).map((host) => host.hostId),
        ["local"],
      );
      yield* hosts.updateSettings({ sshHosts: [sshHost("alpha")] });
      assert.deepEqual(
        (yield* hosts.hosts()).map((host) => host.hostId),
        ["alpha", "local"],
      );
      assert.deepEqual([...harness.registered.keys()], ["alpha"]);

      yield* hosts.updateSettings({ sshHosts: [sshHost("alpha", "/remote/alpha/new")] });
      assert.deepEqual(harness.removed, ["alpha"]);
      assert.deepEqual(harness.shutdowns, ["alpha"]);
      assert.strictEqual(
        (yield* hosts.resolve("alpha")).descriptor.managedRoot,
        "/remote/alpha/new",
      );
      assert.deepEqual([...(yield* SubscriptionRef.get(hosts.activeSshHosts)).keys()], ["alpha"]);

      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(yield* hosts.hosts(), []);
      assert.deepEqual(harness.removed, ["alpha", "alpha"]);
      assert.deepEqual(harness.shutdowns, ["alpha", "alpha"]);
    }),
  );

  it.effect("routes git-root through the selected execution host worker", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const hosts = Context.get(context, ExecutionHostRuntime);

      yield* hosts.updateSettings({ sshHosts: [sshHost("builder")] });
      const host = yield* hosts.resolve("builder", "git-root");
      const result = yield* host.request({
        operation: "git-root",
        input: { requestId: "git-root:1", hostId: "builder", cwd: "/remote/builder/workspace" },
      });

      assert.deepEqual(result, { root: "/remote/builder/repo" });
      assert.deepEqual(harness.workerRequests, [
        {
          operation: "git-root",
          input: { requestId: "git-root:1", hostId: "builder", cwd: "/remote/builder/workspace" },
        },
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps healthy hosts active while reporting unavailable peers", () =>
    Effect.gen(function* () {
      const harness = makeHarness("broken");
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const hosts = Context.get(context, ExecutionHostRuntime);

      const result = yield* Effect.result(
        hosts.updateSettings({ sshHosts: [sshHost("healthy"), sshHost("broken")] }),
      );
      assert.isTrue(Result.isFailure(result));
      assert.deepEqual(
        (yield* hosts.hosts()).map((host) => host.hostId),
        ["healthy", "local"],
      );
      assert.deepEqual([...harness.registered.keys()], ["healthy"]);

      harness.failedHosts.delete("broken");
      yield* hosts.reconcile();
      assert.deepEqual(
        (yield* hosts.hosts()).map((host) => host.hostId),
        ["broken", "healthy", "local"],
      );
      assert.deepEqual([...harness.registered.keys()].sort(), ["broken", "healthy"]);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("aborts an SSH health probe when the owning application Scope closes", () =>
    Effect.gen(function* () {
      let observedSignal: AbortSignal | undefined;
      let markProbeStarted: (() => void) | undefined;
      const probeStarted = new Promise<void>((resolve) => {
        markProbeStarted = resolve;
      });
      const harness = makeHarness(undefined, (_config, signal) => {
        observedSignal = signal;
        markProbeStarted?.();
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const hosts = Context.get(context, ExecutionHostRuntime);
      const reconcile = yield* hosts
        .updateSettings({ sshHosts: [sshHost("slow")] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => probeStarted);

      yield* Scope.close(scope, Exit.void);

      assert.isTrue(observedSignal?.aborted);
      const reconcileExit = yield* Fiber.await(reconcile);
      assert.isTrue(Exit.isFailure(reconcileExit));
      if (Exit.isFailure(reconcileExit))
        assert.isTrue(Cause.hasInterruptsOnly(reconcileExit.cause));
      assert.deepEqual([...harness.registered.keys()], []);
    }),
  );
});

describe("CodexThreadExecution", () => {
  it.effect.each([
    { hostId: "local", rollback: false },
    { hostId: "remote-a", rollback: false },
    { hostId: "local", rollback: true },
  ])(
    "switches the native execution location on $hostId (relocation rollback: $rollback)",
    ({ hostId, rollback }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const requests: {
            method: string;
            params: Record<string, unknown>;
            scheduling: unknown;
          }[] = [];
          const projected: unknown[] = [];
          const location = {
            hostId,
            cwd: "/managed/task",
            workspaceRoots: ["/managed/task"],
            managedWorktreePath: "/managed/task",
            projectId: "project-a",
            projectlessOutputDirectory: null,
            projectlessWorkspaceBrowserRoot: null,
          };
          const capability = createCodexAppServerCapabilitySnapshot({
            hostId,
            generation: 7,
            userAgent: "codex-app-server/0.153.4",
            nativeAppTools: hostId === "local",
          });
          const context = yield* Layer.buildWithScope(
            live.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CodexAppServerCapabilities, {
                    forHost: () => Effect.succeed(capability),
                    forThread: () => Effect.succeed(capability),
                    isCurrent: () => Effect.succeed(true),
                  }),
                  Layer.succeed(CodexGateway, {
                    localHostId: "local",
                    requestOnHost: (
                      targetHost: string,
                      method: string,
                      params: Record<string, unknown>,
                      scheduling: unknown,
                    ) =>
                      Effect.sync(() => {
                        assert.strictEqual(targetHost, hostId);
                        requests.push({ method, params, scheduling });
                        if (method === "thread/read")
                          return {
                            thread: {
                              id: "thread-a",
                              path: "/rollouts/task.jsonl",
                              status: { type: rollback ? "idle" : "notLoaded" },
                            },
                          };
                        if (method === "thread/settings/update") return {};
                        assert.strictEqual(method, "thread/resume");
                        return {
                          thread: { id: "thread-a" },
                          cwd: location.cwd,
                          runtimeWorkspaceRoots: location.workspaceRoots,
                        };
                      }),
                  } as unknown as CodexGateway["Service"]),
                  Layer.succeed(CodexConversationProjection, {
                    relocateExecution: (input: unknown) => Effect.sync(() => projected.push(input)),
                  } as unknown as CodexConversationProjection["Service"]),
                  Layer.succeed(ConversationEntityMap, {
                    current: () => null,
                  } as unknown as ConversationEntityMap["Service"]),
                  Layer.succeed(DesktopToolRuntime, {
                    threadConfig: () => Effect.succeed({ "features.js_repl": false }),
                  } as unknown as DesktopToolRuntime["Service"]),
                  Layer.succeed(CoreModules, {} as CoreModules["Service"]),
                  Layer.succeed(CodexTurnCommands, {} as CodexTurnCommands["Service"]),
                  Layer.succeed(ConversationCommands, {} as ConversationCommands["Service"]),
                  Layer.succeed(ExecutionHostRuntime, {} as ExecutionHostRuntime["Service"]),
                ),
              ),
            ),
            scope,
          );

          const execution = Context.get(context, CodexThreadExecution);
          if (rollback) {
            yield* execution.switchRuntime("thread-a", location, {
              destination: {
                ...location,
                cwd: "/repo",
                workspaceRoots: ["/repo"],
                managedWorktreePath: null,
              },
              prepared: {
                direction: "relocate",
                sourceWorkspaceRoot: location.cwd,
                destinationWorkspaceRoot: "/repo",
              },
            });
            assert.deepEqual(
              requests.map((request) => request.method),
              ["thread/read", "thread/settings/update"],
            );
            assert.strictEqual(requests[1]?.params.cwd, location.cwd);
            assert.deepInclude(projected[0], {
              cwd: location.cwd,
              managedWorktreePath: location.managedWorktreePath,
            });
            return;
          }

          yield* execution.switchRuntime("thread-a", location, null);

          assert.deepEqual(
            requests.map((request) => request.method),
            ["thread/read", "thread/resume"],
          );
          const resume = requests[1]!;
          const config = resume.params.config as Record<string, unknown>;
          assert.strictEqual(config["features.js_repl"], false);
          // A remote destination never receives this host's REPL, only the inert disabled server.
          if (hostId !== "local") {
            assert.deepEqual(
              config["mcp_servers.node_repl"],
              DISABLED_DESKTOP_TOOL_REPL_CONFIG["mcp_servers.node_repl"],
            );
          }
          assert.deepEqual(
            config["mcp_servers.nodex_app.enabled_tools"],
            hostId === "local" ? appToolCatalog.map((tool) => tool.name) : undefined,
          );
          assert.deepEqual(resume.scheduling, { expectedHostId: hostId, expectedGeneration: 7 });
          assert.strictEqual(projected.length, 1);
        }),
      ),
  );
});
