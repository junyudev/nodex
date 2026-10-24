import { AcpAgentsSettingsSection } from "@/features/acp-agents/acp-agents-settings-section";
import { ClaudeAgentSettingsControl } from "./claude-agent-settings-control";
import { OpenCodeAgentSettingsControl } from "./opencode-agent-settings-control";
import { CodexHomeSettingsControl } from "./codex-home-settings-control";
import { CodexSetupImportControl } from "./codex-setup-import-control";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

export function AgentSettingsPage({ open, settingsAnchor }: SettingsSectionPageProps) {
  return (
    <SettingsPageSurface title="Agents">
      <SectionBlock id="opencode" title="OpenCode">
        <OpenCodeAgentSettingsControl open={open} />
      </SectionBlock>
      <SectionBlock id="claude" title="Claude Code">
        <ClaudeAgentSettingsControl open={open} />
      </SectionBlock>
      <AcpAgentsSettingsSection anchor={settingsAnchor ?? null} />
      <SectionBlock id="codex" title="Codex">
        <CodexHomeSettingsControl open={open} />
        <CodexSetupImportControl open={open} />
      </SectionBlock>
    </SettingsPageSurface>
  );
}
