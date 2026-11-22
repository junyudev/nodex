import { claudeAgent } from "./claude.ts";
import { openCodeAgent } from "./opencode.ts";
import { antigravityAgent } from "./antigravity.ts";
import { createAgentProfile, type AgentProfile } from "./profiles.ts";

export const claudeProfile = (
  overrides: Partial<AgentProfile<typeof claudeAgent.driver>> = {},
): AgentProfile<typeof claudeAgent.driver> => ({
  ...createAgentProfile(claudeAgent, claudeAgent.profile.initialId),
  ...overrides,
});

export const openCodeProfile = (
  overrides: Partial<AgentProfile<typeof openCodeAgent.driver>> = {},
): AgentProfile<typeof openCodeAgent.driver> => ({
  ...createAgentProfile(openCodeAgent, openCodeAgent.profile.initialId),
  ...overrides,
});

export const antigravityProfile = (
  overrides: Partial<AgentProfile<typeof antigravityAgent.driver>> = {},
): AgentProfile<typeof antigravityAgent.driver> => ({
  ...createAgentProfile(antigravityAgent, "antigravity-test"),
  ...overrides,
});
