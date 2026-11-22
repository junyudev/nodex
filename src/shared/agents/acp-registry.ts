import type { AgentDefinition } from "./definition.ts";

export const acpRegistryAgent = {
  driver: "acpRegistry",
  analyticsFamily: "acp",
  label: "Agent",
  conversationLabel: null,
  settingsAnchor: "acp",
  profileAnchorPrefix: "acp-agent-",
  profileBased: true,
  setup: { signIn: { via: "dialog" }, models: "discover" },
  capabilities: { automation: { modelSource: "discovery" }, pluginDelivery: "acp" },
} as const satisfies AgentDefinition;
