import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type {
  ManagedWorktreeAvailability,
  ManagedWorktreeRecord,
  ManagedWorktreeRestoreResult,
  ManagedWorktreeSettings,
  UpdateManagedWorktreeSettingsInput,
} from "../../shared/types";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import type {
  DesktopManagedWorktreeSummary,
  DesktopManagedWorktreeWindow,
} from "../core-client/project-workspace-adapter";
import {
  normalizeWorktreePathForIdentity,
  resolveWorktreePathComparisonKey,
} from "../codex/codex-managed-worktree-effects";
import {
  ProjectWorkspace,
  type ProjectWorkspaceError,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { buildWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";
import { ManagedWorktreeConfiguration } from "./ExecutionHostConfiguration";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";
import { ManagedWorktreeRetentionRuntime } from "./ManagedWorktreeRetentionRuntime";

export class ManagedWorktreeCatalogError extends Data.TaggedError("ManagedWorktreeCatalogError")<{
  readonly operation:
    | "delete"
    | "list"
    | "read-settings"
    | "inspect-thread"
    | "restore-thread"
    | "update-settings";
  readonly cause: unknown;
}> {}

export interface ManagedWorktreeCatalogOptions {
  readonly defaultManagedRoot: string;
}

export class ManagedWorktreeCatalog extends Context.Service<
  ManagedWorktreeCatalog,
  {
    readonly list: (
      hostId: string,
    ) => Effect.Effect<readonly ManagedWorktreeRecord[], ManagedWorktreeCatalogError>;
    readonly inspectThread: (
      threadId: string,
    ) => Effect.Effect<ManagedWorktreeAvailability, ManagedWorktreeCatalogError>;
    readonly restoreThread: (
      threadId: string,
    ) => Effect.Effect<ManagedWorktreeRestoreResult, ManagedWorktreeCatalogError>;
    readonly settings: Effect.Effect<ManagedWorktreeSettings, ManagedWorktreeCatalogError>;
    readonly updateSettings: (
      input: UpdateManagedWorktreeSettingsInput,
    ) => Effect.Effect<ManagedWorktreeSettings, ManagedWorktreeCatalogError>;
    readonly delete: (
      hostId: string,
      worktreePath: string,
    ) => Effect.Effect<boolean, ManagedWorktreeCatalogError>;
  }
>()("nodex/main/codex-application/ManagedWorktreeCatalog") {}

interface ManagedThreadContext {
  readonly threadId: string;
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly cwd: string;
  readonly candidateRepositoryPaths: readonly string[];
}

const toManagedWorktreeInspection = (context: ManagedThreadContext) => ({
  hostId: context.hostId,
  worktreeGitRoot: context.worktreeGitRoot,
  cwd: context.cwd,
  candidateRepositoryPaths: context.candidateRepositoryPaths,
});

export const make = (
  options: ManagedWorktreeCatalogOptions,
): Effect.Effect<
  ManagedWorktreeCatalog["Service"],
  never,
  | CodexApplicationEventHub
  | ExecutionHostRuntime
  | ManagedWorktreeConfiguration
  | ProjectWorkspace
  | ManagedWorktreeRetentionRuntime
  | ManagedWorktreeRuntime
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const events = yield* CodexApplicationEventHub;
    const executionHosts = yield* ExecutionHostRuntime;
    const configuration = yield* ManagedWorktreeConfiguration;
    const managed = yield* ManagedWorktreeRuntime;
    const retention = yield* ManagedWorktreeRetentionRuntime;
    const workspace = yield* ProjectWorkspace;
    const ownerScope = yield* Scope.Scope;

    const fail = (
      operation: ManagedWorktreeCatalogError["operation"],
      cause: unknown,
    ): ManagedWorktreeCatalogError => new ManagedWorktreeCatalogError({ operation, cause });
    const runOwned = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
        Fiber.join,
        Fiber.interrupt,
      );
    const project = <A>(
      operation: ManagedWorktreeCatalogError["operation"],
      effect: Effect.Effect<A, ProjectWorkspaceError>,
    ): Effect.Effect<A, ManagedWorktreeCatalogError> =>
      effect.pipe(Effect.mapError((cause) => fail(operation, cause)));
    const resolvePath = (operation: ManagedWorktreeCatalogError["operation"], path: string) =>
      Effect.tryPromise({
        try: () => resolveWorktreePathComparisonKey(path),
        catch: (cause) => fail(operation, cause),
      });
    const resolveThreadContext = (
      threadId: string,
      operation: "inspect-thread" | "restore-thread",
    ): Effect.Effect<ManagedThreadContext | null, ManagedWorktreeCatalogError> =>
      Effect.gen(function* () {
        const thread = yield* project(operation, workspace.getThread(threadId));
        const worktreeGitRoot = thread?.managedWorktreePath?.trim();
        const cwd = thread?.cwd?.trim();
        if (!thread || !worktreeGitRoot || !cwd) return null;

        const lifecycle = yield* project(operation, workspace.readManagedWorktreeLifecycleSnapshot);
        const candidates = new Set(
          lifecycle.projects
            .filter((project) => project.projectId === thread.projectId)
            .flatMap((project) => project.sourceRoots)
            .map((root) => root.trim())
            .filter(Boolean),
        );
        if (candidates.size === 0) {
          const inventory = yield* managed.list(thread.executionHostId).pipe(
            Effect.mapError((cause) => fail(operation, cause)),
            Effect.catch(() => Effect.succeed(null)),
          );
          const normalizedPath = normalizeWorktreePathForIdentity(worktreeGitRoot);
          for (const entry of inventory?.entries ?? []) {
            if (
              normalizeWorktreePathForIdentity(entry.worktreeGitRoot) === normalizedPath &&
              entry.repositoryPath?.trim()
            ) {
              candidates.add(entry.repositoryPath.trim());
            }
          }
        }
        return {
          threadId: thread.threadId,
          hostId: thread.executionHostId,
          worktreeGitRoot,
          cwd,
          candidateRepositoryPaths: [...candidates],
        };
      });

    const list = (hostId: string) =>
      runOwned(
        Effect.gen(function* () {
          const normalizedHostId = hostId.trim();
          if (!normalizedHostId)
            return yield* fail("list", new Error("Execution host is required"));
          const [inventory, lifecycle, projects] = yield* Effect.all(
            [
              managed.list(normalizedHostId).pipe(Effect.mapError((cause) => fail("list", cause))),
              project("list", workspace.readManagedWorktreeLifecycleSnapshot),
              project("list", workspace.listProjects),
            ] as const,
            { concurrency: "unbounded" },
          );
          const summaries: DesktopManagedWorktreeSummary[] = [];
          let after: string | null = null;
          let projectionRevision: number | null = null;
          for (let page = 0; page < 250; page += 1) {
            const summaryWindow: DesktopManagedWorktreeWindow = yield* project(
              "list",
              workspace.listManagedWorktreeWindow({ after, first: 200 }),
            );
            if (
              projectionRevision !== null &&
              summaryWindow.projectionRevision !== projectionRevision
            ) {
              return yield* fail("list", new Error("Worktree metadata changed while listing"));
            }
            projectionRevision = summaryWindow.projectionRevision;
            summaries.push(...summaryWindow.items);
            after = summaryWindow.nextCursor;
            if (!after) break;
            if (page === 249) {
              return yield* fail("list", new Error("Worktree metadata exceeded its page bound"));
            }
          }
          const summaryByThreadId = new Map(
            summaries.map((summary) => [summary.threadId, summary] as const),
          );
          const projectNameById = new Map(
            projects.map((project) => [project.id, project.name] as const),
          );
          const permanentRoots = new Set(
            (yield* Effect.forEach(
              lifecycle.projects.flatMap((entry) => entry.sourceRoots),
              (root) => resolvePath("list", root),
              { concurrency: "unbounded" },
            )).map((root) => `${CODEX_APP_LOCAL_HOST_ID}\0${root}`),
          );
          const consumersByPath = new Map<string, typeof lifecycle.consumers>();
          for (const consumer of lifecycle.consumers) {
            const key = `${consumer.executionHostId}\0${normalizeWorktreePathForIdentity(
              consumer.managedWorktreePath,
            )}`;
            consumersByPath.set(key, [...(consumersByPath.get(key) ?? []), consumer]);
          }
          const physicalEntries = inventory.entries.map((entry) => ({
            hostId: normalizedHostId,
            entry,
          }));
          const records = yield* Effect.forEach(
            physicalEntries,
            ({
              hostId,
              entry,
            }): Effect.Effect<ManagedWorktreeRecord | null, ManagedWorktreeCatalogError> =>
              Effect.gen(function* () {
                const normalizedPath = normalizeWorktreePathForIdentity(entry.worktreeGitRoot);
                const comparisonKey = yield* resolvePath("list", entry.worktreeGitRoot);
                if (permanentRoots.has(`${hostId}\0${comparisonKey}`)) return null;
                const consumers = consumersByPath.get(`${hostId}\0${normalizedPath}`) ?? [];
                const conversations = consumers.map((consumer) => {
                  const summary = summaryByThreadId.get(consumer.threadId);
                  return {
                    threadId: consumer.threadId,
                    projectId: consumer.projectId,
                    projectName: consumer.projectId
                      ? (projectNameById.get(consumer.projectId) ?? null)
                      : null,
                    sessionId: consumer.sessionId,
                    sessionTitle: summary?.sessionTitle ?? null,
                    threadName: summary?.threadName ?? null,
                    archived: consumer.archived,
                    updatedAt: consumer.updatedAt,
                  };
                });
                return {
                  hostId,
                  path: entry.worktreeGitRoot,
                  exists: true,
                  repositoryPath: entry.repositoryPath,
                  createdAtMs: entry.createdAtMs,
                  conversations: conversations.sort(
                    (left, right) => right.updatedAt - left.updatedAt,
                  ),
                };
              }),
            { concurrency: "unbounded" },
          );
          return records
            .filter((record): record is ManagedWorktreeRecord => record !== null)
            .sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
        }),
      );

    return ManagedWorktreeCatalog.of({
      list,
      settings: configuration.settings.pipe(
        Effect.mapError((cause) => fail("read-settings", cause)),
      ),
      updateSettings: (input) =>
        runOwned(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const settings = yield* configuration
                .update(input)
                .pipe(Effect.mapError((cause) => fail("update-settings", cause)));
              yield* executionHosts
                .updateLocalManagedRoot(settings.worktreeRoot ?? options.defaultManagedRoot)
                .pipe(Effect.mapError((cause) => fail("update-settings", cause)));
              yield* retention.request;
              return settings;
            }),
          ),
        ),
      inspectThread: (threadId) => {
        const normalizedThreadId = threadId.trim();
        if (!normalizedThreadId) {
          return Effect.succeed<ManagedWorktreeAvailability>({ state: "not-managed" });
        }
        return runOwned(
          Effect.gen(function* () {
            const context = yield* resolveThreadContext(normalizedThreadId, "inspect-thread");
            if (!context) {
              return { state: "not-managed" } satisfies ManagedWorktreeAvailability;
            }
            return yield* managed.inspect(toManagedWorktreeInspection(context)).pipe(
              Effect.map((result) => result.availability),
              Effect.catch((error) =>
                Effect.succeed<ManagedWorktreeAvailability>({
                  state: "unavailable",
                  reason: "inspection-failed",
                  message: error.cause instanceof Error ? error.cause.message : String(error.cause),
                }),
              ),
            );
          }),
        );
      },
      restoreThread: (threadId) =>
        runOwned(
          Effect.gen(function* () {
            const context = yield* resolveThreadContext(threadId.trim(), "restore-thread");
            if (!context) {
              return yield* Effect.fail(
                fail("restore-thread", new Error("Thread does not use a managed worktree")),
              );
            }
            const result = yield* managed
              .restore({
                ...toManagedWorktreeInspection(context),
                ownerThreadId: context.threadId,
              })
              .pipe(Effect.mapError((cause) => fail("restore-thread", cause)));
            if (result.ownerWarning) {
              yield* Effect.logWarning("Restored managed worktree without owner metadata").pipe(
                Effect.annotateLogs({
                  threadId: context.threadId,
                  hostId: context.hostId,
                  warning: result.ownerWarning,
                }),
              );
            }
            const persisted = yield* project(
              "restore-thread",
              workspace.getThread(context.threadId),
            );
            if (persisted) {
              events.publish({
                kind: "codex",
                value: { type: "threadSummary", thread: buildWorkspaceThreadSummary(persisted) },
              });
            }
            return {
              availability: { state: "available" as const },
              ownerWarning: result.ownerWarning,
            };
          }),
        ),
      delete: (hostId, worktreePath) =>
        runOwned(
          Effect.gen(function* () {
            const inventory = yield* managed
              .list(hostId)
              .pipe(Effect.mapError((cause) => fail("delete", cause)));
            const normalizedPath = normalizeWorktreePathForIdentity(worktreePath);
            if (
              !inventory.entries.some(
                (entry) =>
                  normalizeWorktreePathForIdentity(entry.worktreeGitRoot) === normalizedPath,
              )
            ) {
              return yield* fail(
                "delete",
                new Error("Worktree is no longer present in the current host inventory"),
              );
            }
            const lifecycle = yield* project(
              "delete",
              workspace.readManagedWorktreeLifecycleSnapshot,
            );
            const consumers = lifecycle.consumers.filter(
              (consumer) =>
                consumer.executionHostId === hostId &&
                normalizeWorktreePathForIdentity(consumer.managedWorktreePath) === normalizedPath,
            );
            for (const consumer of consumers) {
              yield* project("delete", workspace.setThreadArchived(consumer.threadId, true)).pipe(
                Effect.asVoid,
              );
            }
            const result = yield* managed
              .remove({
                hostId,
                worktreeGitRoot: worktreePath,
                reason: "settings-delete",
              })
              .pipe(Effect.mapError((cause) => fail("delete", cause)));
            return result.removed || result.alreadyMissing;
          }),
        ),
    });
  });
