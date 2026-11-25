import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { systemError } from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import type {
  ManagedWorktreeSettings,
  CodexSshExecutionHostConfig,
  Project,
} from "../../shared/types";
import { AutomationApplication } from "../../host/automation-application/AutomationApplication";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import {
  AgentChatWorktrees,
  live as agentChatWorktreesLive,
  type AgentChatWorktreeSource,
} from "./AgentChatWorktrees";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { ManagedWorktreeConfiguration } from "./ExecutionHostConfiguration";
import {
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
  type ExecutionHost,
} from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime, ManagedWorktreeRuntimeError } from "./ManagedWorktreeRuntime";
import {
  ManagedWorktreeRetentionRuntime,
  live as managedWorktreeRetentionRuntimeLive,
} from "./ManagedWorktreeRetentionRuntime";
import {
  type CodexThreadHandoffJournalStorage,
  CodexThreadHandoffJournalStorageError,
} from "../platform/CodexThreadHandoffJournalStorage";
import type { CodexThreadHandoffJournalEntry } from "../codex/codex-thread-handoff-journal";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  chmod,
  symlink,
  realpath,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import * as Result from "effect/Result";
import { TestClock as TestClockWorkspaceTextSearch } from "effect/testing";
import type {
  WorkspaceTextSearchEvent,
  WorkspaceTextSearchRequest,
} from "../../shared/workspace-text-search";
import { RipgrepExecutionRuntime } from "../platform/node/RipgrepExecutionRuntime";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import {
  live as platformLive,
  WorkspaceTextSearchPlatform,
  type WorkspaceTextSearchHost,
} from "../platform/node/WorkspaceTextSearchPlatform";
import { searchWorkspaceTextOnHost } from "./WorkspaceTextSearch";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { WorktreeWorkerError } from "../host-runtime/WorktreeWorkerRuntime";
import type { CodexWorktreeWorkerRequest } from "../codex/codex-worktree-worker-protocol";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CrossHostThreadHandoff } from "./CrossHostThreadHandoff";
import { ManagedWorktreeHandoff, live } from "./ManagedWorktreeHandoff";

