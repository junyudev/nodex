import type { AgentModelCatalog } from "../../shared/agent-model-catalog";
import type { AgentModelOption } from "../../shared/types";

export const catalogModel = (id: string, displayName = id): AgentModelOption => ({
  id,
  model: id,
  displayName,
  description: "",
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "none",
  inputModalities: ["text"],
  multiAgentVersion: null,
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: false,
});
export const modelCatalog = (overrides: Partial<AgentModelCatalog> = {}): AgentModelCatalog => ({
  binding: { kind: "opencode", instanceConfigId: "local" },
  models: [catalogModel("moonshot/kimi-k3", "Kimi K3"), catalogModel("local/small", "Small")],
  configOptions: [],
  modes: null,
  health: { status: "ready", error: null },
  defaultModel: "moonshot/kimi-k3",
  ...overrides,
});
