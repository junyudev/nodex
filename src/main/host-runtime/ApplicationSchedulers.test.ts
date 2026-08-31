import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import type { CodexScheduledAutomation } from "../../shared/types";
import {
  AutomationApplication,
  type AutomationDefinitions,
  type AutomationReminders,
  type AutomationRuns,
} from "../automation-application/AutomationApplication";
import {
  AutomationExecution,
  AutomationExecutionError,
} from "../automation-application/AutomationExecution";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority, type CoreAuthorityState } from "../core-runtime/CoreAuthority";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import {
  StoreAdministration,
  StoreAdministrationError,
  type StoreMaintenanceInput,
} from "../core-runtime/StoreAdministration";
import {
  ElectronDesktop,
  type ElectronNotificationInput,
} from "../platform/electron/ElectronDesktop";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";
import {
  CodexScheduledAutomationRetryError,
  type CodexScheduledAutomationRunContext,
} from "./ScheduledAutomationPolicy";
import {
  ReminderSchedulerRuntime,
  live as reminderSchedulerLive,
} from "./ReminderSchedulerRuntime";
import {
  ScheduledAutomationRuntime,
  live as scheduledAutomationLive,
} from "./ScheduledAutomationRuntime";
import {
  StoreAdministrationSchedulerRuntime,
  live as storeAdministrationSchedulerLive,
  type StoreAdministrationSchedulerTiming,
} from "./StoreAdministrationSchedulerRuntime";

const reminderClaim = {
  leaseId: "reminder-lease:1",
  projectId: "project:one",
  pageId: "page:one",
  occurrenceStart: Date.parse("2026-07-20T01:00:00.000Z"),
  reminderOffsetMinutes: 30,
  dueAt: Date.parse("2026-07-20T00:30:00.000Z"),
  title: "Planning session",
  attempt: 1,
  expiresAt: Date.parse("2026-07-20T00:32:00.000Z"),
};

const automationDefinition = (
  id: string,
  kind: "cron" | "heartbeat" = "cron",
): CodexScheduledAutomation => ({
  id,
  definitionRevision: 1,
  kind,
  status: "ACTIVE",
  targetThreadId: kind === "heartbeat" ? "thread-follow-up" : null,
  name: id,
  prompt: "Run.",
  rrule: "FREQ=MINUTELY;INTERVAL=5",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  backendBinding: { kind: "codex" },
  cwds: kind === "heartbeat" ? [] : ["/repo/project"],
  executionEnvironment: kind === "heartbeat" ? "local" : "worktree",
  localEnvironmentConfigPath: null,
  nextRunAt: 100,
  lastRunAt: null,
  createdAt: 1,
  updatedAt: 1,
});

const automationClaim = (id: string) => ({
  leaseId: `lease:${id}`,
  scheduledFor: 100,
  attempt: 1,
  expiresAt: 200,
  definition: automationDefinition(id),
});

const defaultAutomation = (input?: {
  readonly definitions?: Partial<AutomationDefinitions>;
  readonly reminders?: Partial<AutomationReminders>;
  readonly runs?: Partial<AutomationRuns>;
}): AutomationApplication["Service"] =>
  AutomationApplication.of({
    definitions: {
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      dispatchNow: () => Effect.die("unused"),
      reschedule: () => Effect.die("unused"),
      planDue: Effect.succeed({
        dueNow: true,
        nextWakeAt: 100,
        workToken: "definitions:due",
      }),
      claimDue: () => Effect.succeed([]),
      completeLease: () => Effect.void,
      failLease: () => Effect.void,
      ...input?.definitions,
    },
    runs: {
      settleInterrupted: Effect.succeed({ archivedPendingCount: 0, pendingReviewCount: 0 }),
      get: () => Effect.die("unused"),
      begin: () => Effect.die("unused"),
      replacePendingThread: () => Effect.die("unused"),
      setThreadTitle: () => Effect.die("unused"),
      completeForReview: () => Effect.die("unused"),
      setInboxItem: () => Effect.die("unused"),
      accept: () => Effect.die("unused"),
      archive: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      unarchive: () => Effect.die("unused"),
      ...input?.runs,
    },
    inbox: {} as AutomationApplication["Service"]["inbox"],
    occurrences: {} as AutomationApplication["Service"]["occurrences"],
    reminders: {
      snooze: () => Effect.void,
      planDue: Effect.succeed({ dueNow: true, nextWakeAt: 100, workToken: "reminders:due" }),
      claimDue: () => Effect.succeed([]),
      completeLease: () => Effect.void,
      failLease: () => Effect.void,
      ...input?.reminders,
    },
  });

