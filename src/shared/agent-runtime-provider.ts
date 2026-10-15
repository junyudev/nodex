import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { AgentWire, ModelSelection } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "./agent-backend";

/** Provider keys are shared by desktop configuration and model selection. */
export function agentRuntimeProviderId(binding: AgentBackendBinding): string | null {
  if (binding.kind === "codex") return "codex";
  const id = binding.instanceConfigId;
  if (!id || id.trim() !== id || id.length > 128) return null;
  const digest = sha256(utf8ToBytes(JSON.stringify([binding.kind, id])));
  const encoded = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${binding.kind}_${encoded}`;
}

export function agentRuntimeModelSelection(
  binding: AgentBackendBinding,
  model: string,
  options?: AgentWire<ModelSelection>["options"],
): AgentWire<ModelSelection> | null {
  const instanceId = agentRuntimeProviderId(binding);
  if (!instanceId || !model.trim()) return null;
  return { instanceId, model: model.trim(), ...(options === undefined ? {} : { options }) };
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
  /** `null` selects the standard tier. */
  readonly serviceTier?: string | null;
}

/** Codex calls it `reasoningEffort`, Claude `effort`; both are the model's effort select. */
export const isAgentRuntimeEffortOption = (descriptor: AgentRuntimeOptionDescriptor): boolean =>
  descriptor.type === "select" && /effort|reasoning/iu.test(descriptor.id);
const SERVICE_TIER_OPTION = "serviceTier";
const STANDARD_SERVICE_TIER = "default";

const admits = (descriptor: AgentRuntimeOptionDescriptor, value: string | boolean) =>
  descriptor.type === "boolean"
    ? typeof value === "boolean"
    : descriptor.options.some((option) => option.id === value);

/**
 * Applies effort and speed intent through the model's own option ids, such as Codex
 * `reasoningEffort` and `serviceTier` or Claude `effort`. Options the model does not declare,
 * or values it does not offer, are dropped so the model's default applies instead.
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
    if (descriptor && admits(descriptor, option.value)) next.set(option.id, option.value);
  }
  const choose = (descriptor: AgentRuntimeOptionDescriptor | undefined, value: string) => {
    if (!descriptor) return;
    if (admits(descriptor, value)) next.set(descriptor.id, value);
    else next.delete(descriptor.id);
  };
  if (intent.reasoningEffort !== undefined)
    choose(descriptors.find(isAgentRuntimeEffortOption), intent.reasoningEffort);
  if (intent.serviceTier !== undefined)
    choose(
      byId.get(SERVICE_TIER_OPTION),
      intent.serviceTier === null ? STANDARD_SERVICE_TIER : intent.serviceTier,
    );
  return [...next].map(([id, value]) => ({ id, value }));
}

/** The selected speed tier, or `null` for standard; undefined when the selection has none. */
export function readAgentRuntimeServiceTier(
  options: AgentWire<ModelSelection>["options"],
): string | null | undefined {
  const value = options?.find((option) => option.id === SERVICE_TIER_OPTION)?.value;
  if (typeof value !== "string") return undefined;
  return value === STANDARD_SERVICE_TIER ? null : value;
}
