import { ClaudeAgentSettingsControl } from "./claude-agent-settings-control";
import { OpenCodeAgentSettingsControl } from "./opencode-agent-settings-control";
import { CodexHomeSettingsControl } from "./codex-home-settings-control";
import { AcpAgentSettingsControl } from "./acp-agent-settings-control";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

export function AgentSettingsPage({ open }: SettingsSectionPageProps) {
  return (
    <SettingsPageSurface title="Agents">
      <SectionBlock title="OpenCode">
        <OpenCodeAgentSettingsControl open={open} />
      </SectionBlock>
      <SectionBlock title="Claude Code">
        <ClaudeAgentSettingsControl open={open} />
      </SectionBlock>
      <SectionBlock title="ACP">
        <AcpAgentSettingsControl open={open} />
      </SectionBlock>
      <SectionBlock title="Codex">
        <CodexHomeSettingsControl open={open} />
      </SectionBlock>
    </SettingsPageSurface>
  );
}
