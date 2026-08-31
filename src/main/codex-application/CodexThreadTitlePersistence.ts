import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { normalizeCodexManualThreadTitle } from "../../shared/codex-thread-title";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { buildCoreWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";

export interface CodexThreadTitlePersistenceInput {
  readonly threadId: string;
  readonly name: string;
}

export interface CodexThreadTitleSetCommand extends CodexThreadTitlePersistenceInput {
  readonly normalization: "manual" | "trim";
}

export class CodexThreadTitlePersistenceEffectError extends Data.TaggedError(
  "CodexThreadTitlePersistenceEffectError",
)<{
  readonly cause: unknown;
}> {}

export class CodexThreadTitlePersistence extends Context.Service<
  CodexThreadTitlePersistence,
  {
    /** Commits local title projection, then persists both external targets best effort. */
    readonly set: (
      input: CodexThreadTitleSetCommand,
    ) => Effect.Effect<boolean, CodexThreadTitlePersistenceEffectError>;
    /** Commits local title projection and requires both persistence targets to succeed. */
    readonly setRequired: (
      input: CodexThreadTitleSetCommand,
    ) => Effect.Effect<boolean, CodexThreadTitlePersistenceEffectError>;
  }
>()("nodex/main/codex-application/CodexThreadTitlePersistence") {}

export const make: Effect.Effect<
  CodexThreadTitlePersistence["Service"],
  never,
  | CodexApplicationEventHub
  | CodexConversationProjection
  | CodexGateway
  | CodexSidebarSyncRuntime
  | CoreModules
  | Scope.Scope
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const projection = yield* CodexConversationProjection;
  const gateway = yield* CodexGateway;
  const sidebar = yield* CodexSidebarSyncRuntime;
  const core = yield* CoreModules;
  const ownerScope = yield* Scope.Scope;
  const lanes = yield* RcMap.make({
    lookup: (_threadId: string) => Semaphore.make(1),
  });

  const runOwned = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
      Fiber.join,
      Fiber.interrupt,
    );

  const runSerial = <A, E>(threadId: string, operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    runOwned(
      Effect.scoped(
        Effect.gen(function* () {
          const lane = yield* RcMap.get(lanes, threadId);
          return yield* lane.withPermit(operation);
        }),
      ),
    );

  const logFailure = (
    phase: "app-server" | "project-workspace",
    input: CodexThreadTitlePersistenceInput,
    error: CodexThreadTitlePersistenceEffectError,
  ): Effect.Effect<void> =>
    Effect.logWarning("Could not persist Thread title").pipe(
      Effect.annotateLogs({
        phase,
        threadId: input.threadId,
        error: String(error.cause),
      }),
    );

  const normalize = (
    input: CodexThreadTitleSetCommand,
  ): (CodexThreadTitleSetCommand & { readonly name: string }) | null => {
    const name =
      input.normalization === "manual"
        ? normalizeCodexManualThreadTitle(input.name)
        : input.name.trim();
    return name ? { ...input, name } : null;
  };

  const titleError = (cause: unknown): CodexThreadTitlePersistenceEffectError =>
    cause instanceof CodexThreadTitlePersistenceEffectError
      ? cause
      : new CodexThreadTitlePersistenceEffectError({ cause });

  const requireCodexThread = Effect.fn("CodexThreadTitlePersistence.requireCodexThread")(function* (
    threadId: string,
  ) {
    const response = yield* core.workspace
      .read({ kind: "thread", thread_id: threadId })
      .pipe(Effect.mapError(titleError));
    if (
      response.value.kind !== "thread" ||
      response.value.thread.backend_binding.kind !== "codex"
    ) {
      return yield* new CodexThreadTitlePersistenceEffectError({
        cause: new Error(`Thread '${threadId}' is not owned by the native Codex backend`),
      });
    }
  });

  const project = Effect.fn("CodexThreadTitlePersistence.project")(function* (
    input: CodexThreadTitlePersistenceInput,
  ) {
    const observedAtMs = yield* Clock.currentTimeMillis;
    yield* projection.renameThread({ ...input, observedAtMs }).pipe(Effect.mapError(titleError));
    const snapshot = (yield* projection.read(input.threadId).pipe(Effect.mapError(titleError)))
      .snapshot;
    events.publish({
      kind: "hostMessage",
      value: {
        type: "threadTitleUpdated",
        hostId: DEFAULT_CODEX_HOST_ID,
        conversationId: input.threadId,
        title: input.name,
      },
    });
    if (snapshot) {
      events.publish({ kind: "codex", value: { type: "threadSummary", thread: snapshot } });
    }
  });

  const setRemote = (input: CodexThreadTitlePersistenceInput) =>
    gateway
      .requestForThread(input.threadId, "thread/name/set", input)
      .pipe(Effect.asVoid, Effect.mapError(titleError));

  const persistWorkspace = Effect.fn("CodexThreadTitlePersistence.persistWorkspace")(function* (
    input: CodexThreadTitlePersistenceInput,
  ) {
    const projectionState = yield* projection
      .read(input.threadId)
      .pipe(Effect.mapError(titleError));
    if (projectionState.snapshot?.ephemeral) return;
    const observedAtMs = yield* Clock.currentTimeMillis;
    yield* core.workspace
      .apply({
        operationId: createOperationId("thread-title.persist"),
        intent: {
          kind: "update_thread",
          thread_id: input.threadId,
          patch: { thread_name: input.name, updated_at: observedAtMs },
        },
      })
      .pipe(Effect.mapError(titleError));
    const persisted = yield* core.workspace
      .read({ kind: "thread", thread_id: input.threadId })
      .pipe(Effect.mapError(titleError));
    if (persisted.value.kind !== "thread") {
      return yield* new CodexThreadTitlePersistenceEffectError({
        cause: new Error(`Core returned a non-Thread read for '${input.threadId}'`),
      });
    }
    events.publish({
      kind: "codex",
      value: {
        type: "threadSummary",
        thread: buildCoreWorkspaceThreadSummary(persisted.value.thread),
      },
    });
    sidebar.scheduleNotification({
      notificationMethod: "thread/name/updated",
      threadId: input.threadId,
    });
  });

  const set = (
    input: CodexThreadTitleSetCommand,
  ): Effect.Effect<boolean, CodexThreadTitlePersistenceEffectError> => {
    const normalized = normalize(input);
    if (!normalized) return Effect.succeed(false);
    const persisted = { threadId: normalized.threadId, name: normalized.name };
    return runSerial(
      normalized.threadId,
      requireCodexThread(normalized.threadId).pipe(
        Effect.andThen(project(normalized)),
        Effect.andThen(
          setRemote(persisted).pipe(
            Effect.catch((error) => logFailure("app-server", persisted, error)),
            Effect.andThen(
              persistWorkspace(persisted).pipe(
                Effect.catch((error) => logFailure("project-workspace", persisted, error)),
              ),
            ),
          ),
        ),
        Effect.as(true),
      ),
    );
  };

  const setRequired = (
    input: CodexThreadTitleSetCommand,
  ): Effect.Effect<boolean, CodexThreadTitlePersistenceEffectError> => {
    const normalized = normalize(input);
    if (!normalized) return Effect.succeed(false);
    const persisted = { threadId: normalized.threadId, name: normalized.name };
    return runSerial(
      normalized.threadId,
      requireCodexThread(normalized.threadId).pipe(
        Effect.andThen(project(normalized)),
        Effect.andThen(setRemote(persisted)),
        Effect.andThen(persistWorkspace(persisted)),
        Effect.as(true),
      ),
    );
  };

  return CodexThreadTitlePersistence.of({
    set,
    setRequired,
  });
});