const defaultAdministration = (): StoreAdministration["Service"] =>
  StoreAdministration.of({
    listBackups: Effect.succeed([]),
    backupCapacity: Effect.succeed({
      availableBytes: 1_000_000,
      estimatedNextBackupBytes: 120,
      safetyMarginBytes: 512,
      totalReadyBytes: 0,
      manualReadyBytes: 0,
      automaticReadyBytes: 0,
      canCreate: true,
    }),
    snapshotStorageOptimization: Effect.succeed({
      optimizing: false,
      commitHead: 0,
      replayFloor: 0,
      pendingCommitMetadata: 0,
      pendingReceiptMetadata: 0,
      retainedCommitCount: 0,
      retainedDeliveryBytes: 0,
      retainedReceiptCount: 0,
      retainedReceiptBytes: 0,
      receiptFloorAt: null,
      lastPrunedCommit: 0,
      freelistPages: 0,
      reclaimableBytes: 0,
    }),
    createBackup: () =>
      Effect.succeed({
        version: 2,
        id: "backup:auto",
        createdAt: "2026-07-19T20:00:00.000Z",
        trigger: "auto",
        label: null,
        includesAssets: true,
        dbBytes: 100,
        assetsBytes: 20,
        totalBytes: 120,
      }),
    startBackup: () => Effect.die("unused"),
    backupJob: () => Effect.succeed(null),
    cancelBackup: () => Effect.die("unused"),
    deleteBackup: () => Effect.die("unused"),
    restoreBackup: () => Effect.die("unused"),
    pruneBackups: () => Effect.void,
    planMaintenance: (input) =>
      Effect.succeed({
        dueTasks: input.tasks,
        nextWakeAt: null,
        workToken: `maintenance:${input.tasks.join(",")}`,
      }),
    runMaintenance: () => Effect.void,
  });

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });

const buildHarness = (input: {
  readonly automation?: AutomationApplication["Service"];
  readonly administration?: StoreAdministration["Service"];
  readonly executeScheduled?: (
    automation: CodexScheduledAutomation,
    context: CodexScheduledAutomationRunContext,
  ) => Effect.Effect<void, AutomationExecutionError>;
  readonly settled?: () => void;
  readonly readBlockRetentionCount?: () => number;
  readonly reminder?: {
    readonly intervalMs?: number;
    readonly maxPerTick?: number;
    readonly leaseDurationMs?: number;
    readonly retryDelayMs?: number;
  };
  readonly scheduled?: { readonly intervalMs?: number; readonly maxPerTick?: number };
  readonly storeTiming?: StoreAdministrationSchedulerTiming;
  readonly initialBackup?: {
    readonly autoEnabled: boolean;
    readonly intervalHours: number;
    readonly retentionCount: number;
    readonly retentionGiB: number;
  };
  readonly showNotification?: (notification: ElectronNotificationInput) => Effect.Effect<boolean>;
}) =>
  Effect.gen(function* () {
    const authorityState = yield* SubscriptionRef.make<CoreAuthorityState>({
      kind: "ready",
      generation: "generation-1",
    });
    const authority = CoreAuthority.of({
      identity: { profileId: "profile", libraryId: "library", storeEpoch: "epoch" },
      initialLaunch: {} as CoreAuthority["Service"]["initialLaunch"],
      state: authorityState,
      retry: Effect.void,
      requestRelaunch: Effect.void,
      failApplication: () => Effect.succeed(true),
    });
    const notifications: ElectronNotificationInput[] = [];
    let powerResume: Effect.Effect<void> | null = null;
    const desktop = ElectronDesktop.of({
      showNotification: (notification) => {
        notifications.push(notification);
        return input.showNotification?.(notification) ?? Effect.succeed(true);
      },
      onPowerEvent: (_event, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            powerResume = handler;
          }),
          () =>
            Effect.sync(() => {
              powerResume = null;
            }),
        ),
    } as ElectronDesktop["Service"]);
    const scope = yield* Scope.make();
    const automation = input.automation ?? defaultAutomation();
    const automationLayer = Layer.succeed(AutomationApplication, automation);
    const executionLayer = Layer.succeed(
      AutomationExecution,
      AutomationExecution.of({
        prepareDefinition: () => Effect.die("unused"),
        runNow: () => Effect.die("unused"),
        executeClaimed: input.executeScheduled ?? (() => Effect.void),
        resolveArchiveMessages: () => Effect.die("unused"),
      }),
    );
    const automationEventsLayer = Layer.succeed(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => {
          if (
            event.kind === "codex" &&
            event.value.type === "automationRunsUpdated" &&
            event.value.event.reason === "settle"
          ) {
            input.settled?.();
          }
        },
      }),
    );
    const platformLayer = Layer.mergeAll(
      automationLayer,
      Layer.succeed(CoreAuthority, authority),
      Layer.succeed(ElectronDesktop, desktop),
    );
    const reminderContext = yield* Layer.buildWithScope(
      reminderSchedulerLive(input.reminder ?? {}).pipe(Layer.provide(platformLayer)),
      scope,
    );
    const scheduledContext = yield* Layer.buildWithScope(
      scheduledAutomationLive(input.scheduled ?? {}).pipe(
        Layer.provide(
          Layer.mergeAll(
            automationLayer,
            executionLayer,
            automationEventsLayer,
            Layer.succeed(CoreAuthority, authority),
          ),
        ),
      ),
      scope,
    );
    const storeContext = yield* Layer.buildWithScope(
      storeAdministrationSchedulerLive({
        timing: input.storeTiming,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CoreAuthority, authority),
            Layer.succeed(StoreAdministration, input.administration ?? defaultAdministration()),
            Layer.succeed(
              ApplicationSettings,
              ApplicationSettings.of({
                snapshot: () =>
                  Effect.succeed({
                    backup: input.initialBackup ?? {
                      autoEnabled: false,
                      intervalHours: 24,
                      retentionCount: 5,
                      retentionGiB: 32,
                    },
                    history: {
                      retentionCount: (input.readBlockRetentionCount ?? (() => 100))(),
                      envOverrides: { retentionCount: false },
                    },
                  } as ApplicationSettingsSnapshot),
                update: () => Effect.die("unused"),
              }),
            ),
          ),
        ),
      ),
      scope,
    );
    return {
      authorityState,
      notifications,
      powerResume: () => powerResume,
      reminders: Context.get(reminderContext, ReminderSchedulerRuntime),
      scheduled: Context.get(scheduledContext, ScheduledAutomationRuntime),
      store: Context.get(storeContext, StoreAdministrationSchedulerRuntime),
      scope,
    };
  });

it.effect("delivers reminder leases and routes notification actions through scoped callbacks", () =>
  Effect.gen(function* () {
    const completed: string[] = [];
    const snoozes: number[] = [];
    let claims = 0;
    let opened = 0;
    const automation = defaultAutomation({
      reminders: {
        claimDue: () =>
          Effect.sync(() => {
            claims += 1;
            return claims <= 2 ? [reminderClaim] : [];
          }),
        completeLease: (leaseId) => Effect.sync(() => completed.push(leaseId)).pipe(Effect.asVoid),
        snooze: ({ snoozeMinutes }) =>
          Effect.sync(() => snoozes.push(snoozeMinutes)).pipe(Effect.asVoid),
      },
    });
    const harness = yield* buildHarness({ automation });

    yield* harness.reminders.activate({
      openReminder: () => {
        opened += 1;
      },
    });
    yield* waitUntil("initial reminder", () => harness.notifications.length === 1);
    assert.deepEqual(completed, ["reminder-lease:1"]);
    assert.deepEqual(harness.notifications[0]?.actions, ["Snooze 10m", "Snooze 1h"]);

    yield* harness.notifications[0]?.onClick ?? Effect.void;
    yield* harness.notifications[0]?.onAction?.(0) ?? Effect.void;
    yield* waitUntil("reminder snooze", () => snoozes.length === 1);
    assert.strictEqual(opened, 1);
    assert.deepEqual(snoozes, [10]);

    const powerResume = harness.powerResume();
    assert.isNotNull(powerResume);
    yield* powerResume ?? Effect.void;
    yield* waitUntil("resume reminder", () => harness.notifications.length === 2);
    yield* Scope.close(harness.scope, Exit.void);
    assert.isNull(harness.powerResume());
  }),
);