describe("ManagedWorktreeRetentionRuntime", () => {
  const disabledSettings: ManagedWorktreeSettings = {
    worktreeRoot: null,
    autoDeleteEnabled: false,
    autoDeleteLimit: 1,
  };

  const projectWorkspace = (
    overrides: Partial<ProjectWorkspaceService> = {},
  ): ProjectWorkspaceService =>
    ({
      readManagedWorktreeLifecycleSnapshot: Effect.succeed({
        projectionRevision: 1,
        consumers: [],
        projects: [],
      }),
      ...overrides,
    }) as ProjectWorkspaceService;

  const executionHosts = (hostIds: readonly string[] = []): ExecutionHostRuntime["Service"] =>
    ({
      hosts: () => Effect.succeed(hostIds.map((hostId) => ({ hostId }))),
    }) as unknown as ExecutionHostRuntime["Service"];

  const managedWorktrees = (
    overrides: Partial<ManagedWorktreeRuntime["Service"]> = {},
  ): ManagedWorktreeRuntime["Service"] =>
    ManagedWorktreeRuntime.of({
      list: () => Effect.succeed({ entries: [] }),
      remove: () => Effect.die("Unexpected managed-worktree removal"),
      inspect: () => Effect.die("Unexpected managed-worktree inspection"),
      restore: () => Effect.die("Unexpected managed-worktree restoration"),
      setOwner: () => Effect.die("Unexpected managed-worktree owner mutation"),
      registerNewborn: () => Effect.void,
      releaseNewborn: () => Effect.void,
      isNewborn: () => Effect.succeed(false),
      newborns: Effect.succeed([]),
      ...overrides,
    });

  const pendingWorktrees = (
    list: CodexPendingWorktreeRuntime["Service"]["list"] = () => [],
  ): CodexPendingWorktreeRuntime["Service"] =>
    ({
      list,
      changes: Stream.empty,
    }) as unknown as CodexPendingWorktreeRuntime["Service"];

  const automationApplication = (
    get: AutomationApplication["Service"]["runs"]["get"] = () => Effect.succeed(null),
  ): AutomationApplication["Service"] =>
    AutomationApplication.of({ runs: { get } } as unknown as AutomationApplication["Service"]);

  const buildRuntime = (
    options: {
      readonly settings?: () => ManagedWorktreeSettings;
      readonly projectWorkspace?: ProjectWorkspaceService;
      readonly executionHosts?: ExecutionHostRuntime["Service"];
      readonly managedWorktrees?: ManagedWorktreeRuntime["Service"];
      readonly pendingWorktrees?: CodexPendingWorktreeRuntime["Service"];
      readonly automation?: AutomationApplication["Service"];
      readonly handoffJournal?: CodexThreadHandoffJournalStorage;
      readonly agentChats?: AgentChatWorktreeSource;
      readonly pageWorkspacePaths?: Effect.Effect<readonly string[], unknown>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const chats = yield* Layer.buildWithScope(agentChatWorktreesLive, scope);
      if (options.agentChats)
        yield* Context.get(chats, AgentChatWorktrees)
          .register(options.agentChats)
          .pipe(Scope.provide(scope));
      const context = yield* Layer.buildWithScope(
        managedWorktreeRetentionRuntimeLive({
          pageWorkspacePaths: options.pageWorkspacePaths,
          handoffJournal: options.handoffJournal ?? {
            load: Effect.succeed([]),
            persist: () => Effect.void,
          },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeedContext(chats),
              Layer.succeed(AutomationApplication, options.automation ?? automationApplication()),
              Layer.succeed(
                CodexApplicationEventHub,
                CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
              ),
              Layer.succeed(ExecutionHostRuntime, options.executionHosts ?? executionHosts()),
              Layer.succeed(
                ProjectWorkspace,
                ProjectWorkspace.of(options.projectWorkspace ?? projectWorkspace()),
              ),
              Layer.succeed(
                ManagedWorktreeConfiguration,
                ManagedWorktreeConfiguration.of({
                  settings: Effect.sync(options.settings ?? (() => disabledSettings)),
                  update: () => Effect.die("unused"),
                }),
              ),
              Layer.succeed(ManagedWorktreeRuntime, options.managedWorktrees ?? managedWorktrees()),
              Layer.succeed(
                CodexPendingWorktreeRuntime,
                options.pendingWorktrees ?? pendingWorktrees(),
              ),
            ),
          ),
        ),
        scope,
      );
      return {
        runtime: Context.get(context, ManagedWorktreeRetentionRuntime),
        scope,
      };
    });

  it.effect("coalesces scheduled requests against one fixed deadline", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { runtime, scope } = yield* buildRuntime({
        settings: () => {
          calls.push("sweep");
          return disabledSettings;
        },
      });

      yield* runtime.request;
      yield* Effect.yieldNow;
      yield* runtime.request;
      yield* TestClock.adjust("299 millis");
      assert.deepEqual(calls, []);

      yield* TestClock.adjust("1 millis");
      yield* Effect.yieldNow;
      assert.deepEqual(calls, ["sweep"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("flushes a pending debounce when an awaited sweep is admitted", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { runtime, scope } = yield* buildRuntime({
        settings: () => {
          calls.push("sweep");
          return disabledSettings;
        },
      });

      yield* runtime.request;
      yield* Effect.yieldNow;
      const result = yield* runtime.run;

      assert.strictEqual(result.status, "skipped");
      assert.deepEqual(calls, ["sweep"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("collapses requests admitted during a sweep into one immediate rerun", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const rerunFinished = yield* Deferred.make<void>();
      let inventoryReads = 0;
      const managed = managedWorktrees({
        list: () =>
          Effect.gen(function* () {
            inventoryReads += 1;
            if (inventoryReads === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            if (inventoryReads === 4) {
              yield* Deferred.succeed(rerunFinished, undefined);
            }
            return { entries: [] };
          }),
      });
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managed,
      });

      yield* runtime.request;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("300 millis");
      yield* Deferred.await(firstStarted);

      yield* runtime.request;
      yield* runtime.request;
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(rerunFinished);

      assert.strictEqual(inventoryReads, 4);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("interrupts a pending debounce when its owning Scope closes", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { runtime, scope } = yield* buildRuntime({
        settings: () => {
          calls += 1;
          return disabledSettings;
        },
      });

      yield* runtime.request;
      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("1 second");

      assert.strictEqual(calls, 0);
    }),
  );

  it.effect("plans from one Core snapshot and prunes through the physical lifecycle", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      const managed = managedWorktrees({
        list: () =>
          Effect.succeed({
            entries: Array.from({ length: 3 }, (_, index) => ({
              worktreeGitRoot: `/managed/${String(index).padStart(4, "0")}/repository`,
              repositoryPath: "/repositories/repository",
              createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
              ownerThreadId: null,
              ownerReadFailed: false,
            })),
          }),
        remove: (input) =>
          Effect.sync(() => {
            removed.push(input.worktreeGitRoot);
            return {
              removed: true,
              alreadyMissing: false,
              snapshot: null,
              warnings: [],
            };
          }),
      });
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managed,
      });

      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "planned");
      assert.deepEqual(
        plan.status === "planned" ? plan.delete.map((item) => item.worktreeGitRoot) : [],
        ["/managed/0000/repository", "/managed/0001/repository"],
      );
      assert.deepEqual(removed, ["/managed/0000/repository", "/managed/0001/repository"]);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("revalidates current inventory and new pending protection before deletion", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      let listCalls = 0;
      let pendingReads = 0;
      const entry = (index: number) => ({
        worktreeGitRoot: `/managed/${String(index).padStart(4, "0")}/repository`,
        repositoryPath: "/repositories/repository",
        createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
        ownerThreadId: null,
        ownerReadFailed: false,
      });
      const managed = managedWorktrees({
        list: () =>
          Effect.sync(() => {
            listCalls += 1;
            return {
              entries: listCalls === 1 ? [entry(0), entry(1), entry(2)] : [entry(1), entry(2)],
            };
          }),
        remove: (input) =>
          Effect.sync(() => {
            removed.push(input.worktreeGitRoot);
            return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
          }),
      });
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managed,
        pendingWorktrees: pendingWorktrees(() => {
          pendingReads += 1;
          return pendingReads === 1
            ? []
            : ([
                { hostId: "local", worktreeGitRoot: entry(1).worktreeGitRoot },
              ] as unknown as readonly CodexPendingWorktreeEntry[]);
        }),
      });

      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;

      assert.strictEqual(plan.status, "planned");
      assert.strictEqual(listCalls, 2);
      assert.deepEqual(removed, []);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("retains unfinished handoff paths from the durable journal after restart", () =>
    Effect.gen(function* () {
      const roots = [
        "/managed/source",
        "/managed/destination",
        "/managed/allocated",
        "/managed/unused",
        "/managed/keep",
      ];
      const location = (cwd: string) => ({
        hostId: "local",
        cwd,
        workspaceRoots: [cwd],
        managedWorktreePath: cwd,
        projectId: "project",
        projectlessOutputDirectory: null,
        projectlessWorkspaceBrowserRoot: null,
      });
      const entry: CodexThreadHandoffJournalEntry = {
        schemaVersion: 1,
        operationId: "retained",
        threadId: "thread",
        phase: "recovery-required",
        source: location(roots[0]!),
        destination: location(roots[1]!),
        allocatedDestination: { hostId: "local", worktreeGitRoot: roots[2]! },
        requestedDestinationHostId: null,
        prepared: null,
        runtimeSwitched: false,
        coreCommitted: false,
        followUpPrompt: null,
        followUpDispatchStarted: false,
        warnings: [],
        lastError: "Reply lost",
        failedPhase: "preparing-destination",
        createdAt: 1,
        updatedAt: 2,
        completedAt: null,
      };
      const removed: string[] = [];
      let journalReads = 0;
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        handoffJournal: {
          load: Effect.sync(() => {
            journalReads += 1;
            return [entry];
          }),
          persist: () => Effect.void,
        },
        managedWorktrees: managedWorktrees({
          list: () =>
            Effect.succeed({
              entries: roots.map((worktreeGitRoot, index) => ({
                worktreeGitRoot,
                repositoryPath: "/repo",
                createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
                ownerThreadId: null,
                ownerReadFailed: false,
              })),
            }),
          remove: (input) =>
            Effect.sync(() => {
              removed.push(input.worktreeGitRoot);
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            }),
        }),
      });
      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "planned");
      assert.strictEqual(journalReads, 2);
      assert.deepEqual(removed, [roots[3]]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("replans with the current retention limit before deletion", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      let settingsReads = 0;
      const managed = managedWorktrees({
        list: () =>
          Effect.succeed({
            entries: Array.from({ length: 3 }, (_, index) => ({
              worktreeGitRoot: `/managed/${String(index).padStart(4, "0")}/repository`,
              repositoryPath: "/repositories/repository",
              createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
              ownerThreadId: null,
              ownerReadFailed: false,
            })),
          }),
        remove: (input) =>
          Effect.sync(() => {
            removed.push(input.worktreeGitRoot);
            return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
          }),
      });
      const { runtime, scope } = yield* buildRuntime({
        settings: () => {
          settingsReads += 1;
          return {
            ...disabledSettings,
            autoDeleteEnabled: true,
            autoDeleteLimit: settingsReads === 1 ? 1 : 3,
          };
        },
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managed,
      });

      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;

      assert.strictEqual(plan.status, "planned");
      assert.deepEqual(plan.status === "planned" ? plan.delete : [], []);
      assert.deepEqual(removed, []);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("protects worktrees owned by the canonical Automation application", () =>
    Effect.gen(function* () {
      const worktreeGitRoot = "/managed/automation/repository";
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managedWorktrees({
          list: () =>
            Effect.succeed({
              entries: [
                {
                  worktreeGitRoot,
                  repositoryPath: "/repositories/repository",
                  createdAtMs: 1,
                  ownerThreadId: "automation-thread",
                  ownerReadFailed: false,
                },
              ],
            }),
        }),
        projectWorkspace: projectWorkspace({
          readManagedWorktreeLifecycleSnapshot: Effect.succeed({
            projectionRevision: 1,
            consumers: [
              {
                threadId: "automation-thread",
                projectId: "project-one",
                sessionId: "session-one",
                executionHostId: "local",
                cwd: worktreeGitRoot,
                managedWorktreePath: worktreeGitRoot,
                runtimeWorkspaceRoots: [worktreeGitRoot],
                archived: false,
                pinnedOrder: null,
                statusType: "idle",
                statusActiveFlags: [],
                createdAt: 1,
                updatedAt: 1,
                linkedAt: "2026-08-14T00:00:00.000Z",
              },
            ],
            projects: [],
          }),
        }),
        automation: automationApplication((threadId) =>
          Effect.succeed(threadId === "automation-thread" ? ({} as never) : null),
        ),
      });

      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "planned");
      if (plan.status === "planned") {
        assert.deepEqual(plan.items[0]?.protectionReasons, ["automation"]);
        assert.deepEqual(plan.delete, []);
      }
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("caps deletion at three and lets peer failures settle independently", () =>
    Effect.gen(function* () {
      const gates = yield* Effect.forEach(Array.from({ length: 4 }), () => Deferred.make<void>());
      const firstBatchStarted = yield* Deferred.make<void>();
      const secondBatchStarted = yield* Deferred.make<void>();
      const started: number[] = [];
      let active = 0;
      let peak = 0;
      const managed = managedWorktrees({
        list: () =>
          Effect.succeed({
            entries: Array.from({ length: 5 }, (_, index) => ({
              worktreeGitRoot: `/managed/${index}/repository`,
              repositoryPath: "/repositories/repository",
              createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
              ownerThreadId: null,
              ownerReadFailed: false,
            })),
          }),
        remove: (input) =>
          Effect.gen(function* () {
            const index = Number(input.worktreeGitRoot.split("/")[2]);
            const gate = gates[index];
            if (!gate) return yield* Effect.die("Missing deletion gate");
            started.push(index);
            active += 1;
            peak = Math.max(peak, active);
            if (started.length === 3) yield* Deferred.succeed(firstBatchStarted, undefined);
            if (started.length === 4) yield* Deferred.succeed(secondBatchStarted, undefined);
            yield* Deferred.await(gate).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active -= 1;
                }),
              ),
            );
            if (index === 1) {
              return yield* Effect.fail(
                new ManagedWorktreeRuntimeError({
                  operation: "remove",
                  hostId: input.hostId,
                  worktreeGitRoot: input.worktreeGitRoot,
                  cause: new Error("expected"),
                }),
              );
            }
            return {
              removed: true,
              alreadyMissing: false,
              snapshot: null,
              warnings: [],
            };
          }),
      });
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managed,
      });
      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const sweep = yield* Effect.forkChild(runtime.run, { startImmediately: true });
      yield* Deferred.await(firstBatchStarted);
      assert.strictEqual(peak, 3);
      yield* Effect.forEach(gates.slice(0, 3), (gate) => Deferred.succeed(gate, undefined));
      yield* Deferred.await(secondBatchStarted);
      yield* Deferred.succeed(gates[3]!, undefined);
      const plan = yield* Fiber.join(sweep);

      assert.strictEqual(plan.status, "planned");
      assert.deepEqual(
        started.sort((left, right) => left - right),
        [0, 1, 2, 3],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("fails closed when any physical inventory is unavailable", () =>
    Effect.gen(function* () {
      const managed = managedWorktrees({
        list: (hostId) =>
          Effect.fail({
            _tag: "ManagedWorktreeRuntimeError",
            operation: "list",
            hostId,
            cause: new Error("offline"),
          } as ManagedWorktreeRuntimeError),
      });
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managed,
      });

      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "skipped");
      if (plan.status === "skipped") assert.strictEqual(plan.reason, "metadata-incomplete");

      yield* Scope.close(scope, Exit.void);
    }),
  );

  const agentOwnedEntries = () =>
    ["nodex:thread:agent", null, null].map((ownerThreadId, index) => ({
      worktreeGitRoot: `/managed/${String(index).padStart(4, "0")}/repository`,
      repositoryPath: "/repositories/repository",
      createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
      ownerThreadId,
      ownerReadFailed: false,
    }));

  it.effect("keeps a working Agent chat's worktree like a native Thread's", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managedWorktrees({
          list: () => Effect.succeed({ entries: agentOwnedEntries() }),
          remove: (input) =>
            Effect.sync(() => {
              removed.push(input.worktreeGitRoot);
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            }),
        }),
        agentChats: {
          consumers: (owners) =>
            Effect.succeed(
              owners.map((owner) => ({
                threadId: owner.ownerThreadId,
                projectId: "project",
                sessionId: "session",
                executionHostId: owner.hostId,
                cwd: owner.worktreeGitRoot,
                managedWorktreePath: owner.worktreeGitRoot,
                runtimeWorkspaceRoots: [],
                archived: false,
                pinnedOrder: null,
                statusType: "active" as const,
                statusActiveFlags: [],
                createdAt: 1,
                updatedAt: 1,
                linkedAt: "2026-08-13T00:00:00.000Z",
                title: "Agent chat",
              })),
            ),
          location: () => Effect.die("unused"),
          archive: () => Effect.die("unused"),
          resumeAfterRestore: () => Effect.die("unused"),
        },
      });

      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "planned");
      assert.deepEqual(
        plan.status === "planned"
          ? plan.items.find((item) => item.ownerThreadId === "nodex:thread:agent")
              ?.protectionReasons
          : [],
        ["in-progress"],
      );
      assert.deepEqual(removed, ["/managed/0001/repository"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("cleans up nothing until Agent execution can describe the chats owning worktrees", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        managedWorktrees: managedWorktrees({
          list: () => Effect.succeed({ entries: agentOwnedEntries() }),
          remove: (input) =>
            Effect.sync(() => {
              removed.push(input.worktreeGitRoot);
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            }),
        }),
      });

      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "skipped");
      assert.deepEqual(removed, []);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("protects idle Page Workspaces independently of physical owner metadata", () =>
    Effect.gen(function* () {
      const roots = ["/managed/abcd/page", "/managed/bcde/old", "/managed/cdef/new"];
      const removed: string[] = [];
      const { runtime, scope } = yield* buildRuntime({
        settings: () => ({ ...disabledSettings, autoDeleteEnabled: true }),
        executionHosts: executionHosts(["local"]),
        pageWorkspacePaths: Effect.succeed([roots[0]!]),
        managedWorktrees: managedWorktrees({
          list: () =>
            Effect.succeed({
              entries: roots.map((worktreeGitRoot, index) => ({
                worktreeGitRoot,
                repositoryPath: "/repo",
                createdAtMs: Date.parse("2026-08-13T00:00:00.000Z") + index,
                ownerThreadId: null,
                ownerReadFailed: false,
              })),
            }),
          remove: (input) =>
            Effect.sync(() => {
              removed.push(input.worktreeGitRoot);
              return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
            }),
        }),
      });
      yield* TestClock.setTime(Date.parse("2026-08-14T00:00:00.000Z"));
      const plan = yield* runtime.run;
      assert.strictEqual(plan.status, "planned");
      assert.deepEqual(removed, [roots[1]]);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});

describe("WorkspaceTextSearch", () => {
  const TestClock = TestClockWorkspaceTextSearch;
  // Test the real process boundary on the test host, independently of macOS app packaging.
  const rgDirectory = path.dirname(rgPath);
  const request = (
    roots: readonly string[],
    options: Partial<WorkspaceTextSearchRequest> = {},
  ): WorkspaceTextSearchRequest => ({
    requestId: "f3ebc134-7b2b-4c8d-8758-01e7b2a87065",
    hostId: "local",
    roots,
    query: "needle",
    ...options,
  });
  const temp = Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-text-search-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const runtimeLayer = (
    directory = rgDirectory,
    environmentPath = process.env.PATH,
    environment: Record<string, string> = {},
  ) =>
    platformLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          mainConfigLayer({
            platform: process.platform,
            environmentPath: environmentPath ?? null,
            environment,
          }),
          Layer.succeed(RipgrepExecutionRuntime, {
            resolve: Effect.succeed(
              path.join(directory, process.platform === "win32" ? "rg.exe" : "rg"),
            ),
          }),
        ),
      ),
    );

  async function nativeSearchFixture(root: string, code: string): Promise<Record<string, string>> {
    const executable = path.join(root, process.platform === "win32" ? "rg.exe" : "rg");
    const script = path.join(root, "fixture.cjs");
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o700);
    await writeFile(script, code);
    return { NODE_OPTIONS: `--require ${JSON.stringify(script)}`, ELECTRON_RUN_AS_NODE: "1" };
  }

  const collect = Effect.fnUntraced(function* (
    host: WorkspaceTextSearchHost,
    input: WorkspaceTextSearchRequest,
  ) {
    const events: WorkspaceTextSearchEvent[] = [];
    yield* searchWorkspaceTextOnHost(host, input, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    return events;
  });

  it.effect(
    "searches real hidden workspace text with literal smart case, masks, exclusions and UTF-16 locations",
    () =>
      Effect.gen(function* () {
        const root = yield* temp;
        yield* Effect.promise(async () => {
          await mkdir(path.join(root, "node_modules"));
          await writeFile(path.join(root, "node_modules", "dependency.ts"), "needle\n");
          await writeFile(path.join(root, ".hidden.ts"), "😀 Needle [x]\nneedle [x]\n");
          await writeFile(path.join(root, "other.txt"), "needle [x]\n");
          await writeFile(path.join(root, "excluded.ts"), "needle [x]\n");
        });
        const platform = yield* WorkspaceTextSearchPlatform;
        const host = yield* platform.open({ kind: "local", roots: [root] });
        const events = yield* collect(
          host,
          request([root], { query: "needle [x]", fileMask: "*.ts,!excluded.ts" }),
        );
        const matches = events.filter((event) => event.type === "match");
        assert.deepEqual(
          matches.map((event) => [event.match.relativePath, event.match.line, event.match.column]),
          [
            [".hidden.ts", 1, 4],
            [".hidden.ts", 2, 1],
          ],
        );
        assert.deepEqual(matches[0]?.match.matchRanges, [{ start: 3, end: 13 }]);
        assert.deepEqual(events.at(-1), {
          requestId: request([]).requestId,
          type: "done",
          limited: false,
        });
        const sensitive = yield* collect(
          host,
          request([root], { query: "Needle", fileMask: "*.ts" }),
        );
        assert.equal(sensitive.filter((event) => event.type === "match").length, 1);
      }).pipe(Effect.scoped, Effect.provide(runtimeLayer())),
  );

  it.effect.each([false, true])(
    "keeps dot-ignore, Git-ignore and explicit mask precedence with priority search %s",
    (prioritizeRecent) =>
      Effect.gen(function* () {
        const root = yield* temp;
        yield* Effect.promise(async () => {
          await Promise.all(
            [".git", "recent", "node_modules"].map((directory) =>
              mkdir(path.join(root, directory)),
            ),
          );
          const files = {
            ".ignore": "dot-ignored.ts\n",
            ".rgignore": "rg-ignored.ts\n",
            ".gitignore": "git-ignored.ts\n",
            "visible.ts": "needle\n",
            "recent/dot-ignored.ts": "needle\n",
            "recent/rg-ignored.ts": "needle\n",
            "recent/git-ignored.ts": "needle\n",
            "recent/mask-excluded.ts": "needle\n",
            "node_modules/dependency.ts": "needle\n",
          };
          await Promise.all(
            Object.entries(files).map(([file, content]) =>
              writeFile(path.join(root, file), content),
            ),
          );
        });
        const platform = yield* WorkspaceTextSearchPlatform;
        const host = yield* platform.open({ kind: "local", roots: [root] });
        const priorityFolders = prioritizeRecent ? [path.join(root, "recent")] : [];
        const unfiltered = yield* collect(host, request([root], { priorityFolders }));
        assert.deepEqual(
          unfiltered
            .filter((event) => event.type === "match")
            .map((event) => event.match.relativePath)
            .sort(),
          [
            "recent/dot-ignored.ts",
            "recent/mask-excluded.ts",
            "recent/rg-ignored.ts",
            "visible.ts",
          ],
        );
        const filtered = yield* collect(
          host,
          request([root], { priorityFolders, fileMask: "*.ts,!mask-excluded.ts" }),
        );
        assert.deepEqual(
          filtered
            .filter((event) => event.type === "match")
            .map((event) => event.match.relativePath)
            .sort(),
          ["recent/dot-ignored.ts", "recent/git-ignored.ts", "recent/rg-ignored.ts", "visible.ts"],
        );
      }).pipe(Effect.scoped, Effect.provide(runtimeLayer())),
  );

  it.effect(
    "searches priority folders first from the same root and stops at 100 matching lines across all roots",
    () =>
      Effect.gen(function* () {
        const root = yield* temp;
        yield* Effect.promise(async () => {
          await mkdir(path.join(root, "recent"));
          await writeFile(path.join(root, "recent", "active.ts"), "needle\n");
          await writeFile(path.join(root, "large.ts"), "needle\n".repeat(150));
        });
        const platform = yield* WorkspaceTextSearchPlatform;
        const host = yield* platform.open({ kind: "local", roots: [root] });
        const events = yield* collect(
          host,
          request([root, "/must-not-be-read"], { priorityFolders: [path.join(root, "recent")] }),
        );
        const matches = events.filter((event) => event.type === "match");
        assert.equal(matches.length, 100);
        assert.equal(matches[0]?.match.relativePath, "recent/active.ts");
        assert.deepEqual(events.at(-1), {
          requestId: request([]).requestId,
          type: "done",
          limited: true,
        });
      }).pipe(Effect.scoped, Effect.provide(runtimeLayer())),
  );

  it.effect("interrupting a live search terminates its process without a terminal result", () =>
    Effect.gen(function* () {
      const root = yield* temp;
      const started = yield* Deferred.make<number>();
      const environment = yield* Effect.promise(() =>
        nativeSearchFixture(root, "console.log(process.pid);setInterval(()=>{},1000);"),
      );
      yield* Effect.gen(function* () {
        const platform = yield* WorkspaceTextSearchPlatform;
        const host = yield* platform.open({ kind: "local", roots: [root] });
        const fiber = yield* host
          .search(root, [], (line) => Deferred.succeed(started, Number(line)).pipe(Effect.as(true)))
          .pipe(Effect.forkChild);
        const pid = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        assert.throws(() => process.kill(pid, 0), /ESRCH/u);
        // Exit observation alone can precede Windows releasing the executable image.
        yield* Effect.promise(() =>
          rm(path.join(root, process.platform === "win32" ? "rg.exe" : "rg")),
        );
      }).pipe(Effect.provide(runtimeLayer(root, process.env.PATH, environment)));
    }).pipe(Effect.scoped),
  );

  it.effect("times out a stalled search and terminates its child process", () =>
    Effect.gen(function* () {
      const root = yield* temp;
      const started = yield* Deferred.make<number>();
      const environment = yield* Effect.promise(() =>
        nativeSearchFixture(root, "console.log(process.pid);setInterval(()=>{},1000);"),
      );
      yield* Effect.gen(function* () {
        const platform = yield* WorkspaceTextSearchPlatform;
        const host = yield* platform.open({ kind: "local", roots: [root] });
        const fiber = yield* host
          .search(root, [], (line) => Deferred.succeed(started, Number(line)).pipe(Effect.as(true)))
          .pipe(Effect.result, Effect.forkChild);
        const pid = yield* Deferred.await(started);
        yield* TestClock.adjust(30_001);
        const result = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.message, "File search timed out");
        assert.throws(() => process.kill(pid, 0), /ESRCH/u);
        yield* Effect.promise(() =>
          rm(path.join(root, process.platform === "win32" ? "rg.exe" : "rg")),
        );
      }).pipe(Effect.provide(runtimeLayer(root, process.env.PATH, environment)));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "bounds complete stderr output even after its retained diagnostic preview is full",
    () =>
      Effect.gen(function* () {
        const root = yield* temp;
        const started = yield* Deferred.make<number>();
        const environment = yield* Effect.promise(() =>
          nativeSearchFixture(
            root,
            "console.log(process.pid); const chunk=Buffer.alloc(1024*1024,65); let count=0; function pump(){ while(count++<129){ if(!process.stderr.write(chunk)) return process.stderr.once('drain',pump); } } pump(); setInterval(()=>{},1000);",
          ),
        );
        yield* Effect.gen(function* () {
          const platform = yield* WorkspaceTextSearchPlatform;
          const host = yield* platform.open({ kind: "local", roots: [root] });
          const fiber = yield* host
            .search(root, [], (line) =>
              Deferred.succeed(started, Number(line)).pipe(Effect.as(true)),
            )
            .pipe(Effect.result, Effect.forkChild);
          const pid = yield* Deferred.await(started);
          const result = yield* Fiber.join(fiber);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.equal(result.failure.message, "File search exceeded its output limit");
          assert.throws(() => process.kill(pid, 0), /ESRCH/u);
        }).pipe(Effect.provide(runtimeLayer(root, process.env.PATH, environment)));
      }).pipe(Effect.scoped),
  );

  // The loopback SSH fixture executes a remote POSIX shell locally; native local search runs above on every host.
  it.effect.skipIf(process.platform === "win32")(
    "connected search excludes a project-controlled PATH executable and follows the trusted executable",
    () =>
      Effect.gen(function* () {
        const directory = yield* temp;
        const root = path.join(directory, "project");
        const trusted = path.join(directory, "trusted");
        const client = path.join(directory, "client");
        yield* Effect.promise(async () => {
          await mkdir(root);
          await mkdir(trusted);
          await mkdir(client);
          await writeFile(path.join(root, "text.txt"), "needle\n");
          await writeFile(path.join(root, "rg"), "#!/bin/sh\nexit 93\n");
          await chmod(path.join(root, "rg"), 0o700);
          await symlink(path.join(rgDirectory, "rg"), path.join(trusted, "untrusted-link"));
          const { copyFile } = await import("node:fs/promises");
          await copyFile(path.join(rgDirectory, "rg"), path.join(trusted, "rg"));
          await chmod(path.join(trusted, "rg"), 0o700);
          await writeFile(
            path.join(client, "ssh"),
            '#!/bin/sh\nfor arg do command=$arg; done\nexec /bin/sh -c "$command"\n',
          );
          await chmod(path.join(client, "ssh"), 0o700);
        });
        yield* Effect.gen(function* () {
          const platform = yield* WorkspaceTextSearchPlatform;
          const host = yield* platform.open({
            kind: "ssh",
            roots: [root],
            codexHome: path.join(directory, "codex"),
            config: {
              id: "ssh:test",
              kind: "ssh",
              displayName: "Test",
              sshAlias: "test",
              port: null,
              managedRoot: root,
              repositoryRoots: [root],
              codexBinary: null,
              codexHome: null,
              enabled: true,
            },
          });
          assert.equal(
            host.executable,
            yield* Effect.promise(() => realpath(path.join(trusted, "rg"))),
          );
          const events = yield* collect(host, request([root]));
          assert.equal(events.filter((event) => event.type === "match").length, 1);
        }).pipe(
          Effect.provide(
            runtimeLayer(rgDirectory, [client, root, trusted, "/usr/bin", "/bin"].join(":")),
          ),
        );
      }).pipe(Effect.scoped),
  );
});

