import type { AgentDefinition } from "./definition.ts";

export const CODEX_BINDING = { driver: "codex", instanceId: "codex" } as const;

export const codexAgent = {
  driver: CODEX_BINDING.driver,
  analyticsFamily: "codex",
  label: "Codex",
  icon: "openai",
  accent: "#8e9bff",
  modelFamilies: ["GPT-", "GPT "],
  redundantModelQualifiers: ["codex"],
  settingsAnchor: "codex",
  profileBased: false,
  registryAgentIds: ["codex-acp"],
  usageFromAccountControl: true,
  setup: {
    signIn: { via: "browser", owner: "native-account" },
    installation: { kind: "component", id: "codex" },
    firstRun: { order: 0, showWhenOff: true },
  },
  capabilities: {
    automation: { modelSource: "appServer" },
    pluginDelivery: "codex",
    insightsLedger: "codex",
    utilityModels: "codex",
    inbox: { suggestionEffort: "high" },
    nativeHistory: "codex",
    skills: "codex",
    predictions: true,
    desktopCatalogs: true,
  },
} as const satisfies AgentDefinition;
