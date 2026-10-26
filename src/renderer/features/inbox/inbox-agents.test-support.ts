import { vi } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { DEFAULT_INBOX_SETTINGS } from "../../../shared/inbox";
import type { InboxAgents } from "./inbox-agent-picker";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

const effort = (levels: readonly string[], currentValue: string) => ({
  id: "reasoningEffort",
  label: "Effort",
  type: "select" as const,
  currentValue,
  options: levels.map((id) => ({ id, label: id })),
});

const serviceTier = {
  id: "serviceTier",
  label: "Speed",
  type: "select" as const,
  options: [
    { id: "default", label: "Standard" },
    { id: "fast", label: "Fast" },
  ],
};

/** Codex with a default model that offers effort and speed, and a light model that offers neither. */
export const codexProvider = (): Provider => ({
  instanceId: "codex",
  displayName: "Codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-26T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6-astra",
      name: "GPT-6 Astra",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [effort(["low", "medium", "high"], "medium"), serviceTier],
      },
    },
    { slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: {} },
  ],
  slashCommands: [],
  skills: [],
});

export const CLAUDE_INSTANCE = { kind: "claude", instanceConfigId: "work" } as const;
export const CLAUDE_INSTANCE_ID = agentRuntimeProviderId(CLAUDE_INSTANCE)!;

/** A Claude account the user named `Work`, whose model offers effort but no speed tier. */
export const claudeProvider = (): Provider => ({
  ...codexProvider(),
  instanceId: CLAUDE_INSTANCE_ID,
  displayName: "Claude",
  driver: "claudeAgent",
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Opus 5.5",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [{ ...effort(["low", "high", "max"], "high"), id: "effort" }],
      },
    },
  ],
});

export const inboxAgentsFixture = (overrides: Partial<InboxAgents> = {}): InboxAgents => ({
  providers: [codexProvider(), claudeProvider()],
  state: "ready",
  readFailed: false,
  instances: [{ binding: CLAUDE_INSTANCE, label: "Work" }],
  settings: DEFAULT_INBOX_SETTINGS,
  save: vi.fn(),
  reload: vi.fn(),
  refresh: vi.fn(),
  ...overrides,
});
