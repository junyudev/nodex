import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreModules } from "../core-runtime/CoreModules";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { TurnEnvironmentParams } from "@nodex/codex-app-server-protocol/v2/TurnEnvironmentParams";
import type { CodexEnvironmentSelectionEvidence } from "../../shared/codex-conversation-state/codex-environment-selection";

export interface CodexConversationWorkspace {
  readonly projectSources: readonly string[];
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
}

export interface CodexConversationWorkspaceState {
  readonly revision: string;
  readonly applied: CodexConversationWorkspace | null;
  readonly pending: CodexConversationWorkspace | null;
}

export interface CodexConversationContextValue {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly rootThreadId: string;
  readonly projectId: string | null;
  readonly conversationCwd?: string | null;
  readonly cwd: string | null;
  readonly writableRoots: readonly string[];
  readonly workspaceState?: CodexConversationWorkspaceState | null;
  readonly environments?: readonly TurnEnvironmentParams[] | null;
  readonly environmentSelectionEvidence?: CodexEnvironmentSelectionEvidence;
}

export class CodexConversationContextError extends Schema.TaggedError<CodexConversationContextError>()(
  "CodexConversationContextError",
  {
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexConversationContext extends Context.Service<
  CodexConversationContext,
  {
    readonly read: (
      threadId: string,
    ) => Effect.Effect<CodexConversationContextValue, CodexConversationContextError>;
  }
>()("nodex/main/codex-application/CodexConversationContext") {}

const normalized = (value: string | null | undefined): string | null => {
  const result = value?.trim() ?? "";
  return result ? result : null;
};

const optionalText = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : normalized(value);

/** Null clears an assignment; only an absent value may inherit another context. */
const contextValue = (
  live: string | null | undefined,
  durable: string | null | undefined,
  ephemeral: boolean,
): string | null | undefined => {
  const preferred = ephemeral ? live : durable;
  return preferred === undefined ? (ephemeral ? durable : live) : preferred;
};

/**
 * Resolves live ephemeral topology first, then enriches it with durable execution context.
 * This is the shared lineage/workspace authority for Turn preparation and Nodex authority.
 */
export const make: Effect.Effect<
  CodexConversationContext["Service"],
  never,
  ConversationEntityMap | CoreModules
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const core = yield* CoreModules;

  const live = (threadId: string) => {
    const aggregate = conversations.current(threadId);
    const snapshot = aggregate?.readSnapshot() ?? null;
    const canonical = aggregate?.readCanonicalState() ?? null;
    return {
      generation: aggregate?.generation,
      canonical,
      ephemeral: canonical?.ephemeral ?? snapshot?.ephemeral ?? false,
      parentThreadId:
        canonical?.parentThreadId !== undefined
          ? ((canonical.sideConversation === true ? normalized(canonical.forkedFromId) : null) ??
            extractCodexThreadSubagentMetadata(canonical).parentThreadId)
          : optionalText(snapshot?.source?.parentThreadId),
      projectId:
        canonical?.workspaceKind === "projectless" ? null : optionalText(snapshot?.projectId),
      cwd:
        normalized(canonical?.cwd) ??
        normalized(snapshot?.cwd) ??
        normalized(canonical?.hydrationContext?.cwd),
    };
  };

  const readCore = <A>(
    effect: Effect.Effect<A, import("../core-runtime/CoreRuntimeError").CoreRuntimeError>,
  ) =>
    effect.pipe(
      Effect.map((value) => value as A | null),
      Effect.catch((error) =>
        error.cause instanceof CoreModuleResponseError && error.cause.coreError.code === "not_found"
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    );

  const durableThread = (threadId: string) =>
    readCore(core.workspace.read({ kind: "thread", thread_id: threadId })).pipe(
      Effect.flatMap((snapshot) => {
        if (snapshot === null) return Effect.succeed(null);
        return snapshot.value.kind === "thread"
          ? Effect.succeed(snapshot.value.thread)
          : Effect.fail(
              new CodexConversationContextError({
                threadId,
                cause: new Error("Core returned the wrong Project Workspace Thread read variant"),
              }),
            );
      }),
    );

  const executionContext = (threadId: string) =>
    readCore(core.workspace.read({ kind: "execution_context", thread_id: threadId })).pipe(
      Effect.flatMap((snapshot) => {
        if (snapshot === null) return Effect.succeed(null);
        return snapshot.value.kind === "execution_context"
          ? Effect.succeed(snapshot.value.context)
          : Effect.fail(
              new CodexConversationContextError({
                threadId,
                cause: new Error(
                  "Core returned the wrong Project Workspace execution read variant",
                ),
              }),
            );
      }),
    );

  return CodexConversationContext.of({
    read: (threadId) =>
      Effect.gen(function* () {
        const requestedThreadId = threadId.trim();
        const requestedDurable = yield* durableThread(requestedThreadId);
        const execution = yield* executionContext(requestedThreadId);
        const generations = new Map<string, number>();
        const readLive = (id: string) => {
          const current = live(id);
          if (current.generation !== undefined) generations.set(id, current.generation);
          return current;
        };
        const requestedLive = readLive(requestedThreadId);
        const parentThreadId =
          contextValue(
            requestedLive.parentThreadId,
            optionalText(requestedDurable?.parent_thread_id),
            requestedLive.ephemeral,
          ) ?? null;
        let projectId = contextValue(
          requestedLive.projectId,
          optionalText(requestedDurable?.project_id),
          requestedLive.ephemeral,
        );
        let rootThreadId = requestedThreadId;
        let cursor = parentThreadId;
        const visited = new Set([requestedThreadId]);
        while (cursor) {
          if (visited.has(cursor)) {
            rootThreadId = requestedThreadId;
            break;
          }
          visited.add(cursor);
          rootThreadId = cursor;
          const cursorDurable = yield* durableThread(cursor);
          const cursorLive = readLive(cursor);
          if (projectId === undefined) {
            projectId = contextValue(
              cursorLive.projectId,
              optionalText(cursorDurable?.project_id),
              cursorLive.ephemeral,
            );
          }
          cursor =
            contextValue(
              cursorLive.parentThreadId,
              optionalText(cursorDurable?.parent_thread_id),
              cursorLive.ephemeral,
            ) ?? null;
        }
        for (const [id, generation] of generations) {
          if (conversations.current(id)?.generation === generation) continue;
          return yield* new CodexConversationContextError({
            threadId: requestedThreadId,
            cause: new Error(`Conversation generation changed while reading context for '${id}'`),
          });
        }
        const permissions = requestedLive.canonical?.currentPermissions;
        const durableCwd = normalized(requestedDurable?.cwd);
        const baseCwd = requestedLive.ephemeral
          ? (requestedLive.cwd ?? durableCwd)
          : (durableCwd ?? requestedLive.cwd);
        const environments = requestedLive.canonical?.environments;
        const environment = environments?.[0];
        const cwd = environment?.cwd ?? baseCwd;
        const writableRoots = environment
          ? [...(environment.runtimeWorkspaceRoots ?? [environment.cwd])]
          : execution?.thread.writable_roots.length
            ? [...execution.thread.writable_roots]
            : permissions?.runtimeWorkspaceRoots?.length
              ? [...permissions.runtimeWorkspaceRoots]
              : cwd
                ? [cwd]
                : [];
        const workspaceState = execution?.workspace_state
          ? {
              revision: execution.workspace_state.revision,
              applied: execution.workspace_state.applied
                ? {
                    projectSources: [...execution.workspace_state.applied.project_sources],
                    cwd: execution.workspace_state.applied.cwd,
                    runtimeWorkspaceRoots: [
                      ...execution.workspace_state.applied.runtime_workspace_roots,
                    ],
                  }
                : null,
              pending: execution.workspace_state.pending
                ? {
                    projectSources: [...execution.workspace_state.pending.project_sources],
                    cwd: execution.workspace_state.pending.cwd,
                    runtimeWorkspaceRoots: [
                      ...execution.workspace_state.pending.runtime_workspace_roots,
                    ],
                  }
                : null,
            }
          : null;
        return {
          threadId: requestedThreadId,
          parentThreadId,
          rootThreadId,
          projectId: projectId ?? null,
          cwd,
          writableRoots,
          ...(environment || workspaceState ? { conversationCwd: baseCwd } : {}),
          ...(workspaceState ? { workspaceState } : {}),
          ...(environments !== undefined ? { environments } : {}),
          ...(requestedLive.canonical?.environmentSelectionEvidence !== undefined
            ? {
                environmentSelectionEvidence: requestedLive.canonical.environmentSelectionEvidence,
              }
            : {}),
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof CodexConversationContextError
            ? cause
            : new CodexConversationContextError({ threadId, cause }),
        ),
      ),
  });
});
