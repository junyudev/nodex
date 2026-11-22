import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import type * as Effect from "effect/Effect";
import type { AgentProfile } from "../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../shared/agents/registry";
import type { MainConfig } from "../app/MainConfig";
import type { HostShellEnvironment } from "../host-runtime/HostShellEnvironment";

export type ProfileProviderDeclaration = AgentRuntimeConfiguration["providers"][string];

export interface ProfileProviderContext {
  readonly config: Pick<
    MainConfig["Service"],
    "homeDirectory" | "platform" | "profileSettingsPath"
  >;
  readonly environment: NodeJS.ProcessEnv;
  readonly shell: HostShellEnvironment["Service"];
}

export interface ProfileProviderSecrets {
  readonly environment: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

export type ProfileProviderBuilder<Driver extends ProfileAgentDriver> = (
  profile: AgentProfile<Driver>,
  launch: ProfileProviderSecrets | null,
  host: ProfileProviderContext,
) => Effect.Effect<ProfileProviderDeclaration>;

export const profileProviderEnvironment = (
  profile: AgentProfile,
  resolved: Readonly<Record<string, string>>,
) =>
  Object.entries(resolved).map(([name, value]) => ({
    name,
    value,
    sensitive:
      profile.environment?.some((entry) => entry.name === name && entry.sensitive) ?? false,
  }));
