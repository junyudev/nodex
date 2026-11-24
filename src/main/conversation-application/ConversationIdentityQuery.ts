import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { nativeConversationIdentity } from "../codex-application/CodexConversationIdentity";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { ApplicationSettings } from "../settings/ApplicationSettings";

export class ConversationIdentityError extends Schema.TaggedError<ConversationIdentityError>()(
  "ConversationIdentityError",
  { cause: Schema.Defect() },
) {}

export class ConversationIdentityQuery extends Context.Service<
  ConversationIdentityQuery,
  {
    readonly resolve: (
      threadId: string,
    ) => Effect.Effect<ConversationIdentity | null, ConversationIdentityError>;
  }
>()("nodex/main/conversation-application/ConversationIdentityQuery") {}

export const make = Effect.gen(function* () {
  const native = yield* CodexThreadDirectory;
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;
  const resolve = Effect.fn("ConversationIdentityQuery.resolve")(
    function* (threadId: string): Effect.fn.Return<ConversationIdentity | null, unknown> {
      const id = threadId.trim();
      if (!id || id.length > 512) return null;

      // No host is supplied: only an existing Core-owned native Thread can resolve here.
      // Naming a reference must never discover, import or resume an arbitrary conversation.
      const registered = yield* native.resolve({ threadId: id, fidelity: "durable" });
      if (registered) {
        const hostId = registered.summary.executionHostId ?? DEFAULT_CODEX_HOST_ID;
        const hosts =
          hostId === DEFAULT_CODEX_HOST_ID
            ? null
            : yield* settings.snapshot().pipe(
                Effect.map((snapshot) => snapshot.executionHosts),
                Effect.catch(() => Effect.succeed(null)),
              );
        return nativeConversationIdentity(registered.summary, hosts);
      }

      // Runtime owns roots and descendants, resolves their lineage and validates the binding.
      // A missing binding or an unavailable Runtime never becomes a native discovery request.
      return yield* runtime.identify(id);
    },
    Effect.mapError((cause) => new ConversationIdentityError({ cause })),
  );
  return ConversationIdentityQuery.of({ resolve });
});

export const live = Layer.effect(ConversationIdentityQuery, make);
