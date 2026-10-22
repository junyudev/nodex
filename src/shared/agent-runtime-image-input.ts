import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

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
  switch (agentRuntimeImageInputSupport(model)) {
    case "supported":
      return null;
    case "unsupported":
      return "This model does not support image attachments. Remove the images or choose a model that supports them.";
    case "unknown":
      return "This Agent has not reported image support for this model. Refresh its models or choose a model that supports images.";
  }
}
