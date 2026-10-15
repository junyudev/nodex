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
