import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexConversationContext } from "./CodexConversationContext";

export class CodexTurnAuthorityError extends Schema.TaggedError<CodexTurnAuthorityError>()(
  "CodexTurnAuthorityError",
  {
    operation: Schema.Literals(["begin", "bind", "capture"]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface CodexTurnAuthorityLaunch {
  readonly launchId: string;
  readonly snapshot: {
    readonly threadId: string;
    readonly rootThreadId: string;
    readonly actorProjectId: string | null;
    readonly libraryId: string;
    readonly profileId: string;
    readonly storeEpoch: string;
  };
  boundTurnId: string | null;
  aborted: boolean;
}

export class CodexTurnAuthority extends Context.Service<
  CodexTurnAuthority,
  {
    readonly begin: (
      threadId: string,
    ) => Effect.Effect<CodexTurnAuthorityLaunch | null, CodexTurnAuthorityError>;
    readonly bind: (
      threadId: string,
      launch: CodexTurnAuthorityLaunch | null,
      turnId: string,
    ) => Effect.Effect<void, CodexTurnAuthorityError>;
    /** Binds the oldest pending launch when app-server identifies its accepted Turn. */
    readonly observeStarted: (
      threadId: string,
      turnId: string,
    ) => Effect.Effect<void, CodexTurnAuthorityError>;
    /** Resolves the exact admitted identity, binding a racing pending launch when necessary. */
    readonly capture: (
      threadId: string,
      turnId: string,
    ) => Effect.Effect<NodexAgentTurnContext | null, CodexTurnAuthorityError>;
    readonly abort: (launch: CodexTurnAuthorityLaunch | null) => void;
  }
>()("nodex/main/codex-application/CodexTurnAuthority") {}

const normalizeIdentity = (value: string): string | null => {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
};

type CoreTurnAuthority = NonNullable<
  Extract<
    ProjectWorkspaceReadSnapshot["value"],
    { readonly kind: "turn_authority" }
  >["resolution"]["authority"]
>;

const fromCoreAuthority = (
  authority: CoreTurnAuthority,
  admittedAtMs: number,
): NodexAgentTurnContext => ({
  threadId: authority.thread_id,
  turnId: authority.turn_id,
  rootThreadId: authority.root_thread_id,
  actorProjectId: authority.actor_project_id ?? null,
  libraryId: authority.library_id,
  storeEpoch: authority.store_epoch,
  admittedAtMs,
});

/** Owns pending launches and binds the exact accepted Turn directly in Core. */
export const make: Effect.Effect<
  CodexTurnAuthority["Service"],
  never,
  CodexConversationContext | CoreAuthority | CoreModules | Scope.Scope
> = Effect.gen(function* () {
  const conversationContext = yield* CodexConversationContext;
  const coreAuthority = yield* CoreAuthority;
  const core = yield* CoreModules;
  const pendingByThreadId = new Map<string, CodexTurnAuthorityLaunch[]>();

  const removePending = (launch: CodexTurnAuthorityLaunch): void => {
    const pending = pendingByThreadId.get(launch.snapshot.threadId);
    if (!pending) return;
    const next = pending.filter((candidate) => candidate !== launch);
    if (next.length === 0) pendingByThreadId.delete(launch.snapshot.threadId);
    else pendingByThreadId.set(launch.snapshot.threadId, next);
  };

  const abort = (launch: CodexTurnAuthorityLaunch | null): void => {
    if (!launch || launch.boundTurnId) return;
    launch.aborted = true;
    removePending(launch);
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const launches of pendingByThreadId.values()) {
        for (const launch of launches) abort(launch);
      }
      pendingByThreadId.clear();
    }),
  );

  const beginWithLineage = (input: {
    readonly threadId: string;
    readonly rootThreadId: string;
    readonly actorProjectId: string | null;
  }) =>
    Effect.gen(function* () {
      const actorProjectId =
        input.actorProjectId === null ? null : normalizeIdentity(input.actorProjectId);
      const normalizedThreadId = normalizeIdentity(input.threadId);
      const rootThreadId = normalizeIdentity(input.rootThreadId);
      if (
        (input.actorProjectId !== null && actorProjectId === null) ||
        !normalizedThreadId ||
        !rootThreadId
      )
        return null;

      if (actorProjectId !== null) {
        const projectSnapshot = yield* core.workspace
          .read({ kind: "project", project_id: actorProjectId }, undefined, actorProjectId)
          .pipe(
            Effect.map((snapshot) => snapshot as typeof snapshot | null),
            Effect.catch((error) =>
              error.cause instanceof CoreModuleResponseError &&
              error.cause.coreError.code === "not_found"
                ? Effect.succeed(null)
                : Effect.fail(error),
            ),
          );
        if (projectSnapshot === null) return null;
        if (projectSnapshot.value.kind !== "project") {
          return yield* new CodexTurnAuthorityError({
            operation: "begin",
            threadId: input.threadId,
            cause: new Error("Core returned the wrong Project authority variant"),
          });
        }
        if (projectSnapshot.value.project.library_id !== coreAuthority.identity.libraryId)
          return null;
      }

      const launch: CodexTurnAuthorityLaunch = {
        launchId: createUuidV7(),
        snapshot: {
          threadId: normalizedThreadId,
          rootThreadId,
          actorProjectId,
          libraryId: coreAuthority.identity.libraryId,
          profileId: coreAuthority.identity.profileId,
          storeEpoch: coreAuthority.identity.storeEpoch,
        },
        boundTurnId: null,
        aborted: false,
      };
      const pending = pendingByThreadId.get(normalizedThreadId) ?? [];
      pending.push(launch);
      pendingByThreadId.set(normalizedThreadId, pending);
      return launch;
    });

  const begin: CodexTurnAuthority["Service"]["begin"] = (threadId) =>
    conversationContext.read(threadId).pipe(
      Effect.flatMap((lineage) =>
        beginWithLineage({
          threadId,
          rootThreadId: lineage.rootThreadId,
          actorProjectId: lineage.projectId,
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof CodexTurnAuthorityError
          ? cause
          : new CodexTurnAuthorityError({ operation: "begin", threadId, cause }),
      ),
    );

  const bind: CodexTurnAuthority["Service"]["bind"] = (threadId, launch, rawTurnId) => {
    if (!launch || launch.aborted) return Effect.void;
    const turnId = normalizeIdentity(rawTurnId);
    if (!turnId) return Effect.void;
    return Effect.gen(function* () {
      if (launch.boundTurnId && launch.boundTurnId !== turnId) {
        return yield* new CodexTurnAuthorityError({
          operation: "bind",
          threadId,
          cause: new Error(
            `Nodex Agent authority launch ${launch.launchId} is already bound to Turn ${launch.boundTurnId}`,
          ),
        });
      }
      if (!launch.boundTurnId) {
        yield* core.workspace.apply(
          {
            operationId: `electron:turn-authority:${launch.launchId}:${turnId}`,
            intent: {
              kind: "admit_turn_authority",
              thread_id: launch.snapshot.threadId,
              turn_id: turnId,
              root_thread_id: launch.snapshot.rootThreadId,
              actor_project_id: launch.snapshot.actorProjectId,
            },
          },
          undefined,
          launch.snapshot.actorProjectId,
        );
        // The Core apply receipt is the authority commit point. Verification may fail, but a
        // committed launch must never remain abortable or leak in the pending launch set.
        launch.boundTurnId = turnId;
        removePending(launch);
      }
      const snapshot = yield* core.workspace.read(
        {
          kind: "turn_authority",
          thread_id: launch.snapshot.threadId,
          turn_id: turnId,
          root_thread_id: launch.snapshot.rootThreadId,
          actor_project_id: launch.snapshot.actorProjectId,
        },
        undefined,
        launch.snapshot.actorProjectId,
      );
      if (
        snapshot.value.kind !== "turn_authority" ||
        !snapshot.value.resolution.persisted ||
        snapshot.value.resolution.authority?.turn_id !== turnId
      ) {
        return yield* new CodexTurnAuthorityError({
          operation: "bind",
          threadId,
          cause: new Error("Core did not persist the exact Turn authority"),
        });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CodexTurnAuthorityError
          ? cause
          : new CodexTurnAuthorityError({ operation: "bind", threadId, cause }),
      ),
    );
  };

  const readResolution = (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly rootThreadId: string;
    readonly actorProjectId: string | null;
  }) =>
    core.workspace
      .read(
        {
          kind: "turn_authority",
          thread_id: input.threadId,
          turn_id: input.turnId,
          root_thread_id: input.rootThreadId,
          actor_project_id: input.actorProjectId,
        },
        undefined,
        input.actorProjectId,
      )
      .pipe(
        Effect.flatMap((snapshot) =>
          snapshot.value.kind === "turn_authority"
            ? Effect.succeed(snapshot.value.resolution)
            : Effect.fail(
                new CodexTurnAuthorityError({
                  operation: "capture",
                  threadId: input.threadId,
                  cause: new Error("Core returned the wrong Turn authority read variant"),
                }),
              ),
        ),
      );

  const observeStarted: CodexTurnAuthority["Service"]["observeStarted"] = (rawThreadId, turnId) => {
    const threadId = normalizeIdentity(rawThreadId);
    if (!threadId) return Effect.void;
    const launch = pendingByThreadId.get(threadId)?.find((candidate) => !candidate.aborted);
    return bind(threadId, launch ?? null, turnId);
  };

  const capture: CodexTurnAuthority["Service"]["capture"] = (rawThreadId, rawTurnId) => {
    const threadId = normalizeIdentity(rawThreadId);
    const turnId = normalizeIdentity(rawTurnId);
    if (!threadId || !turnId) return Effect.succeed(null);
    return Effect.gen(function* () {
      const launch =
        pendingByThreadId.get(threadId)?.find((candidate) => !candidate.aborted) ?? null;
      const coordinate = launch
        ? {
            threadId,
            turnId,
            rootThreadId: launch.snapshot.rootThreadId,
            actorProjectId: launch.snapshot.actorProjectId,
          }
        : yield* conversationContext.read(threadId).pipe(
            Effect.map((lineage) => ({
              threadId,
              turnId,
              rootThreadId: lineage.rootThreadId,
              actorProjectId: lineage.projectId,
            })),
          );
      if (coordinate.actorProjectId !== null && !normalizeIdentity(coordinate.actorProjectId))
        return null;
      const resolution = yield* readResolution(coordinate);
      if (resolution.persisted) {
        return resolution.authority && resolution.admitted_at_ms != null
          ? fromCoreAuthority(resolution.authority, resolution.admitted_at_ms)
          : null;
      }
      if (!launch) return null;
      yield* bind(threadId, launch, turnId);
      const bound = yield* readResolution(coordinate);
      return bound.persisted && bound.authority && bound.admitted_at_ms != null
        ? fromCoreAuthority(bound.authority, bound.admitted_at_ms)
        : null;
    }).pipe(
      Effect.mapError(
        (cause) => new CodexTurnAuthorityError({ operation: "capture", threadId, cause }),
      ),
    );
  };

  return CodexTurnAuthority.of({ begin, bind, observeStarted, capture, abort });
});
