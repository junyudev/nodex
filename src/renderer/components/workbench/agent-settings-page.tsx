import { providerComponentSetup } from "@/features/app-components/provider-component-setup";
import {
  runAppComponentChange,
  useAppComponents,
} from "@/features/app-components/use-app-components";
import { APP_COMPONENTS_SETTINGS_ANCHOR } from "@/features/app-components/app-components-settings-section";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { buildSettingsAnchorPath } from "./workbench-settings-routes";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
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
import { AntigravityAgentSettingsControl } from "./antigravity-agent-settings-control";
import { OpenCodeAgentSettingsControl } from "./opencode-agent-settings-control";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

/** Every coding Agent Nodex can run, most common first; each opens to its own setup. */
export function AgentSettingsPage({ open, settingsAnchor }: SettingsSectionPageProps) {
  const intl = useIntl();
  const codex = useAgentRuntimeProviders().data?.find(({ instanceId }) => instanceId === "codex");
  const components = useAppComponents();
  const workbench = useWorkbenchWindowOwner();
  const component = components.state?.components.find(({ id }) => id === "codex");
  const externalUnavailable = codex?.componentUnavailableReason === "external-unusable";
  const setup = externalUnavailable ? null : providerComponentSetup(codex, component, intl);
  const handleSetupAction = () => {
    if (setup?.action === "settings")
      return workbench.openRoute({
        kind: "settings",
        path: buildSettingsAnchorPath("general-settings", APP_COMPONENTS_SETTINGS_ANCHOR),
      });
    if (setup?.action === "retry")
      return runAppComponentChange(setup.id, undefined, () => components.retry(setup.id));
  };
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
        <CodexAgentSettingsSection
          open={open}
          disclosure={disclosure("codex")}
          unavailable={
            setup?.title ??
            ((!component || externalUnavailable) && codex?.componentUnavailableReason
              ? codex.message
              : undefined)
          }
          setupAction={
            setup?.actionLabel ? { label: setup.actionLabel, run: handleSetupAction } : null
          }
        />
        <ClaudeAgentSettingsControl open={open} disclosure={disclosure("claude")} />
        <AntigravityAgentSettingsControl
          open={open}
          anchor={settingsAnchor ?? null}
          disclosure={disclosure("antigravity")}
        />
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
