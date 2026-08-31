import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { ManagedWorktreeSettings, Project, ProjectSession } from "../../shared/types";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { ManagedWorktreeConfiguration } from "./ExecutionHostConfiguration";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ManagedWorktreeCatalogError, make } from "./ManagedWorktreeCatalog";
import {
  ManagedWorktreeRuntime,
  ManagedWorktreeRuntimeError,
  type ManagedWorktreeInspectInput,
  type ManagedWorktreeRestoreInput,
} from "./ManagedWorktreeRuntime";
import { ManagedWorktreeRetentionRuntime } from "./ManagedWorktreeRetentionRuntime";

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
  backendBinding: { kind: "codex" },
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
    readonly publish?: (event: CodexApplicationEvent) => void;
    readonly retention?: ManagedWorktreeRetentionRuntime["Service"];
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
  return make({ defaultManagedRoot: "/managed" }).pipe(
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
    Effect.provideService(Scope.Scope, scope),
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
          order: 0,
          pinned: false,
          pinnedOrder: null,
          archived: false,
          archivedAt: null,
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
          order: 1,
          pinned: false,
          pinnedOrder: null,
          archived: false,
          archivedAt: null,
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

    assert.deepEqual(yield* catalog.inspectThread("  "), { state: "not-managed" });
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
