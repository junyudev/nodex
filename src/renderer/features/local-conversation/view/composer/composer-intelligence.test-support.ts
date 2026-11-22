import type { AgentIntelligenceMenu } from "@/components/shared/agent-runtime/use-agent-intelligence-menu";

export function createTestIntelligenceMenu(
  overrides: Partial<AgentIntelligenceMenu> = {},
): AgentIntelligenceMenu {
  return {
    catalog: {
      entries: [],
      selected: { binding: { driver: "codex", instanceId: "codex" }, model: "test-model" },
      loading: false,
      choose: () => {},
    },
    modelLabel: "Test model",
    models: {
      choices: [],
      loading: false,
      error: null,
      choose: async () => {},
      currentKey: "test-model",
    },
    effort: null,
    speed: null,
    fast: null,
    ultracode: null,
    thinking: null,
    effortSlider: null,
    reasoningLabel: "",
    reasoningEffort: "",
    indicators: [],
    context: null,
    configOptions: [],
    mode: null,
    hasOptions: false,
    ...overrides,
  };
}
