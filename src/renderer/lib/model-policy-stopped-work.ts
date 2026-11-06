import { isModelOn, type ModelPolicy, type PolicyProvider } from "../../shared/model-policy";

export interface CreditWork {
  /** The chat the work belongs to; subagents of one chat count once. */
  readonly rootThreadId: string;
  readonly instanceId: string;
  readonly model: string;
}

interface CreditProvider extends PolicyProvider {
  readonly models: readonly { readonly slug: string; readonly name: string }[];
}

export interface StoppedCreditWork {
  readonly chats: number;
  /** The models that work runs on, by name. */
  readonly models: readonly string[];
  /** Whether a chat stops although its own model stays on. */
  readonly stopsAllowedModels: boolean;
}

/**
 * What a policy change would stop, so the person can be asked first. Claude applies restrictions
 * per process, so narrowing any Nodex Claude model restarts every Claude chat on that instance.
 */
export function creditWorkStoppedBy(input: {
  readonly work: readonly CreditWork[];
  readonly providers: readonly CreditProvider[];
  readonly current: ModelPolicy;
  readonly next: ModelPolicy;
}): StoppedCreditWork | null {
  const { work, providers, current, next } = input;
  const providerOf = (instanceId: string) =>
    providers.find((provider) => provider.instanceId === instanceId);
  const narrowsClaude = (provider: CreditProvider) =>
    provider.driver === "claudeAgent" &&
    provider.models.some(
      ({ slug }) => isModelOn(current, provider, slug) && !isModelOn(next, provider, slug),
    );
  const stopped = work.flatMap((item) => {
    const provider = providerOf(item.instanceId);
    if (!provider) return [];
    const ownModelOff = !isModelOn(next, provider, item.model);
    return ownModelOff || narrowsClaude(provider) ? [{ item, provider, ownModelOff }] : [];
  });
  if (stopped.length === 0) return null;
  return {
    chats: new Set(stopped.map(({ item }) => item.rootThreadId)).size,
    models: [
      ...new Set(
        stopped.map(
          ({ item, provider }) =>
            provider.models.find(({ slug }) => slug === item.model)?.name ?? item.model,
        ),
      ),
    ],
    stopsAllowedModels: stopped.some(({ ownModelOff }) => !ownModelOff),
  };
}
