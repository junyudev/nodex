import { type AgentWire, type ModelSelection } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "./agent-backend";
import { fitCodexServiceTier, normalizeCodexServiceTier } from "./codex-service-tier";

export function agentRuntimeModelSelection(
  binding: AgentBackendBinding,
  model: string,
  options?: AgentWire<ModelSelection>["options"],
): AgentWire<ModelSelection> | null {
  const { instanceId } = binding;
  if (!model.trim()) return null;
  return { instanceId, model: model.trim(), ...(options === undefined ? {} : { options }) };
}

/** The same Agent, model and option values; option order carries no meaning. */
export function agentRuntimeModelSelectionsEqual(
  left: AgentWire<ModelSelection>,
  right: AgentWire<ModelSelection>,
): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const values = (selection: AgentWire<ModelSelection>) =>
    new Map((selection.options ?? []).map((option) => [option.id, option.value]));
  const leftValues = values(left);
  const rightValues = values(right);
  return (
    leftValues.size === rightValues.size &&
    [...leftValues].every(([id, value]) => rightValues.get(id) === value)
  );
}

type AgentRuntimeProviderModel =
  import("@nodex/agent-runtime/contracts").AgentRuntimeOperations["providers.read"]["output"][number]["models"][number];
export type AgentRuntimeOptionDescriptor = NonNullable<
  NonNullable<AgentRuntimeProviderModel["capabilities"]>["optionDescriptors"]
>[number];
type AgentRuntimeOptions = NonNullable<AgentWire<ModelSelection>["options"]>;

/** The composer's provider-neutral choice: one effort level and one speed tier. */
export interface AgentRuntimeOptionIntent {
  readonly reasoningEffort?: string;
  /** Codex speed. `null` selects the standard tier. */
  readonly serviceTier?: string | null;
}

const isEffortOptionId = (id: string) => /effort|reasoning|thought|thinking/iu.test(id);

/** The model's native effort select: Codex `reasoningEffort`, Claude `effort`, Antigravity `thought_level`. */
export const isAgentRuntimeEffortOption = (
  descriptor: AgentRuntimeOptionDescriptor,
): descriptor is Extract<AgentRuntimeOptionDescriptor, { type: "select" }> =>
  descriptor.type === "select" &&
  (descriptor.role === "reasoning" || isEffortOptionId(descriptor.id));
const SERVICE_TIER_OPTION = "serviceTier";
const STANDARD_SERVICE_TIER = "default";

export function fitAgentRuntimeServiceTier(
  descriptors: readonly AgentRuntimeOptionDescriptor[],
  requested: string | null,
): string | null {
  const tiers = descriptors.find((descriptor) => descriptor.id === SERVICE_TIER_OPTION);
  return fitCodexServiceTier(
    tiers?.type === "select" ? tiers.options.map((option) => option.id) : [],
    requested,
  );
}

const admits = (descriptor: AgentRuntimeOptionDescriptor, value: string | boolean) =>
  descriptor.type === "boolean"
    ? typeof value === "boolean" && !(value && descriptor.unavailableReason)
    : descriptor.options.some((option) => option.id === value);

/**
 * Applies effort and speed intent through the model's own option ids, such as Codex
 * `reasoningEffort` and `serviceTier` or Claude `effort`. Codex speed fits the offered
 * ladder and can explicitly select Standard even on a model with no speed menu.
 */
export function applyAgentRuntimeOptionIntent(
  descriptors: readonly AgentRuntimeOptionDescriptor[],
  current: AgentWire<ModelSelection>["options"],
  intent: AgentRuntimeOptionIntent,
): AgentRuntimeOptions {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const next = new Map<string, string | boolean>();
  for (const option of current ?? []) {
    const descriptor = byId.get(option.id);
    if (
      (descriptor && admits(descriptor, option.value)) ||
      (option.id === SERVICE_TIER_OPTION && option.value === STANDARD_SERVICE_TIER)
    )
      next.set(option.id, option.value);
  }
  const choose = (descriptor: AgentRuntimeOptionDescriptor | undefined, value: string) => {
    if (!descriptor) return;
    if (admits(descriptor, value)) next.set(descriptor.id, value);
    else next.delete(descriptor.id);
  };
  if (intent.reasoningEffort !== undefined)
    choose(descriptors.find(isAgentRuntimeEffortOption), intent.reasoningEffort);
  if (intent.serviceTier !== undefined) {
    const fitted = fitAgentRuntimeServiceTier(descriptors, intent.serviceTier);
    // A model with speeds names Standard outright; one without names it only to clear a faster
    // speed carried from another model.
    if (
      fitted !== null ||
      byId.has(SERVICE_TIER_OPTION) ||
      normalizeCodexServiceTier(intent.serviceTier) !== null
    )
      next.set(SERVICE_TIER_OPTION, fitted ?? STANDARD_SERVICE_TIER);
    else next.delete(SERVICE_TIER_OPTION);
  }
  return [...next].map(([id, value]) => ({ id, value }));
}

/** The effort a selection chose: Codex `reasoningEffort`, Claude `effort`, Antigravity `thought_level` or OpenCode `variant`. */
export function readAgentRuntimeEffort(
  options: AgentWire<ModelSelection>["options"],
  descriptor?: AgentRuntimeOptionDescriptor,
): string | null {
  const value = options?.find(
    (option) =>
      typeof option.value === "string" &&
      (descriptor
        ? option.id === descriptor.id
        : isEffortOptionId(option.id) || option.id === "variant"),
  )?.value;
  return typeof value === "string" ? value : null;
}

/** The Page assignment carried by a chat handoff and its execution observations. */
export function agentRuntimeWorkSelection(selection: AgentWire<ModelSelection>) {
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    effort: readAgentRuntimeEffort(selection.options),
  };
}

/** The selected speed tier, or `null` for standard; undefined when the selection has none. */
export function readAgentRuntimeServiceTier(
  options: AgentWire<ModelSelection>["options"],
): string | null | undefined {
  const value = options?.find((option) => option.id === SERVICE_TIER_OPTION)?.value;
  return typeof value === "string" ? normalizeCodexServiceTier(value) : undefined;
}
