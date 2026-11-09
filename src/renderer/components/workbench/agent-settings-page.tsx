import { AcpAgentsSettingsSection } from "@/features/acp-agents/acp-agents-settings-section";
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
import { CodexAgentSettingsSection } from "./codex-home-settings-control";
import { OpenCodeAgentSettingsControl } from "./opencode-agent-settings-control";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

/** Every coding Agent Nodex can run, most common first; each opens to its own setup. */
export function AgentSettingsPage({ open, settingsAnchor }: SettingsSectionPageProps) {
  const disclosure = useNodexSettingsDisclosures(agentSettingsKindForAnchor(settingsAnchor));
  return (
    <SettingsPageSurface
      title="Agents"
      subtitle="The coding agents Nodex can run. Open one to change how it starts and signs in."
    >
      <div className="flex flex-col gap-3">
        <SectionBlock id="default-permissions">
          <SettingRow
            label="Default permissions"
            description="What new chats can do on this computer without asking."
          >
            <DefaultPermissionsSettingControl />
          </SettingRow>
          <SettingRow label="Agents running at once">
            <AgentCapacitySettingControl />
          </SettingRow>
        </SectionBlock>
        <CodexAgentSettingsSection open={open} disclosure={disclosure("codex")} />
        <ClaudeAgentSettingsControl open={open} disclosure={disclosure("claude")} />
        <OpenCodeAgentSettingsControl open={open} disclosure={disclosure("opencode")} />
        <AcpAgentsSettingsSection anchor={settingsAnchor ?? null} disclosure={disclosure("acp")} />
      </div>
    </SettingsPageSurface>
  );
}
