import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export class NativeTurnAuthorityError extends Schema.TaggedError<NativeTurnAuthorityError>()(
  "NativeTurnAuthorityError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type CoreAuthorityResolution = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "turn_authority" }
>["resolution"];

export const projectFrozenNativeTurnAuthority = (
  resolution: CoreAuthorityResolution,
): FrozenNodexAgentTurnAuthority | null => {
  if (!resolution.persisted || !resolution.authority || resolution.frozen_at_ms == null)
    return null;
  const authority = resolution.authority;
  const coordinates = {
    threadId: authority.thread_id,
    turnId: authority.turn_id,
    rootThreadId: authority.root_thread_id,
    libraryId: authority.library_id,
    storeEpoch: authority.store_epoch,
    source: authority.source,
    readOnly: resolution.read_only,
    frozenAtMs: resolution.frozen_at_ms,
  };
  if (authority.scope === "library")
    return { ...coordinates, scope: "library", actorProjectId: authority.actor_project_id ?? null };
  if (authority.actor_project_id == null) return null;
  return { ...coordinates, scope: "project", actorProjectId: authority.actor_project_id };
};

export class NativeTurnAuthority extends Context.Service<
  NativeTurnAuthority,
  {
    readonly freeze: (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly projectId: string | null;
      readonly readOnly: boolean;
    }) => Effect.Effect<FrozenNodexAgentTurnAuthority | null, NativeTurnAuthorityError>;
  }
>()("nodex/main/agent-backend/NativeTurnAuthority") {}

/** Core verifies persisted Project selection, topology, and the exact accepted Turn coordinate. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const workspace = yield* ProjectWorkspace;
  return NativeTurnAuthority.of({
    freeze: (input) =>
      Effect.gen(function* () {
        if (!input.threadId.trim() || !input.turnId.trim()) return null;
        const context = yield* workspace.readThreadExecutionContext(input.threadId);
        const thread = yield* workspace.getThread(input.threadId);
        if (
          !context ||
          !thread ||
          thread.archived ||
          thread.backendBinding.kind !== "claude" ||
          context.projectId !== input.projectId
        )
          return yield* new NativeTurnAuthorityError({
            operation: "freeze",
            cause: new Error("Native authority Thread context changed"),
          });
        let rootThreadId = input.threadId;
        let ancestor = thread;
        const visited = new Set<string>([rootThreadId]);
        while (ancestor.parentThreadId) {
          if (visited.size >= 128 || visited.has(ancestor.parentThreadId))
            return yield* new NativeTurnAuthorityError({
              operation: "freeze",
              cause: new Error("Native authority lineage is invalid"),
            });
          const parent = yield* workspace.getThread(ancestor.parentThreadId);
          if (!parent || parent.projectId !== input.projectId)
            return yield* new NativeTurnAuthorityError({
              operation: "freeze",
              cause: new Error("Native authority parent is unavailable"),
            });
          rootThreadId = parent.threadId;
          visited.add(rootThreadId);
          ancestor = parent;
        }
        const read = () =>
          core.workspace
            .read(
              {
                kind: "turn_authority",
                thread_id: input.threadId,
                turn_id: input.turnId,
                root_thread_id: rootThreadId,
                actor_project_id: input.projectId,
              },
              undefined,
              input.projectId,
            )
            .pipe(
              Effect.flatMap((snapshot) =>
                snapshot.value.kind === "turn_authority"
                  ? Effect.succeed(projectFrozenNativeTurnAuthority(snapshot.value.resolution))
                  : Effect.fail(
                      new NativeTurnAuthorityError({
                        operation: "read",
                        cause: new Error("Core returned another authority variant"),
                      }),
                    ),
              ),
            );
        if (input.projectId === null && context.permissionMode !== "full-access") return null;
        const source =
          context.permissionMode === "full-access" ? "builtin_full_access" : "project_turn";
        const existing = yield* read();
        // Operation replay returns its admission receipt before reaching this boundary.
        if (existing)
          return yield* new NativeTurnAuthorityError({
            operation: "freeze",
            cause: new Error("The Turn ID already belongs to an accepted native input"),
          });
        yield* core.workspace.apply(
          {
            operationId: createBoundedOperationId("agent.turn-authority"),
            intent: {
              kind: "freeze_turn_authority",
              thread_id: input.threadId,
              turn_id: input.turnId,
              root_thread_id: rootThreadId,
              actor_project_id: input.projectId,
              source,
              read_only: input.readOnly,
            },
          },
          undefined,
          input.projectId,
        );
        const frozen = yield* read();
        if (!frozen)
          return yield* new NativeTurnAuthorityError({
            operation: "freeze",
            cause: new Error("Core did not persist native authority"),
          });
        return frozen;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof NativeTurnAuthorityError
            ? cause
            : new NativeTurnAuthorityError({ operation: "freeze", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(NativeTurnAuthority, make);
