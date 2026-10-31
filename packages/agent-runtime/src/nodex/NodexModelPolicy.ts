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

const platformUnavailable =
  /insufficient[\s_-]*(?:account[\s_-]*)?(?:quota|balance)|exceeded your current quota|credit balance is too low|billing|payment[\s_-]*required|no available accounts?|overloaded|rate[\s_-]*limit|too many requests|service unavailable|bad gateway|gateway timeout|\b(?:429|5\d\d)\b|network|fetch failed|socket|connection|ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed? ?out/iu;

export function nodexCreditFailure(
  instanceId: string,
  failure: OrchestrationV2ProviderFailure,
): OrchestrationV2ProviderFailure {
  if (!instanceId.startsWith("nodex_")) return failure;
  if (failure.code === "nodex_credit_exhausted" || failure.code === "nodex_unavailable")
    return failure;
  const exhausted =
    failure.code === "INSUFFICIENT_BALANCE" ||
    /"code"\s*:\s*"INSUFFICIENT_BALANCE"/u.test(failure.message) ||
    /\b403[\s:–-]+insufficient (?:account )?balance\b/iu.test(failure.message);
  // Everything else that is ours or upstream's (supply, outage, transport) reads as unavailable;
  // request-specific failures such as an oversized prompt keep their own message.
  if (!exhausted && !platformUnavailable.test(`${failure.code ?? ""} ${failure.message}`))
    return failure;
  return {
    ...failure,
    code: exhausted ? "nodex_credit_exhausted" : "nodex_unavailable",
    message: exhausted
      ? "Nodex credit is exhausted. Top up in Settings → Account, then retry."
      : "Nodex models are temporarily unavailable. Try again later.",
    retryable: !exhausted,
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
