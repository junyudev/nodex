import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { AcpAgentsSettingsSection } from "@/features/acp-agents/acp-agents-settings-section";
import { ProviderKeysSettingsSection } from "@/features/provider-keys/provider-keys-settings-section";
import { agentSettingsKindForAnchor } from "@/lib/agent-settings-navigation";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
  useNodexSettingsDisclosures,
} from "../ui/settings";
import { ClaudeAgentSettingsControl } from "./claude-agent-settings-control";
import { AgentCapacitySettingControl } from "./agent-capacity-setting-control";
import { DefaultPermissionsSettingControl } from "./default-permissions-setting-control";
import {
  ArtifactOpeningSettingRow,
  EffectiveInstructionsRow,
  StandingInstructionsRow,
} from "./agent-instructions-settings-control";
import { CodexAgentSettingsSection } from "./codex-home-settings-control";
import { OpenCodeAgentSettingsControl } from "./opencode-agent-settings-control";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

/** Every coding Agent Nodex can run, most common first; each opens to its own setup. */
export function AgentSettingsPage({ open, settingsAnchor }: SettingsSectionPageProps) {
  const intl = useIntl();
  const disclosure = useNodexSettingsDisclosures(agentSettingsKindForAnchor(settingsAnchor));
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.agentsTitle)}
      subtitle={intl.formatMessage(settingsMessages.agentsTheCodingAgentsNodexCanRun)}
    >
      <div className="flex flex-col gap-3">
        <SectionBlock id="default-permissions">
          <SettingRow
            label={intl.formatMessage(settingsMessages.agentsDefaultPermissions)}
            description={intl.formatMessage(settingsMessages.agentsWhatNewChatsCanDoOn)}
          >
            <DefaultPermissionsSettingControl />
          </SettingRow>
          <SettingRow
            label={intl.formatMessage({
              id: "settings.agents.automaticWorkAtOnce",
              defaultMessage: "Automatic work at once",
            })}
            description={intl.formatMessage({
              id: "settings.agents.automationsAndPagesSetToStart",
              defaultMessage:
                "Automations and Pages set to start automatically wait beyond this. Your chats and the tasks they delegate always run.",
            })}
          >
            <AgentCapacitySettingControl />
          </SettingRow>
        </SectionBlock>
        <SectionBlock id="agent-instructions">
          <ArtifactOpeningSettingRow />
          <StandingInstructionsRow />
          <EffectiveInstructionsRow />
        </SectionBlock>
        <CodexAgentSettingsSection open={open} disclosure={disclosure("codex")} />
        <ClaudeAgentSettingsControl open={open} disclosure={disclosure("claude")} />
        <ProviderKeysSettingsSection
          anchor={settingsAnchor ?? null}
          disclosure={disclosure("keys")}
        />
        <OpenCodeAgentSettingsControl open={open} disclosure={disclosure("opencode")} />
        <AcpAgentsSettingsSection anchor={settingsAnchor ?? null} disclosure={disclosure("acp")} />
      </div>
    </SettingsPageSurface>
  );
}
