import { ACP_ADD_AGENT_ID } from "@/features/acp-agents/acp-agent-add-dialog";
import { AcpAgentsSettingsSection } from "@/features/acp-agents/acp-agents-settings-section";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  useNodexSettingsDisclosures,
} from "../ui/settings";
import { ClaudeAgentSettingsControl } from "./claude-agent-settings-control";
import { CodexAgentSettingsSection } from "./codex-home-settings-control";
import { OpenCodeAgentSettingsControl } from "./opencode-agent-settings-control";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

const AGENT_SECTIONS = ["codex", "claude", "opencode", "acp"] as const;

/** The Agent section a deep link or search result opens: its own anchor or one inside it. */
export function agentSettingsSectionForAnchor(anchor: string | null | undefined) {
  if (!anchor) return null;
  if (anchor.startsWith("acp-agent-") || anchor === ACP_ADD_AGENT_ID) return "acp";
  return AGENT_SECTIONS.find((section) => section === anchor) ?? null;
}

/** Every coding Agent Nodex can run, most common first; each opens to its own setup. */
export function AgentSettingsPage({ open, settingsAnchor }: SettingsSectionPageProps) {
  const disclosure = useNodexSettingsDisclosures(agentSettingsSectionForAnchor(settingsAnchor));
  return (
    <SettingsPageSurface
      title="Agents"
      subtitle="The coding agents Nodex can run. Open one to change how it starts and signs in."
    >
      <div className="flex flex-col gap-3">
        <CodexAgentSettingsSection open={open} disclosure={disclosure("codex")} />
        <ClaudeAgentSettingsControl open={open} disclosure={disclosure("claude")} />
        <OpenCodeAgentSettingsControl open={open} disclosure={disclosure("opencode")} />
        <AcpAgentsSettingsSection anchor={settingsAnchor ?? null} disclosure={disclosure("acp")} />
      </div>
    </SettingsPageSurface>
  );
}
