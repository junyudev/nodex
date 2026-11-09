import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { InboxSettings } from "../../shared/inbox";
import { inboxAgentCandidates, inboxDefaultChatCandidate } from "./inbox-agent-candidates";
import { resolveInboxModel } from "./InboxRuntimeSelection";

/** Pickup and tool submission use one offered-model and provenance policy. */
export const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  return Effect.fn("InboxRoutingContext.prepare")(function* (current: InboxSettings) {
    const modelSelection = yield* resolveInboxModel(runtime, current.suggestionAgent, "suggestion");
    const providers = yield* runtime.catalog();
    const provider = providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    );
    const agents = current.suggestionsChooseModels
      ? {
          candidates: inboxAgentCandidates(providers, {
            now: yield* Clock.currentTimeMillis,
            useModelGuide: current.useModelGuide,
          }),
          defaultChat: inboxDefaultChatCandidate(providers, current.chatAgent),
        }
      : null;
    return {
      modelSelection,
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
