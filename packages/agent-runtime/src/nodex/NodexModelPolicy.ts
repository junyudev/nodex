import type {
  OrchestrationV2ProviderFailure,
  ProviderInstanceConfig,
  ServerProvider,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

/** A declaration constrains every catalog consumer, including native application tools. */
export function constrainProviderCatalog(
  snapshot: ServerProvider,
  declaration: ProviderInstanceConfig,
): ServerProvider {
  if (!declaration.modelAllowlist && !declaration.source) return snapshot;
  const allowed = declaration.modelAllowlist;
  return {
    ...snapshot,
    ...(declaration.source ? { source: declaration.source } : {}),
    ...(allowed
      ? {
          models: snapshot.models.filter((model) => allowed.includes(model.slug)),
          updateRequiredModels: (snapshot.updateRequiredModels ?? []).filter((model) =>
            allowed.includes(model.slug),
          ),
        }
      : {}),
    ...(declaration.source === "nodex"
      ? { setup: { canAuthenticate: false, canInstall: false } }
      : {}),
  };
}

export function nodexCreditFailure(
  instanceId: string,
  failure: OrchestrationV2ProviderFailure,
): OrchestrationV2ProviderFailure {
  if (!instanceId.startsWith("nodex_")) return failure;
  if (
    !/(?:insufficient[\s_-]*(?:user[\s_-]*)?(?:balance|credit|quota)|(?:balance|credit)[\s\S]{0,40}(?:exhausted|insufficient|too low)|payment[\s_-]*required|余额不足)/iu.test(
      `${failure.code ?? ""} ${failure.message}`,
    )
  )
    return failure;
  return {
    ...failure,
    message: "Nodex credit is exhausted. Top up in Settings → Account, then retry.",
    retryable: false,
  };
}

export function nodexProviderEvent(
  instanceId: string,
  event: ProviderAdapterV2Event,
): ProviderAdapterV2Event {
  if (event.type === "turn.terminal" && event.status === "failed")
    return { ...event, failure: nodexCreditFailure(instanceId, event.failure) };
  if (event.type === "turn_item.updated" && event.turnItem.type === "error")
    return {
      ...event,
      turnItem: {
        ...event.turnItem,
        failure: nodexCreditFailure(instanceId, event.turnItem.failure),
      },
    };
  return event;
}
