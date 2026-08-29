import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ManagedWorktreeSettings } from "../../shared/types";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import {
  resolveManagedWorktreeId,
  resolveWorktreePathComparisonKey,
} from "../codex/codex-managed-worktree-effects";
import {
  planManagedWorktreeRetention,
  type CodexManagedWorktreeRetentionPlan,
  type CodexManagedWorktreeRetentionPathProtection,
} from "../codex/codex-managed-worktree-retention";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { ManagedWorktreeConfiguration } from "./ExecutionHostConfiguration";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";
import { MAIN_RELIABLE_COMMAND_CAPACITY } from "../runtime-limits";

export class ManagedWorktreeRetentionRuntimeError extends Schema.TaggedError<ManagedWorktreeRetentionRuntimeError>()(
  "ManagedWorktreeRetentionRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ManagedWorktreeRetentionRuntimeOptions {
  readonly debounce?: Duration.Input;
}

interface RetentionCommand {
  readonly reply?: Deferred.Deferred<
    CodexManagedWorktreeRetentionPlan,
    ManagedWorktreeRetentionRuntimeError
  >;
}

export class ManagedWorktreeRetentionRuntime extends Context.Service<
  ManagedWorktreeRetentionRuntime,
  {
    /** Schedules a best-effort policy evaluation after the fixed coalescing window. */
    readonly request: Effect.Effect<void>;
    /** Flushes the coalescing window and awaits the latest policy evaluation. */
    readonly run: Effect.Effect<
      CodexManagedWorktreeRetentionPlan,
      ManagedWorktreeRetentionRuntimeError
    >;
  }
>()("nodex/main/codex-application/ManagedWorktreeRetentionRuntime") {}

const DEFAULT_DEBOUNCE = "300 millis";

export const live = (
  options: ManagedWorktreeRetentionRuntimeOptions,
): Layer.Layer<
  ManagedWorktreeRetentionRuntime,
  never,
  | CodexPendingWorktreeRuntime
  | CodexApplicationEventHub
  | AutomationApplication
  | ExecutionHostRuntime
  | ManagedWorktreeConfiguration
  | ProjectWorkspace
  | ManagedWorktreeRuntime
