import type { AgentSessionConfigSelectOption } from "../../shared/agent-conversation";
import type { AgentModelOption } from "../../shared/types";

/** Adapts advertised native model controls to the shared intelligence picker presentation. */
export const projectNativeModelOption = (
  option: AgentSessionConfigSelectOption,
  isDefault = false,
  images = false,
): AgentModelOption => ({
  id: option.value,
  model: option.value,
  displayName: option.name,
  description: option.description ?? "",
  hidden: false,
  supportedReasoningEfforts: option.reasoningEfforts?.length
    ? option.reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort, description: "" }))
    : [],
  defaultReasoningEffort: "default",
  inputModalities: images ? ["text", "image"] : ["text"],
  isDefault,
});