it.effect("keeps idle scheduler probes read-only", () =>
  Effect.gen(function* () {
    let definitionPlans = 0;
    let reminderPlans = 0;
    let claims = 0;
    const automation = defaultAutomation({
      definitions: {
        planDue: Effect.sync(() => {
          definitionPlans += 1;
          return { dueNow: false, nextWakeAt: null, workToken: null };
        }),
        claimDue: () => Effect.sync(() => void (claims += 1)).pipe(Effect.as([])),
      },
      reminders: {
        planDue: Effect.sync(() => {
          reminderPlans += 1;
          return { dueNow: false, nextWakeAt: null, workToken: null };
        }),
        claimDue: () => Effect.sync(() => void (claims += 1)).pipe(Effect.as([])),
      },
    });
    const harness = yield* buildHarness({
      automation,
      reminder: { intervalMs: 1 },
      scheduled: { intervalMs: 1 },
    });
    yield* harness.reminders.activate({ openReminder: () => undefined });
    yield* harness.scheduled.activate;
    yield* waitUntil("idle due-work probes", () => definitionPlans >= 1 && reminderPlans >= 1);
    assert.strictEqual(claims, 0);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("defers reminder claims when Core authority is lost during the claim", () =>
  Effect.gen(function* () {
    const failed: Array<{ leaseId: string; delay: number; reason: string }> = [];
    let resolveClaims: ((claims: (typeof reminderClaim)[]) => void) | null = null;
    const automation = defaultAutomation({
      reminders: {
        claimDue: () =>
          Effect.promise(
            () =>
              new Promise<(typeof reminderClaim)[]>((resolve) => {
                resolveClaims = resolve;
              }),
          ),
        failLease: (leaseId, delay, reason) =>
          Effect.sync(() => failed.push({ leaseId, delay: delay ?? 0, reason })).pipe(
            Effect.asVoid,
          ),
      },
    });
    const harness = yield* buildHarness({
      automation,
      reminder: { retryDelayMs: 9_000 },
    });
    yield* harness.reminders.activate({ openReminder: () => undefined });
    yield* waitUntil("reminder claim admission", () => resolveClaims !== null);

    yield* SubscriptionRef.set(harness.authorityState, {
      kind: "recovering",
      attempt: 1,
      previousGeneration: "generation-1",
    });
    const releaseClaims = resolveClaims as ((claims: (typeof reminderClaim)[]) => void) | null;
    releaseClaims?.([reminderClaim]);
    yield* waitUntil("reminder deferral", () => failed.length === 1);
    assert.deepEqual(failed, [
      { leaseId: "reminder-lease:1", delay: 9_000, reason: "core_authority_unavailable" },
    ]);
    assert.deepEqual(harness.notifications, []);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("settles scheduled claims once and preserves explicit retry intent", () =>
  Effect.gen(function* () {
    const completed: string[] = [];
    const failed: Array<{ leaseId: string; delay: number | null; reason: string }> = [];
    let claimCalls = 0;
    let settlementRuns = 0;
    const automation = defaultAutomation({
      runs: {
        settleInterrupted: Effect.succeed({ archivedPendingCount: 1, pendingReviewCount: 0 }),
      },
      definitions: {
        claimDue: () =>
          Effect.sync(() => {
            claimCalls += 1;
            return claimCalls > 1 ? [] : ["complete", "retry", "deferred"].map(automationClaim);
          }),
        completeLease: (leaseId) => Effect.sync(() => completed.push(leaseId)).pipe(Effect.asVoid),
        failLease: (leaseId, delay, reason) =>
          Effect.sync(() => failed.push({ leaseId, delay, reason })).pipe(Effect.asVoid),
      },
    });
    const harness = yield* buildHarness({
      automation,
      settled: () => {
        settlementRuns += 1;
      },
      executeScheduled: (item) => {
        if (item.id === "retry") {
          return Effect.fail(
            new AutomationExecutionError({
              operation: "execute",
              cause: new CodexScheduledAutomationRetryError(
                "Renderer owner is unavailable",
                60_000,
                "renderer_owner_unavailable",
              ),
            }),
          );
        }
        if (item.id === "deferred") {
          return Effect.fail(
            new AutomationExecutionError({
              operation: "execute",
              cause: new CodexScheduledAutomationRetryError(
                "Heartbeat automations are disabled",
                null,
                "heartbeat_disabled",
              ),
            }),
          );
        }
        return Effect.void;
      },
    });
    yield* harness.scheduled.activate;
    yield* waitUntil("scheduled claim settlement", () => completed.length + failed.length === 3);

    assert.deepEqual(completed, ["lease:complete"]);
    assert.deepEqual(failed, [
      { leaseId: "lease:retry", delay: 60_000, reason: "renderer_owner_unavailable" },
      { leaseId: "lease:deferred", delay: null, reason: "heartbeat_disabled" },
    ]);
    assert.strictEqual(settlementRuns, 1);

    yield* SubscriptionRef.set(harness.authorityState, {
      kind: "recovering",
      attempt: 1,
      previousGeneration: "generation-1",
    });
    yield* SubscriptionRef.set(harness.authorityState, {
      kind: "ready",
      generation: "generation-2",
    });
    yield* waitUntil("recovery tick", () => claimCalls === 2);
    assert.strictEqual(settlementRuns, 1);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("skips overlapping scheduled ticks while a claimed run is active", () =>
  Effect.gen(function* () {
    let claimCalls = 0;
    let completions = 0;
    let releaseRun: (() => void) | null = null;
    let shouldBlock = true;
    const automation = defaultAutomation({
      definitions: {
        claimDue: () =>
          Effect.sync(() => {
            claimCalls += 1;
            return [{ ...automationClaim("slow"), leaseId: `lease:${claimCalls}` }];
          }),
        completeLease: () => Effect.sync(() => void (completions += 1)),
      },
    });
    const harness = yield* buildHarness({
      automation,
      executeScheduled: () => {
        if (!shouldBlock) return Effect.void;
        return Effect.callback<void>((resume) => {
          releaseRun = () => {
            shouldBlock = false;
            resume(Effect.void);
          };
        });
      },
    });
    yield* harness.scheduled.activate;
    yield* waitUntil("active scheduled run", () => releaseRun !== null);

    yield* harness.scheduled.setHeartbeatAutomationsEnabled(true);
    assert.strictEqual(claimCalls, 1);
    const completeRun = releaseRun as (() => void) | null;
    completeRun?.();
    yield* waitUntil("first scheduled completion", () => completions === 1);
    yield* harness.scheduled.setHeartbeatAutomationsEnabled(true);
    yield* waitUntil("second scheduled tick", () => claimCalls === 2);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("returns an admitted automation lease when its Main Scope closes", () =>
  Effect.gen(function* () {
    const failures: Array<{ leaseId: string; reason: string }> = [];
    let runStarted = false;
    let runInterrupted = false;
    const automation = defaultAutomation({
      definitions: {
        claimDue: () =>
          Effect.succeed([{ ...automationClaim("shutdown"), leaseId: "lease:shutdown" }]),
        failLease: (leaseId, _delay, reason) =>
          Effect.sync(() => failures.push({ leaseId, reason })).pipe(Effect.asVoid),
      },
    });
    const harness = yield* buildHarness({
      automation,
      executeScheduled: () =>
        Effect.sync(() => {
          runStarted = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              runInterrupted = true;
            }),
          ),
        ),
    });
    yield* harness.scheduled.activate;
    yield* waitUntil("scheduled shutdown run", () => runStarted);

    yield* Scope.close(harness.scope, Exit.void);
    assert.isTrue(runInterrupted);
    assert.deepEqual(failures, [{ leaseId: "lease:shutdown", reason: "scheduler_stopped" }]);
  }),
);

it.effect("projects heartbeat state with a TestClock-owned freshness deadline", () =>
  Effect.gen(function* () {
    const contexts: CodexScheduledAutomationRunContext[] = [];
    const automation = defaultAutomation({
      definitions: {
        claimDue: () =>
          Effect.succeed([
            {
              ...automationClaim("heartbeat"),
              leaseId: "lease:heartbeat",
              definition: automationDefinition("heartbeat", "heartbeat"),
            },
          ]),
      },
    });
    const harness = yield* buildHarness({
      automation,
      executeScheduled: (_item, context) =>
        Effect.sync(() => {
          contexts.push(context);
        }),
    });
    yield* harness.scheduled.activate;
    yield* waitUntil("initial heartbeat context", () => contexts.length === 1);
    assert.isFalse(contexts[0]?.heartbeat?.automationsEnabled ?? true);

    yield* harness.scheduled.setHeartbeatThreadRendererState({
      threadId: "thread-follow-up",
      rendererClientId: "renderer-owner",
      streamRole: "owner",
      isEligible: true,
      reason: null,
      collaborationMode: "plan",
      permissions: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo/project"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
    yield* harness.scheduled.setHeartbeatAutomationsEnabled(true);
    yield* waitUntil("enabled heartbeat context", () => contexts.length >= 2);
    const enabled = contexts.at(-1)?.heartbeat;
    assert.isTrue(enabled?.automationsEnabled ?? false);
    assert.isTrue(enabled?.rendererState?.isEligible ?? false);
    assert.strictEqual(enabled?.collaborationMode, "plan");
    assert.strictEqual(enabled?.permissions?.approvalPolicy, "on-request");

    const beforeExpiryTick = contexts.length;
    yield* TestClock.adjust("121 seconds");
    yield* harness.scheduled.setHeartbeatAutomationsEnabled(true);
    yield* waitUntil("expired heartbeat context", () => contexts.length > beforeExpiryTick);
    const stale = contexts.at(-1)?.heartbeat;
    assert.isNull(stale?.rendererState ?? null);
    assert.strictEqual(stale?.collaborationMode, "plan");
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("replaces backup schedules and runs semantic maintenance lanes", () =>
  Effect.gen(function* () {
    const backups: string[] = [];
    const prunes: Array<readonly [number, number]> = [];
    const maintenance: unknown[] = [];
    let retentionCount = 17;
    const administration = {
      ...defaultAdministration(),
      createBackup: (input?: Parameters<StoreAdministration["Service"]["createBackup"]>[0]) =>
        Effect.sync(() => backups.push("auto")).pipe(
          Effect.andThen(defaultAdministration().createBackup(input)),
        ),
      pruneBackups: (count: number, bytes: number) =>
        Effect.sync(() => prunes.push([count, bytes])),
      runMaintenance: (input: StoreMaintenanceInput) => Effect.sync(() => maintenance.push(input)),
    } satisfies StoreAdministration["Service"];
    const harness = yield* buildHarness({
      administration,
      readBlockRetentionCount: () => retentionCount,
      storeTiming: {
        maintenance: {
          operational: { initial: 40, interval: 10 * 60_000 },
          revision: { initial: 10, interval: 10 * 60_000 },
          document: { initial: 20, interval: 10 * 60_000 },
          block: { initial: 30, interval: 10 * 60_000 },
        },
      },
    });
    yield* harness.store.activate;
    yield* harness.store.configureBackup({
      autoEnabled: true,
      intervalHours: 1,
      retentionCount: 4,
      retentionGiB: 12,
    });

    yield* TestClock.adjust(10);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(10);
    yield* Effect.yieldNow;
    retentionCount = 3;
    yield* TestClock.adjust(10);
    yield* Effect.yieldNow;
    assert.deepEqual(maintenance.slice(0, 3), [
      {
        tasks: ["document_revision_finalize"],
        workToken: "maintenance:document_revision_finalize",
      },
      {
        tasks: ["document_compaction", "history_retention"],
        workToken: "maintenance:document_compaction,history_retention",
      },
      {
        tasks: ["block_retention"],
        blockRetentionCount: 3,
        workToken: "maintenance:block_retention",
      },
    ]);

    yield* TestClock.adjust("1 hour");
    yield* Effect.yieldNow;
    assert.deepEqual(backups, ["auto"]);
    assert.deepEqual(prunes, [[4, 12 * 1024 * 1024 * 1024]]);

    yield* harness.store.configureBackup({
      autoEnabled: false,
      intervalHours: 1,
      retentionCount: 4,
      retentionGiB: 12,
    });
    yield* TestClock.adjust("2 hours");
    assert.deepEqual(backups, ["auto"]);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("serializes maintenance lanes and interrupts every schedule on Scope close", () =>
  Effect.gen(function* () {
    let runs = 0;
    const release = yield* Deferred.make<void>();
    const administration = {
      ...defaultAdministration(),
      runMaintenance: () =>
        Effect.sync(() => {
          runs += 1;
        }).pipe(Effect.andThen(Deferred.await(release))),
    } satisfies StoreAdministration["Service"];
    const harness = yield* buildHarness({
      administration,
      storeTiming: {
        maintenance: {
          revision: { initial: 1, interval: 10 },
          document: { initial: 1, interval: 10 },
          block: { initial: 1, interval: 10 },
        },
      },
    });
    yield* harness.store.activate;
    yield* TestClock.adjust(1);
    yield* waitUntil("one maintenance lane", () => runs === 1);
    yield* TestClock.adjust(100);
    assert.strictEqual(runs, 1);

    yield* Scope.close(harness.scope, Exit.void);
    yield* TestClock.adjust("1 day");
    assert.strictEqual(runs, 1);
  }),
);

it.effect("queues contending maintenance lanes fairly without dropping a due pass", () =>
  Effect.gen(function* () {
    const releaseDocument = yield* Deferred.make<void>();
    let documentRuns = 0;
    let operationalRuns = 0;
    const administration = {
      ...defaultAdministration(),
      runMaintenance: (input: StoreMaintenanceInput) => {
        if (input.tasks.includes("document_compaction")) {
          return Effect.sync(() => {
            documentRuns += 1;
          }).pipe(Effect.andThen(Deferred.await(releaseDocument)));
        }
        if (input.tasks.includes("operational_journal")) {
          return Effect.sync(() => {
            operationalRuns += 1;
          });
        }
        return Effect.void;
      },
    } satisfies StoreAdministration["Service"];
    const harness = yield* buildHarness({
      administration,
      storeTiming: {
        maintenance: {
          document: { initial: 1, interval: 10_000 },
          operational: { initial: 2, interval: 250, idleInterval: 1_000 },
          revision: { initial: 10_000, interval: 10_000 },
          block: { initial: 10_000, interval: 10_000 },
        },
      },
    });
    yield* harness.store.activate;
    yield* TestClock.adjust(1);
    yield* waitUntil("document maintenance lock", () => documentRuns === 1);
    yield* TestClock.adjust(1);
    yield* Effect.yieldNow;
    assert.strictEqual(operationalRuns, 0);

    yield* Deferred.succeed(releaseDocument, undefined);
    yield* waitUntil("queued operational maintenance", () => operationalRuns === 1);

    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("replans maintenance at its active cadence after stale Core evidence", () =>
  Effect.gen(function* () {
    let operationalRuns = 0;
    const administration = {
      ...defaultAdministration(),
      runMaintenance: (input: StoreMaintenanceInput) => {
        if (!input.tasks.includes("operational_journal")) return Effect.void;
        operationalRuns += 1;
        if (operationalRuns > 2) return Effect.void;
        const responseError = new CoreModuleResponseError({
          code: operationalRuns === 1 ? "conflict" : "revision_conflict",
          message: "Store maintenance evidence is stale; plan maintenance again",
          retryable: true,
          recovery: { kind: "none" },
        });
        return Effect.fail(
          new StoreAdministrationError({
            operation: "run-maintenance",
            cause:
              operationalRuns === 1
                ? coreRuntimeError({
                    operation: "administration.apply",
                    reason: "operation",
                    retryable: false,
                    cause: responseError,
                  })
                : responseError,
          }),
        );
      },
    } satisfies StoreAdministration["Service"];
    const harness = yield* buildHarness({
      administration,
      storeTiming: {
        maintenance: {
          operational: { initial: 1, interval: 250, idleInterval: 1_000 },
          revision: { initial: 10_000, interval: 10_000 },
          document: { initial: 10_000, interval: 10_000 },
          block: { initial: 10_000, interval: 10_000 },
        },
      },
    });
    yield* harness.store.activate;
    yield* TestClock.adjust(1);
    yield* waitUntil("stale maintenance attempt", () => operationalRuns === 1);
    yield* TestClock.adjust(249);
    yield* Effect.yieldNow;
    assert.strictEqual(operationalRuns, 1);
    yield* TestClock.adjust(1);
    yield* waitUntil("maintenance replan", () => operationalRuns === 2);
    yield* TestClock.adjust(250);
    yield* waitUntil("maintenance evidence replan", () => operationalRuns === 3);

    yield* Scope.close(harness.scope, Exit.void);
  }),
);