> =>
  Layer.effect(
    ManagedWorktreeRetentionRuntime,
    Effect.gen(function* () {
      const automation = yield* AutomationApplication;
      const executionHosts = yield* ExecutionHostRuntime;
      const applicationEvents = yield* CodexApplicationEventHub;
      const configuration = yield* ManagedWorktreeConfiguration;
      const managed = yield* ManagedWorktreeRuntime;
      const pending = yield* CodexPendingWorktreeRuntime;
      const workspace = yield* ProjectWorkspace;
      const commands = yield* Queue.bounded<RetentionCommand>(MAIN_RELIABLE_COMMAND_CAPACITY);
      yield* Effect.addFinalizer(() => Queue.shutdown(commands).pipe(Effect.asVoid));

      const error = (operation: string, cause: unknown) =>
        new ManagedWorktreeRetentionRuntimeError({ operation, cause });
      const fromPromise = <A>(
        operation: string,
        run: () => Promise<A>,
      ): Effect.Effect<A, ManagedWorktreeRetentionRuntimeError> =>
        Effect.tryPromise({ try: run, catch: (cause) => error(operation, cause) });
      const skippedPlan = (
        settings: ManagedWorktreeSettings,
        metadataComplete: boolean,
        nowMs: number,
      ): CodexManagedWorktreeRetentionPlan =>
        planManagedWorktreeRetention({
          enabled: settings.autoDeleteEnabled,
          keepCount: settings.autoDeleteLimit,
          metadataComplete,
          records: [],
          threadMetadata: [],
          pathProtections: [],
          protectPreMigrationOwnerlessWorktrees: true,
          nowMs,
        });

      const readPlan = Effect.fn("ManagedWorktreeRetentionRuntime.readPlan")(function* (
        settings: ManagedWorktreeSettings,
        nowMs: number,
        phase: "read" | "revalidate",
      ) {
        const [lifecycle, physicalByHost] = yield* Effect.all(
          [
            workspace.readManagedWorktreeLifecycleSnapshot.pipe(
              Effect.mapError((cause) => error(`${phase}-lifecycle`, cause)),
            ),
            executionHosts.hosts("list").pipe(
              Effect.flatMap((hosts) =>
                Effect.forEach(
                  hosts,
                  (host) =>
                    managed.list(host.hostId).pipe(
                      Effect.map((inventory) => ({ hostId: host.hostId, inventory })),
                      Effect.mapError((cause) => error(`${phase}-worktrees`, cause)),
                    ),
                  { concurrency: 2 },
                ),
              ),
            ),
          ] as const,
          { concurrency: "unbounded" },
        );
        const physicalEntries = physicalByHost.flatMap(({ hostId, inventory }) =>
          inventory.entries.map((entry) => ({ hostId, entry })),
        );
        const localPermanentKeys = new Set(
          yield* Effect.forEach(
            lifecycle.projects.flatMap((project) => project.sourceRoots),
            (root) =>
              fromPromise(`${phase}-permanent-root`, () => resolveWorktreePathComparisonKey(root)),
            { concurrency: "unbounded" },
          ),
        );
        const pathProtections: CodexManagedWorktreeRetentionPathProtection[] = [];
        for (const { hostId, entry } of physicalEntries) {
          if (hostId !== CODEX_APP_LOCAL_HOST_ID) continue;
          const comparisonKey = yield* fromPromise(`${phase}-worktree-root`, () =>
            resolveWorktreePathComparisonKey(entry.worktreeGitRoot),
          );
          if (!localPermanentKeys.has(comparisonKey)) continue;
          pathProtections.push({
            hostId,
            worktreeGitRoot: entry.worktreeGitRoot,
            reason: "permanent",
          });
        }
        for (const entry of pending.list()) {
          if (!entry.worktreeGitRoot) continue;
          pathProtections.push({
            hostId: entry.hostId,
            worktreeGitRoot: entry.worktreeGitRoot,
            reason: "pending",
          });
        }
        for (const newborn of yield* managed.newborns) {
          pathProtections.push({ ...newborn, reason: "newborn" });
        }

        const automationProtection = new Map(
          yield* Effect.forEach(
            lifecycle.consumers,
            (consumer) =>
              automation.runs.get(consumer.threadId).pipe(
                Effect.mapError((cause) => error(`${phase}-automation-protection`, cause)),
                Effect.map((run) => [consumer.threadId, run !== null] as const),
              ),
            { concurrency: 8 },
          ),
        );
        for (const consumer of lifecycle.consumers) {
          const reason =
            consumer.pinnedOrder !== null
              ? "pinned"
              : consumer.statusType === "active" || consumer.statusActiveFlags.length > 0
                ? "in-progress"
                : automationProtection.get(consumer.threadId)
                  ? "automation"
                  : null;
          if (!reason) continue;
          pathProtections.push({
            hostId: consumer.executionHostId,
            worktreeGitRoot: consumer.managedWorktreePath,
            reason,
          });
        }

        return planManagedWorktreeRetention({
          enabled: settings.autoDeleteEnabled,
          keepCount: settings.autoDeleteLimit,
          metadataComplete: true,
          records: physicalEntries.map(({ hostId, entry }) => ({
            hostId,
            worktreeGitRoot: entry.worktreeGitRoot,
            createdAtMs: entry.createdAtMs,
            ownerThreadId: entry.ownerThreadId,
            ownerReadFailed: entry.ownerReadFailed,
          })),
          threadMetadata: lifecycle.consumers.map((consumer) => ({
            threadId: consumer.threadId,
            updatedAtMs: consumer.updatedAt,
            pinned: consumer.pinnedOrder !== null,
            inProgress: consumer.statusType === "active" || consumer.statusActiveFlags.length > 0,
            automationProtected: automationProtection.get(consumer.threadId) === true,
          })),
          pathProtections,
          protectPreMigrationOwnerlessWorktrees: true,
          nowMs,
        });
      });

      const sweep: Effect.Effect<
        CodexManagedWorktreeRetentionPlan,
        ManagedWorktreeRetentionRuntimeError
      > = Effect.gen(function* () {
        const settings = yield* configuration.settings.pipe(
          Effect.mapError((cause) => error("read-settings", cause)),
        );
        const nowMs = yield* Clock.currentTimeMillis;
        if (!settings.autoDeleteEnabled) return skippedPlan(settings, true, nowMs);

        const plan = yield* readPlan(settings, nowMs, "read").pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Managed worktree retention skipped because metadata is incomplete",
            ).pipe(Effect.annotateLogs({ cause: String(cause.cause) }), Effect.as(null)),
          ),
        );
        if (!plan) return skippedPlan(settings, false, nowMs);
        if (plan.status !== "planned") return plan;

        yield* Effect.logInfo("Managed worktree retention plan").pipe(
          Effect.annotateLogs({
            totalWorktrees: plan.items.length,
            keepCount: settings.autoDeleteLimit,
            protectedCount: plan.items.filter((item) => item.protectionReasons.length > 0).length,
            ownerlessCount: plan.items.filter((item) => item.ownerThreadId === null).length,
            deletesPlanned: plan.delete.length,
          }),
        );
        for (const item of plan.delete.slice(0, 20)) {
          yield* Effect.logInfo("Managed worktree retention candidate").pipe(
            Effect.annotateLogs({
              worktreeId: resolveManagedWorktreeId(item.worktreeGitRoot),
              hostId: item.hostId,
              reason: item.ownerThreadId === null ? "ownerless" : "owned",
              ownerThreadId: item.ownerThreadId,
              ownerThreadUpdatedAtMs: item.ownerUpdatedAtMs,
              createdAtMs: item.createdAtMs,
              ownerReadFailed: item.ownerReadFailed,
            }),
          );
        }
        const freshSettings = yield* configuration.settings.pipe(
          Effect.mapError((cause) => error("revalidate-settings", cause)),
        );
        if (!freshSettings.autoDeleteEnabled) {
          return skippedPlan(freshSettings, true, nowMs);
        }
        const freshPlan = yield* readPlan(freshSettings, nowMs, "revalidate");
        if (freshPlan.status !== "planned") return freshPlan;
        const results = yield* Effect.forEach(
          freshPlan.delete,
          (item) =>
            Effect.exit(
              managed.remove({
                hostId: item.hostId,
                worktreeGitRoot: item.worktreeGitRoot,
                reason: "automatic-retention",
              }),
            ).pipe(Effect.map((result) => ({ item, result }))),
          { concurrency: 3 },
        );
        for (const result of results) {
          if (Exit.isSuccess(result.result)) continue;
          yield* Effect.logWarning("Managed worktree retention candidate was retained").pipe(
            Effect.annotateLogs({
              worktreeId: resolveManagedWorktreeId(result.item.worktreeGitRoot),
              hostId: result.item.hostId,
              error: Cause.pretty(result.result.cause),
            }),
          );
        }
        return freshPlan;
      });

      const drainAvailable = Effect.gen(function* () {
        const drained: RetentionCommand[] = [];
        while (true) {
          const next = yield* Queue.poll(commands);
          if (Option.isNone(next)) return drained;
          drained.push(next.value);
        }
      });

      const awaitBatch = Effect.gen(function* () {
        const batch: RetentionCommand[] = [yield* Queue.take(commands)];
        if (batch[0]?.reply !== undefined) return batch;

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const deadline = yield* Effect.sleep(options.debounce ?? DEFAULT_DEBOUNCE).pipe(
              Effect.as({ _tag: "Elapsed" as const }),
              Effect.forkScoped,
            );
            while (true) {
              const next = yield* Effect.raceFirst(
                Queue.take(commands).pipe(
                  Effect.map((command) => ({ _tag: "Command" as const, command })),
                ),
                Fiber.join(deadline),
              );
              if (next._tag === "Elapsed") {
                batch.push(...(yield* drainAvailable));
                return batch;
              }
              batch.push(next.command);
              if (next.command.reply !== undefined) {
                batch.push(...(yield* drainAvailable));
                return batch;
              }
            }
          }),
        );
      });

      const actor = Effect.gen(function* () {
        let immediate: RetentionCommand[] = [];
        while (true) {
          const batch = immediate.length > 0 ? immediate : yield* awaitBatch;
          const result = yield* Effect.exit(sweep);
          let hasReply = false;
          for (const command of batch) {
            if (command.reply === undefined) continue;
            hasReply = true;
            yield* Deferred.done(command.reply, result);
          }
          if (!hasReply && Exit.isFailure(result)) {
            yield* Effect.logWarning("Managed worktree retention sweep failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(result.cause) }),
            );
          }
          immediate = yield* drainAvailable;
        }
      });
      yield* Effect.forkScoped(actor);

      const service = ManagedWorktreeRetentionRuntime.of({
        request: Queue.offer(commands, {}).pipe(Effect.asVoid),
        run: Effect.gen(function* () {
          const reply = yield* Deferred.make<
            CodexManagedWorktreeRetentionPlan,
            ManagedWorktreeRetentionRuntimeError
          >();
          yield* Queue.offer(commands, { reply });
          return yield* Deferred.await(reply);
        }),
      });
      yield* applicationEvents.events.pipe(
        Stream.filter(
          (event) =>
            event.kind === "codex" &&
            event.value.type === "threadArchivedState" &&
            event.value.archived,
        ),
        Stream.runForEach(() => service.request),
        Effect.forkScoped({ startImmediately: true }),
      );
      return service;
    }),
  );
