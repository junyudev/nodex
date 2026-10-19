import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import {
  inboxDefaultSuggestionModel,
  supportsInboxStructuredGeneration,
  type InboxAgentBinding,
} from "../../shared/inbox";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { InboxRuntimeError } from "./InboxRuntimeError";

/** Explicit Inbox work waits for the configured Runtime's bounded model metadata. */
export const resolveInboxModel = Effect.fn("InboxRuntimeSelection.resolve")(function* (
  runtime: Pick<AgentRuntimeApplication["Service"], "catalog">,
  binding: InboxAgentBinding,
  requestedModel: string | null = null,
  requestedEffort?: string,
  purpose: "chat" | "suggestion" = "chat",
): Effect.fn.Return<AgentRuntimeLaunch["modelSelection"], InboxRuntimeError> {
  const instanceId = binding.instanceId;
  if (!instanceId) return yield* new InboxRuntimeError({ message: "The Agent is not configured" });
  const read = Effect.gen(function* () {
    const providers = yield* runtime.catalog();
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (
      !provider?.enabled ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.availability === "unavailable"
    )
      return yield* new InboxRuntimeError({ message: "The configured Agent is unavailable" });
    if (purpose === "suggestion" && !supportsInboxStructuredGeneration(provider))
      return yield* new InboxRuntimeError({
        message: "The configured Agent cannot generate Inbox suggestions",
      });
    // A cold boot snapshot is enabled but not yet installed/probed. Refresh owns the probe.
    if (!provider.installed || provider.models.length === 0) return null;
    const model = requestedModel
      ? provider.models.find((candidate) => candidate.slug === requestedModel)
      : purpose === "suggestion"
        ? inboxDefaultSuggestionModel(provider)
        : (provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0]);
    if (!model)
      return yield* new InboxRuntimeError({ message: "The selected model is unavailable" });
    const effort = model.capabilities?.optionDescriptors?.find(
      (option) => option.type === "select" && /effort|reasoning/i.test(option.id),
    );
    const desiredEffort =
      purpose === "suggestion"
        ? provider.driver === "claudeAgent"
          ? "low"
          : "medium"
        : requestedEffort;
    return {
      instanceId,
      model: model.slug,
      ...(desiredEffort &&
      effort?.type === "select" &&
      effort.options.some((option) => option.id === desiredEffort)
        ? { options: [{ id: effort.id, value: desiredEffort }] }
        : {}),
    } satisfies AgentRuntimeLaunch["modelSelection"];
  });
  const cached = yield* read.pipe(
    Effect.mapError((error) => new InboxRuntimeError({ message: error.message })),
  );
  if (cached) return cached;
  yield* runtime
    .catalog({ refresh: true })
    .pipe(Effect.mapError((error) => new InboxRuntimeError({ message: error.message })));
  const selection = yield* read.pipe(
    Effect.mapError((error) => new InboxRuntimeError({ message: error.message })),
    Effect.repeat({
      times: 75,
      schedule: Schedule.spaced("200 millis"),
      until: (value) => value !== null,
    }),
  );
  if (!selection)
    return yield* new InboxRuntimeError({
      message: "The Agent model catalog did not become ready",
    });
  return selection;
});
