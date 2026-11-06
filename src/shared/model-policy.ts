import { z } from "zod";

/** Profile authority. Entries are exceptions, so newly advertised models follow their provider. */
export const ModelPolicySchema = z
  .object({
    providersOff: z.array(z.string().min(1)).max(4096),
    exceptions: z.array(z.string().min(1)).max(65536),
    agentsMayChooseCredit: z.boolean(),
  })
  .strict();
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  providersOff: [],
  exceptions: [],
  agentsMayChooseCredit: false,
};
export const MODEL_POLICY_CHANGED_CHANNEL = "model-policy-changed";
export interface PolicyProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly source?: string | undefined;
  readonly displayName?: string | null | undefined;
}
export type ModelPolicyOrigin = "person" | "nodex-agent" | "agent" | "automatic";
export const spendsNodexCredit = (provider: PolicyProvider): boolean =>
  provider.source === "nodex" || provider.instanceId.startsWith("nodex_");
/** Nodex has one master switch; model identities include the protocol, never the account hash. */
export const policyProviderKey = (provider: PolicyProvider): string =>
  spendsNodexCredit(provider) ? "nodex" : provider.instanceId;
export const policyModelKey = (provider: PolicyProvider, model: string): string =>
  JSON.stringify([
    policyProviderKey(provider),
    ...(spendsNodexCredit(provider) ? [provider.driver] : []),
    model,
  ]);
export const isProviderOn = (policy: ModelPolicy, provider: PolicyProvider): boolean =>
  !policy.providersOff.includes(policyProviderKey(provider));
const onByDefault = (provider: PolicyProvider, model: string): boolean =>
  !["opencode", "opencode2"].includes(provider.driver) || model.endsWith("-free");
export const isModelSwitchOn = (
  policy: ModelPolicy,
  provider: PolicyProvider,
  model: string,
): boolean =>
  onByDefault(provider, model) !== policy.exceptions.includes(policyModelKey(provider, model));
export const isModelOn = (policy: ModelPolicy, provider: PolicyProvider, model: string): boolean =>
  isProviderOn(policy, provider) && isModelSwitchOn(policy, provider, model);
export function setModelOn(
  policy: ModelPolicy,
  provider: PolicyProvider,
  model: string,
  on: boolean,
): ModelPolicy {
  const key = policyModelKey(provider, model);
  const others = policy.exceptions.filter((entry) => entry !== key);
  return { ...policy, exceptions: on === onByDefault(provider, model) ? others : [...others, key] };
}
export function setProviderOn(
  policy: ModelPolicy,
  provider: PolicyProvider,
  on: boolean,
): ModelPolicy {
  const key = policyProviderKey(provider);
  const others = policy.providersOff.filter((entry) => entry !== key);
  return { ...policy, providersOff: on ? others : [...others, key] };
}
export function modelPolicyFailure(
  policy: ModelPolicy,
  provider: PolicyProvider,
  model: string,
  origin: ModelPolicyOrigin = "person",
  label = model,
): {
  readonly code: "model_off" | "credit_requires_person";
  readonly message: string;
  readonly retryable: false;
} | null {
  if (!isModelOn(policy, provider, model))
    return {
      code: "model_off",
      message: `${label} on ${spendsNodexCredit(provider) ? "Nodex" : (provider.displayName ?? provider.instanceId)} is off in Settings → Models. Choose another model.`,
      retryable: false,
    };
  if (
    spendsNodexCredit(provider) &&
    (origin === "automatic" || (origin === "agent" && !policy.agentsMayChooseCredit))
  )
    return {
      code: "credit_requires_person",
      message: "Only the person can start Nodex models. Choose another provider.",
      retryable: false,
    };
  return null;
}
export const canStartModel = (
  policy: ModelPolicy,
  provider: PolicyProvider,
  model: string,
  origin: ModelPolicyOrigin,
): boolean => modelPolicyFailure(policy, provider, model, origin) === null;
export const sameModelPolicy = (left: ModelPolicy, right: ModelPolicy): boolean =>
  left.agentsMayChooseCredit === right.agentsMayChooseCredit &&
  JSON.stringify([...left.providersOff].sort()) ===
    JSON.stringify([...right.providersOff].sort()) &&
  JSON.stringify([...left.exceptions].sort()) === JSON.stringify([...right.exceptions].sort());

/** A full renderer catalog retains off rows. Automatic consumers use this projection. */
export function projectModelPolicyCatalog<
  P extends PolicyProvider & { readonly models: readonly { readonly slug: string }[] },
>(providers: readonly P[], policy: ModelPolicy) {
  return providers.map((provider) => ({
    ...provider,
    policy: { key: policyProviderKey(provider), on: isProviderOn(policy, provider) },
    models: provider.models.map((model) => ({
      ...model,
      policy: {
        on: isModelOn(policy, provider, model.slug),
        switchOn: isModelSwitchOn(policy, provider, model.slug),
        spendsCredit: spendsNodexCredit(provider),
      },
    })),
  }));
}
export const modelIsOn = (model: {
  readonly policy?: { readonly on: boolean } | undefined;
}): boolean => model.policy?.on !== false;
export function automaticModelCatalog<
  P extends PolicyProvider & {
    readonly models: readonly {
      readonly slug: string;
      readonly policy?: { readonly on: boolean } | undefined;
    }[];
  },
>(providers: readonly P[]): P[] {
  return providers
    .filter((provider) => !spendsNodexCredit(provider))
    .map((provider) => ({ ...provider, models: provider.models.filter(modelIsOn) }));
}

/** Preserve the two actionable, non-retryable policy failures through transport wrappers. */
export function readModelPolicyFailure(error: unknown): {
  readonly code: "model_off" | "credit_requires_person";
  readonly message: string;
  readonly retryable: false;
} | null {
  try {
    let current = error;
    for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
      if (
        "code" in current &&
        (current.code === "model_off" || current.code === "credit_requires_person") &&
        "message" in current &&
        typeof current.message === "string"
      )
        return { code: current.code, message: current.message, retryable: false };
      current = "cause" in current ? current.cause : null;
    }
  } catch {
    return null;
  }
  return null;
}