describe("ManagedWorktreeHandoff", () => {
  const entry: CodexThreadHandoffJournalEntry = {
    schemaVersion: 1,
    operationId: "move",
    threadId: "thread",
    phase: "preparing-destination",
    source: {
      hostId: "local",
      cwd: "/repo",
      workspaceRoots: ["/repo"],
      managedWorktreePath: null,
      projectId: "project",
      projectlessOutputDirectory: null,
      projectlessWorkspaceBrowserRoot: null,
    },
    requestedDestinationHostId: null,
    destination: null,
    prepared: null,
    runtimeSwitched: false,
    coreCommitted: false,
    followUpPrompt: null,
    followUpDispatchStarted: false,
    warnings: [],
    lastError: null,
    failedPhase: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };

  const makeFixture = (
    options: {
      failWorker?: boolean;
      preparationRestored?: boolean;
      rollbackWarnings?: readonly string[];
      noNativeThread?: boolean;
      directories?: readonly string[];
      availability?: Effect.Success<
        ReturnType<ManagedWorktreeRuntime["Service"]["inspect"]>
      >["availability"];
    } = {},
  ) =>
    Effect.gen(function* () {
      const newborns = new Set<string>();
      const requests: CodexWorktreeWorkerRequest[] = [];
      const descriptor = {
        hostId: "local",
        displayName: "Local",
        kind: "local" as const,
        nodexHome: "/nodex",
        codexHome: "/codex",
        managedRoot: "/managed",
        handoffStagingRoot: "/handoffs",
        repositoryRoots: ["/repo"],
        capabilities: ["git-root", "prepare-handoff", "rollback-handoff"] as const,
        supportsFileTransfer: true,
      };
      const host: ExecutionHost = {
        descriptor,
        transfer: null,
        request: ((request: CodexWorktreeWorkerRequest) =>
          Effect.gen(function* () {
            requests.push(request);
            if (request.operation === "git-root") return { root: "/repo" };
            if (options.failWorker)
              return yield* new ExecutionHostRuntimeError({
                operation: request.operation,
                hostId: "local",
                cause:
                  options.preparationRestored !== undefined
                    ? new WorktreeWorkerError({
                        operation: "worker-result",
                        message: "Source restored",
                        cause: new Error("Destination dirty"),
                        preparationRestored: options.preparationRestored,
                      })
                    : new Error("Worker reply lost"),
              });
            if (request.operation === "rollback-handoff")
              return { rolledBack: true, warnings: options.rollbackWarnings ?? [] };
            if (request.operation !== "prepare-handoff" || !request.input.allocatedWorktreePath)
              return yield* Effect.die("Unexpected worker request");
            const destination = request.input.allocatedWorktreePath;
            return {
              direction: "to-worktree",
              sourceBranch: "task",
              localCheckoutBranch: "main",
              destinationBranch: "task",
              sourceWorkspaceRoot: "/repo",
              destinationWorkspaceRoot: destination,
              destinationGitRoot: destination,
              managedWorktreePath: destination,
              createdWorktree: true,
              warnings: [],
            };
          })) as ExecutionHost["request"],
      };
      const activeSshHosts = yield* SubscriptionRef.make<
        ReadonlyMap<string, CodexSshExecutionHostConfig>
      >(new Map());
      const scope = yield* Scope.Scope;
      const context = yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                FileSystem.FileSystem,
                FileSystem.makeNoop({
                  stat: (directory) =>
                    (options.directories ?? ["/repo"]).includes(directory)
                      ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
                      : Effect.fail(
                          systemError({ _tag: "NotFound", module: "FileSystem", method: "stat" }),
                        ),
                }),
              ),
              Layer.succeed(ProjectWorkspace, {
                getProject: () =>
                  Effect.succeed({
                    sources: [{ kind: "directory", path: "/repo", order: 0 }],
                  } as Project),
              } as unknown as ProjectWorkspace["Service"]),
              Layer.succeed(CodexGateway, {} as CodexGateway["Service"]),
              Layer.succeed(
                CodexAppServerCapabilities,
                {} as CodexAppServerCapabilities["Service"],
              ),
              Layer.succeed(CoreModules, {
                workspace: {
                  read: (input: { kind: string }) =>
                    input.kind === "thread" && options.noNativeThread
                      ? Effect.die("Runtime metadata must not read a native Core Thread")
                      : Effect.succeed({
                          value:
                            input.kind === "project"
                              ? {
                                  kind: "project",
                                  project: {
                                    sources: [
                                      { kind: "directory" as const, path: "/repo", order: 0 },
                                    ],
                                  },
                                }
                              : {
                                  kind: "thread",
                                  thread: { thread_name: "Task", thread_preview: "" },
                                },
                        }),
                },
              } as unknown as CoreModules["Service"]),
              Layer.succeed(CrossHostThreadHandoff, {
                prepare: () => Effect.die("Unexpected cross-host move"),
                cleanup: () => Effect.succeed([]),
              }),
              Layer.succeed(ExecutionHostRuntime, {
                activeSshHosts,
                hosts: () => Effect.succeed([descriptor]),
                get: () => Effect.succeed(host),
                resolve: () => Effect.succeed(host),
                updateLocalManagedRoot: () => Effect.void,
                settings: Effect.die("Unused settings"),
                updateSettings: () => Effect.die("Unused settings"),
                reconcile: () => Effect.void,
              }),
              Layer.succeed(ManagedWorktreeRetentionRuntime, {
                request: Effect.void,
                run: Effect.die("Unused retention"),
              }),
              Layer.succeed(ManagedWorktreeRuntime, {
                registerNewborn: ({ worktreeGitRoot }) =>
                  Effect.sync(() => {
                    newborns.add(worktreeGitRoot);
                  }),
                releaseNewborn: ({ worktreeGitRoot }) =>
                  Effect.sync(() => {
                    newborns.delete(worktreeGitRoot);
                  }),
                newborns: Effect.succeed([]),
                isNewborn: ({ worktreeGitRoot }) =>
                  Effect.sync(() => newborns.has(worktreeGitRoot)),
                list: () => Effect.die("Unused inventory"),
                remove: () => Effect.die("Unused removal"),
                inspect: (input, settings) =>
                  Effect.sync(() => {
                    assert.isTrue(settings?.fresh);
                    assert.strictEqual(input.worktreeGitRoot, "/old-worktrees/abcd/repo");
                    assert.isDefined(options.availability);
                    return { availability: options.availability! };
                  }),
                restore: () => Effect.die("Unused restore"),
                setOwner: () => Effect.die("Unexpected worktree owner mutation"),
              }),
            ),
          ),
        ),
        scope,
      );
      return { handoff: Context.get(context, ManagedWorktreeHandoff), newborns, requests };
    });

  it.effect("waits for the durable allocation checkpoint before the worker can move files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const checkpoint = yield* Deferred.make<string>();
        const persisted = yield* Deferred.make<void>();
        const preparing = yield* fixture.handoff
          .prepare(entry, "transfer", (progress) =>
            progress.allocatedDestination
              ? Deferred.succeed(checkpoint, progress.allocatedDestination.worktreeGitRoot).pipe(
                  Effect.andThen(Deferred.await(persisted)),
                  Effect.asVoid,
                )
              : Effect.void,
          )
          .pipe(Effect.forkChild);
        const allocated = yield* Deferred.await(checkpoint);
        assert.match(allocated, /^\/managed\/[0-9a-f]{12}\/repo$/u);
        assert.deepEqual(
          fixture.requests.map((request) => request.operation),
          ["git-root"],
        );
        assert.strictEqual(fixture.newborns.size, 0);
        yield* Deferred.succeed(persisted, undefined);
        const prepared = yield* Fiber.join(preparing);
        assert.strictEqual(prepared.destination.managedWorktreePath, allocated);
        assert.isTrue(fixture.newborns.has(allocated));
        assert.strictEqual(fixture.requests[1]?.operation, "prepare-handoff");
      }),
    ),
  );

  it.effect("uses the journal's Runtime title without acquiring native Thread metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ noNativeThread: true });
        yield* f.handoff.prepare(
          { ...entry, threadId: "runtime-root", threadTitle: "Runtime conversation" },
          "transfer",
        );
        assert.equal(f.requests[1]?.operation, "prepare-handoff");
        if (f.requests[1]?.operation === "prepare-handoff")
          assert.equal(f.requests[1].input.threadTitle, "Runtime conversation");
      }),
    ),
  );

  it.effect("a failed allocation checkpoint never dispatches a mutating worker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const result = yield* fixture.handoff
          .prepare(entry, "transfer", () =>
            Effect.fail(
              new CodexThreadHandoffJournalStorageError({
                operation: "persist",
                cause: new Error("Journal is read-only"),
              }),
            ),
          )
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.isTrue(result.failure.preparationRestored);
        assert.deepEqual(
          fixture.requests.map((request) => request.operation),
          ["git-root"],
        );
        assert.strictEqual(fixture.newborns.size, 0);
      }),
    ),
  );

  it.effect("a lost worker reply retains its allocation and never claims source restoration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ failWorker: true });
        const result = yield* fixture.handoff.prepare(entry, "transfer").pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.isUndefined(result.failure.preparationRestored);
        assert.strictEqual(fixture.newborns.size, 1);
      }),
    ),
  );

  it.effect("accepts only the worker's explicit verified restoration proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const preparationRestored of [true, false]) {
          const fixture = yield* makeFixture({ failWorker: true, preparationRestored });
          const result = yield* fixture.handoff.prepare(entry, "transfer").pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.strictEqual(
              result.failure.preparationRestored,
              preparationRestored ? true : undefined,
            );
        }
      }),
    ),
  );

  it.effect("failed or incomplete Git rollback retains newborn protection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* makeFixture();
        const preparation = yield* created.handoff.prepare(entry, "transfer");
        const { prepared } = preparation;
        if (prepared.direction !== "to-worktree") throw new Error("Expected a prepared worktree");
        for (const options of [
          { failWorker: true },
          { rollbackWarnings: ["Source restoration incomplete"] },
        ]) {
          const fixture = yield* makeFixture(options);
          fixture.newborns.add(prepared.managedWorktreePath);
          yield* fixture.handoff.rollback(entry.threadId, preparation).pipe(Effect.result);
          assert.isTrue(fixture.newborns.has(prepared.managedWorktreePath));
        }
      }),
    ),
  );

  const missingWorktree = {
    ...entry,
    source: {
      ...entry.source,
      cwd: "/old-worktrees/abcd/repo/packages/app",
      workspaceRoots: [
        "/old-worktrees/abcd/repo/packages/app",
        "/secondary/z",
        "/old-worktrees/abcd/repo",
        "/secondary/missing",
        "/secondary/a",
      ],
      managedWorktreePath: "/old-worktrees/abcd/repo",
    },
  };

  it.effect("relocates from a restorable worktree without touching Git or worktree ownership", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          directories: ["/repo", "/repo/packages/app", "/secondary/z", "/secondary/a"],
          availability: {
            state: "restorable",
            repositoryPath: "/repo",
            snapshotRef: "refs/codex/snapshots/old",
          },
        });
        const progress: string[] = [];
        const prepared = yield* fixture.handoff.prepare(missingWorktree, "relocate", (step) =>
          Effect.sync(() => void progress.push(`${step.phase}:${step.status}`)),
        );
        assert.strictEqual(prepared.prepared.direction, "relocate");
        assert.deepEqual(prepared.destination, {
          ...missingWorktree.source,
          cwd: "/repo/packages/app",
          workspaceRoots: ["/repo", "/secondary/z", "/secondary/a"],
          managedWorktreePath: null,
        });
        yield* fixture.handoff.transferOwner(entry.threadId, prepared);
        assert.deepEqual(yield* fixture.handoff.rollback(entry.threadId, prepared), []);
        assert.deepEqual(yield* fixture.handoff.cleanup(entry.threadId, prepared, "committed"), []);
        assert.deepEqual(progress, [
          "confirm-source-missing:running",
          "confirm-source-missing:success",
        ]);
        assert.deepEqual(fixture.requests, []);
        assert.isEmpty(fixture.newborns);
      }),
    ),
  );

  it.effect(
    "uses the checkout root when the relative folder is absent and rejects unverified moves",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fallback = yield* makeFixture({
            directories: ["/repo"],
            availability: { state: "gone", worktree: true },
          });
          assert.strictEqual(
            (yield* fallback.handoff.prepare(missingWorktree, "relocate")).destination.cwd,
            "/repo",
          );

          const noCheckout = yield* makeFixture({
            directories: [],
            availability: { state: "gone", worktree: true },
          });
          const noCheckoutError = yield* Effect.flip(
            noCheckout.handoff.prepare(missingWorktree, "relocate"),
          );
          assert.isTrue(noCheckoutError.preparationRestored);
          assert.include(String(noCheckoutError.cause), "no available local folder");
          assert.deepEqual(noCheckout.requests, []);

          const unavailable = yield* makeFixture({
            directories: ["/repo"],
            availability: {
              state: "unavailable",
              reason: "inspection-failed",
              message: "Repository is offline",
            },
          });
          const unavailableError = yield* Effect.flip(
            unavailable.handoff.prepare(missingWorktree, "relocate"),
          );
          assert.isTrue(unavailableError.preparationRestored);
          assert.include(String(unavailableError.cause), "Repository is offline");
          assert.deepEqual(unavailable.requests, []);
        }),
      ),
  );

  it.effect("checks the checkout separately from its nested working directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = missingWorktree.source.managedWorktreePath;
        const move = { ...missingWorktree, requestedDestination: "local" as const };
        const missing = yield* makeFixture({ directories: ["/repo"] });
        const nestedMissing = yield* makeFixture({
          directories: ["/repo", checkout],
        });
        const restored = yield* makeFixture({
          directories: ["/repo", checkout, move.source.cwd],
        });
        assert.equal(
          yield* missing.handoff.selectStrategy({ ...move, expectedSource: "missing" }),
          "relocate",
        );
        assert.equal(
          yield* restored.handoff.selectStrategy({ ...move, expectedSource: "present" }),
          "transfer",
        );
        for (const [fixture, expectedSource] of [
          [restored, "missing"],
          [missing, "present"],
          [nestedMissing, "missing"],
        ] as const) {
          const stale = yield* Effect.flip(
            fixture.handoff.selectStrategy({ ...move, expectedSource }),
          );
          assert.include(
            String(stale.cause),
            "Chat execution location changed. Reopen the location menu.",
          );
          assert.isEmpty(fixture.requests);
        }
        const failure = yield* Effect.flip(nestedMissing.handoff.selectStrategy(move));
        assert.include(String(failure.cause), "working directory no longer exists");
        const staleRelocation = yield* Effect.flip(nestedMissing.handoff.prepare(move, "relocate"));
        assert.include(String(staleRelocation.cause), "Chat execution location changed");
        assert.isEmpty(nestedMissing.requests);
      }),
    ),
  );
});
