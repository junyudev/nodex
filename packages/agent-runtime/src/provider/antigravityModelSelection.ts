import type { ServerProvider } from "@nodex/runtime-contracts";

export const advertisedModel = (
  provider: Pick<ServerProvider, "driver" | "models">,
  model: string,
) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

/** Antigravity 1.3 IDs append the thinking level (`gemini-3.8-flash-high`); the agent still accepts them. */
export function antigravitySuffixedModel(
  provider: Pick<ServerProvider, "driver" | "models">,
  model: string,
) {
  if (provider.driver !== "antigravity" || advertisedModel(provider, model)) return;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return;
  const family = model.slice(0, separator);
  const value = model.slice(separator + 1);
  const thinking = provider.models
    .find((candidate) => candidate.slug === family)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  if (thinking?.type === "select" && thinking.options.some((choice) => choice.id === value)) {
    return { model: family, thinking: { id: thinking.id, value } };
  }
}

/** Native Antigravity still accepts suffixed IDs even when only the family is advertised. */
export function antigravityModelPolicyIdentity(
  provider: Pick<ServerProvider, "driver" | "models"> | undefined,
  model: string,
): string {
  if (provider?.driver !== "antigravity") return model;
  return (
    advertisedModel(provider, model)?.slug ??
    antigravityModelFamily(
      provider.models.map((entry) => entry.slug),
      model,
    ) ??
    model
  );
}

export function antigravityModelFamily(models: ReadonlyArray<string>, model: string) {
  return models
    .filter((family) => model.startsWith(`${family}-`))
    .toSorted((left, right) => right.length - left.length)[0];
}
