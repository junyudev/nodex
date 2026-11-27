import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { InboxSettings } from "../../shared/inbox";
import type { CoreInboxDispatchContext } from "../../main/core-client/inbox-adapter";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { inboxAgentCandidates, inboxDefaultChatCandidate } from "./inbox-agent-candidates";
import { resolveInboxModel } from "./InboxRuntimeSelection";

export interface InboxRoutingOriginChat {
  readonly session_id: string;
  readonly title: string | null;
  readonly project_id: string | null;
  readonly exists: boolean | null;
  readonly archived: boolean | null;
  readonly state: "idle" | "working" | null;
  readonly can_fork: boolean;
  readonly workspace_exists: boolean | null;
  readonly has_git: boolean | null;
}

/** Origins are looked up by captured Session identity, even outside the ranked chat window. */
export const makeOriginChats = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  return Effect.fn("InboxRoutingContext.origins")(function* (context: CoreInboxDispatchContext) {
    const ids = new Set(
      context.entries.flatMap(({ source }) =>
        source.kind === "agent" && source.session_id ? [source.session_id] : [],
      ),
    );
    const origins = yield* Effect.forEach(
      ids,
      (session_id) =>
        runtime.inboxOriginChat(session_id).pipe(
          Effect.timeout("3 seconds"),
          Effect.result,
          Effect.map((result): InboxRoutingOriginChat => {
            const facts = result._tag === "Success" ? result.success : null;
            return {
              session_id,
              exists: result._tag === "Success" ? facts !== null : null,
              title: facts?.title.slice(0, 120) ?? null,
              project_id: facts?.project_id ?? null,
              archived: facts?.archived ?? null,
              state: facts?.state ?? null,
              can_fork: facts?.can_fork ?? false,
              workspace_exists: facts?.workspace_exists ?? null,
              has_git: facts?.has_git ?? null,
            };
          }),
        ),
      { concurrency: 4 },
    );
    return new Map(origins.map((chat) => [chat.session_id, chat]));
  });
});

/** Pickup and tool submission use one offered-model and provenance policy. */
export const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  return Effect.fn("InboxRoutingContext.prepare")(function* (current: InboxSettings) {
    const modelSelection = yield* resolveInboxModel(runtime, current.suggestionAgent, "suggestion");
    const providers = yield* runtime.catalog();
    const provider = providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    );
    const defaultChat = inboxDefaultChatCandidate(providers, current.chatAgent);
    const agents = current.suggestionsChooseModels
      ? {
          candidates: inboxAgentCandidates(providers, {
            now: yield* Clock.currentTimeMillis,
            useModelGuide: current.useModelGuide,
          }),
          defaultChat,
        }
      : null;
    return {
      modelSelection,
      defaultChat,
      agents,
      producedBy: [
        provider?.displayName ?? modelSelection.instanceId,
        provider?.models.find((model) => model.slug === modelSelection.model)?.name ??
          modelSelection.model,
      ]
        .join(" · ")
        .slice(0, 256),
    };
  });
});
