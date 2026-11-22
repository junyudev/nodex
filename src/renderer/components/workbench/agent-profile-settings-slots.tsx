import { useIntl } from "@/lib/i18n";
import type { ReactNode } from "react";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import { claudeAgent } from "../../../shared/agents/claude";
import { openCodeAgent } from "../../../shared/agents/opencode";
import type { AgentProfile, AgentProfileInput } from "../../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../../shared/agents/registry";
import { AntigravityAccountRow } from "../../features/agent-account/antigravity-account-row";
import {
  AntigravityProfileExecutable,
  AntigravityRuntimeRow,
} from "../../features/antigravity-runtime/antigravity-runtime-status";
import { OpenCodeExecutableStatus } from "../../features/opencode-setup/opencode-executable-status";
import { openCodeSetupOwner } from "../../features/opencode-setup/use-opencode-setup";
import type { AgentEnvironmentDraft } from "../../lib/agent-environment-editor";
import { NodexSettingsRow } from "../ui/settings";
import { ClaudeCustomModelsEditor } from "./claude-custom-models-editor";

export type EditableAgentProfile = AgentProfileInput & { readonly savedSecrets: readonly string[] };

interface ProfileSettingsSlots {
  readonly sharedRuntime?: (input: { open: boolean; profileCount: number }) => ReactNode;
  readonly account?: (input: { saved: AgentProfile | null }) => ReactNode;
  readonly bespokeEditors?: (input: {
    draft: EditableAgentProfile;
    disabled: boolean;
    change: (profile: EditableAgentProfile) => void;
  }) => ReactNode;
  readonly executableStatus?: (input: {
    saved: AgentProfile | null;
    draft: EditableAgentProfile;
    environment: readonly AgentEnvironmentDraft[];
    open: boolean;
  }) => ReactNode;
}

function AntigravityProfileAccount({ saved }: { saved: AgentProfile | null }) {
  const intl = useIntl();
  if (saved?.driver === antigravityAgent.driver && saved.enabled) {
    return (
      <AntigravityAccountRow
        backend={{ driver: saved.driver, instanceId: saved.id }}
        authMethod={saved.settings.authMethod}
      />
    );
  }
  return (
    <NodexSettingsRow
      variant="nested"
      label={intl.formatMessage({ id: "settings.antigravity.account", defaultMessage: "Account" })}
      description={
        saved
          ? intl.formatMessage({
              id: "settings.antigravity.account.turnOnFirst",
              defaultMessage: "Turn this profile on to sign in.",
            })
          : intl.formatMessage({
              id: "settings.antigravity.account.saveFirst",
              defaultMessage: "Save this profile to sign in.",
            })
      }
    >
      {null}
    </NodexSettingsRow>
  );
}

export const agentProfileSettingsSlots: Partial<Record<ProfileAgentDriver, ProfileSettingsSlots>> =
  {
    [claudeAgent.driver]: {
      bespokeEditors: ({ draft, disabled, change }) =>
        draft.driver === claudeAgent.driver ? (
          <ClaudeCustomModelsEditor
            models={draft.settings.customModels}
            disabled={disabled}
            onChange={(customModels) =>
              change({ ...draft, settings: { ...draft.settings, customModels } })
            }
          />
        ) : null,
    },
    [openCodeAgent.driver]: {
      // Host status describes a saved local default that the unsaved draft still keeps.
      executableStatus: ({ saved, draft, environment, open }) =>
        saved &&
        openCodeAgent.profile.usesHostExecutable(saved) &&
        openCodeAgent.profile.usesHostExecutable({ ...draft, environment }) ? (
          <OpenCodeExecutableStatus owner={openCodeSetupOwner} open={open} />
        ) : null,
    },
    [antigravityAgent.driver]: {
      sharedRuntime: ({ open, profileCount }) => (
        <AntigravityRuntimeRow open={open} profileCount={profileCount} />
      ),
      account: ({ saved }) => <AntigravityProfileAccount saved={saved} />,
      executableStatus: ({ saved, draft, open }) =>
        saved ? (
          <AntigravityProfileExecutable
            profileId={saved.id}
            binaryPath={draft.binaryPath}
            open={open}
          />
        ) : null,
    },
  };
