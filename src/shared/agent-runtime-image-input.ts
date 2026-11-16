import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { defineMessages } from "./i18n/messages";

export const AGENT_RUNTIME_IMAGE_INPUT_MESSAGES = defineMessages({
  unsupported: {
    id: "shared.agentRuntimeImageInput.unsupported",
    defaultMessage:
      "This model does not support image attachments. Remove the images or choose a model that supports them.",
  },
  unknown: {
    id: "shared.agentRuntimeImageInput.unknown",
    defaultMessage:
      "This Agent has not reported image support for this model. Refresh its models or choose a model that supports images.",
  },
});

type RuntimeModel = AgentRuntimeOperations["providers.read"]["output"][number]["models"][number];

/** An unchecked model is different from one that explicitly accepts only text. */
export function agentRuntimeImageInputSupport(
  model: RuntimeModel | undefined,
): "supported" | "unsupported" | "unknown" {
  const modalities = model?.capabilities?.inputModalities;
  return modalities === undefined
    ? "unknown"
    : modalities.includes("image")
      ? "supported"
      : "unsupported";
}

export function agentRuntimeImageInputUnavailableReason(
  model: RuntimeModel | undefined,
): string | null {
  return agentRuntimeImageInputUnavailableMessage(model)?.defaultMessage ?? null;
}

export function agentRuntimeImageInputUnavailableMessage(model: RuntimeModel | undefined) {
  const support = agentRuntimeImageInputSupport(model);
  return support === "supported" ? null : AGENT_RUNTIME_IMAGE_INPUT_MESSAGES[support];
}
