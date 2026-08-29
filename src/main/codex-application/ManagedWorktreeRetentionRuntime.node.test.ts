import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import type { ManagedWorktreeSettings } from "../../shared/types";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { ManagedWorktreeConfiguration } from "./ExecutionHostConfiguration";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime, ManagedWorktreeRuntimeError } from "./ManagedWorktreeRuntime";
import {
  ManagedWorktreeRetentionRuntime,
  live as managedWorktreeRetentionRuntimeLive,
} from "./ManagedWorktreeRetentionRuntime";

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
  } = {},
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      managedWorktreeRetentionRuntimeLive({}).pipe(
        Layer.provide(
          Layer.mergeAll(
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
