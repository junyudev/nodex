import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexThreadDirectory } from "./CodexThreadDirectory";

export class CodexConversationMaterializationError extends Schema.TaggedError<CodexConversationMaterializationError>()(
  "CodexConversationMaterializationError",
  {
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexConversationMaterialization extends Context.Service<
  CodexConversationMaterialization,
  {
    readonly ensure: (
      threadId: string,
    ) => Effect.Effect<void, CodexConversationMaterializationError>;
    readonly reload: (
      threadId: string,
    ) => Effect.Effect<void, CodexConversationMaterializationError>;
  }
>()("nodex/main/codex-application/CodexConversationMaterialization") {}

/**
 * Makes an app-server Thread live and installs a bounded canonical tail.
 * Commands use this before admission and for the single thread-not-found recovery retry.
 * This Module is invoked inside the Thread lane, so it uses the Directory's explicit
 * non-reentrant seam instead of calling `resolve` and reacquiring the same lane.
 */
export const make: Effect.Effect<
  CodexConversationMaterialization["Service"],
  never,
  CodexThreadDirectory | ConversationEntityMap
> = Effect.gen(function* () {
  const directory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;

  const reload = (threadId: string) =>
    directory.materializeInCurrentLane({ threadId }).pipe(
      Effect.flatMap((entry) =>
        entry?.canonical
          ? Effect.void
          : Effect.fail(
              new CodexConversationMaterializationError({
                threadId,
                cause: new Error(`Canonical materialization could not resolve '${threadId}'`),
              }),
            ),
      ),
      Effect.mapError((cause) =>
        cause instanceof CodexConversationMaterializationError
          ? cause
          : new CodexConversationMaterializationError({ threadId, cause }),
      ),
      Effect.withSpan("CodexConversationMaterialization.reload", {
        attributes: { threadId },
      }),
    );

  return CodexConversationMaterialization.of({
    ensure: (threadId) =>
      conversations.current(threadId)?.readCanonicalState()?.sidecar.hydrationContext
        ? Effect.void
        : reload(threadId),
    reload,
  });
});
