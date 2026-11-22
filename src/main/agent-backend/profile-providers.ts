import { antigravityAgent } from "../../shared/agents/antigravity";
import { claudeAgent } from "../../shared/agents/claude";
import { openCodeAgent } from "../../shared/agents/opencode";
import type { AgentProfile } from "../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../shared/agents/registry";
import { antigravityProfileProvider } from "./antigravity/AntigravityProfileProvider";
import { claudeProfileProvider } from "./claude/ClaudeProfileProvider";
import { openCodeProfileProvider } from "./opencode/OpenCodeProfileProvider";
import type {
  ProfileProviderBuilder,
  ProfileProviderContext,
  ProfileProviderSecrets,
} from "./profile-provider-types";

const builders: { [Driver in ProfileAgentDriver]: ProfileProviderBuilder<Driver> } = {
  [claudeAgent.driver]: claudeProfileProvider,
  [openCodeAgent.driver]: openCodeProfileProvider,
  [antigravityAgent.driver]: antigravityProfileProvider,
};

export const buildAgentProfileProvider = <Driver extends ProfileAgentDriver>(
  profile: AgentProfile<Driver> & { readonly driver: Driver },
  launch: ProfileProviderSecrets | null,
  context: ProfileProviderContext,
) => builders[profile.driver](profile, launch, context);
