import { useQuery } from "@tanstack/react-query";
import { CODEX_BINDING } from "../../../shared/agents/codex";
import {
  AppComponentRequirement,
  useAppComponentRequirementDescription,
} from "@/features/app-components/app-component-requirement";
import { composerPredictionAvailabilityOptions } from "@/features/local-conversation/composer-prediction-settings";
import { SubagentDelegationSettingControl } from "@/features/subagent-delegation/subagent-delegation-controls";
import { useIntl } from "@/lib/i18n";
import { isRemoteSpace } from "@/lib/renderer-space";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";
import { AgentCapacitySettingControl } from "./agent-capacity-setting-control";
import {
  ArtifactOpeningSettingRow,
  EffectiveInstructionsRow,
  StandingInstructionsRow,
} from "./agent-instructions-settings-control";
import { DefaultPermissionsSettingControl } from "./default-permissions-setting-control";
import {
  ComposerEnterBehaviorControl,
  ComposerPredictionSettingControl,
  ThreadDetailLevelSettingControl,
  ThreadQueueFollowUpsSettingControl,
} from "./workbench-settings-controls";
import { settingsMessages } from "./workbench-settings-search-catalog";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { WritingModelSettingRow } from "./writing-model-setting-row";

/**
 * Settings › Chats: what chats may do without asking, the instructions every chat follows, and
 * how a chat shows its work and sends messages. A team Space window keeps only the last part;
 * permissions, instructions and the Agents behind predictions and writing are this desktop's own.
 */
export function ChatsSettingsPage({
  composerEnterBehavior,
  isMacPlatform,
  onComposerEnterBehaviorChange,
  onThreadQueueFollowUpsEnabledChange,
  threadQueueFollowUpsEnabled,
}: SettingsSectionPageProps) {
  const intl = useIntl();
  const local = !isRemoteSpace();
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.chatsTitle)}
      subtitle={intl.formatMessage(settingsMessages.chatsSubtitle)}
    >
      {local ? (
        <SectionBlock
          id="permissions"
          title={intl.formatMessage(settingsMessages.agentsPermissions)}
        >
          <SettingRow
            label={intl.formatMessage(settingsMessages.agentsDefaultPermissions)}
            description={intl.formatMessage(settingsMessages.agentsWhatNewChatsCanDoOn)}
          >
            <DefaultPermissionsSettingControl />
          </SettingRow>
          <SettingRow
            label={intl.formatMessage(settingsMessages.agentsSubagentsCanDelegate)}
            description={intl.formatMessage(settingsMessages.agentsSubagentsCanDelegateDescription)}
          >
            <SubagentDelegationSettingControl />
          </SettingRow>
          <SettingRow
            label={intl.formatMessage(settingsMessages.chatsAutomaticChatsAtOnce)}
            description={intl.formatMessage(settingsMessages.chatsAutomaticChatsAtOnceDescription)}
          >
            <AgentCapacitySettingControl />
          </SettingRow>
        </SectionBlock>
      ) : null}
      {local ? (
        <SectionBlock
          id="instructions"
          title={intl.formatMessage(settingsMessages.chatsInstructions)}
        >
          <StandingInstructionsRow />
          <ArtifactOpeningSettingRow />
          <EffectiveInstructionsRow />
        </SectionBlock>
      ) : null}
      <SectionBlock id="in-a-chat" title={intl.formatMessage(settingsMessages.chatsInAChat)}>
        <SettingRow
          label={intl.formatMessage(settingsMessages.chatsCommandOutput)}
          description={intl.formatMessage(settingsMessages.chatsCommandOutputDescription)}
        >
          <ThreadDetailLevelSettingControl />
        </SettingRow>
        {local ? <ComposerPredictionSettingRow /> : null}
        <SettingRow
          label={intl.formatMessage(
            {
              id: "settings.general.enterBehavior.label",
              defaultMessage: "{modifier}+Enter to send long prompts",
            },
            { modifier: isMacPlatform ? "Cmd" : "Ctrl" },
          )}
          description={intl.formatMessage(settingsMessages.generalSingleLinePromptsStillSendOn)}
        >
          <ComposerEnterBehaviorControl
            value={composerEnterBehavior}
            onChange={onComposerEnterBehaviorChange}
          />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage(settingsMessages.generalQueueFollowUps)}
          description={intl.formatMessage(settingsMessages.generalWhileAThreadIsRunningQueue)}
        >
          <ThreadQueueFollowUpsSettingControl
            value={threadQueueFollowUpsEnabled}
            onChange={onThreadQueueFollowUpsEnabledChange}
          />
        </SettingRow>
        {local ? <WritingModelSettingRow /> : null}
      </SectionBlock>
    </SettingsPageSurface>
  );
}

function ComposerPredictionSettingRow() {
  const intl = useIntl();
  const availability = useQuery(composerPredictionAvailabilityOptions("local"));
  const needsCodex = availability.data?.componentUnavailableReason !== undefined;
  const requirementDescription = useAppComponentRequirementDescription(CODEX_BINDING.driver);
  return (
    <SettingRow
      label={intl.formatMessage(settingsMessages.generalShowPredictions)}
      description={
        needsCodex
          ? requirementDescription
          : intl.formatMessage(settingsMessages.generalSuggestYourNextMessageAfterAn)
      }
    >
      {needsCodex ? (
        <AppComponentRequirement
          id={CODEX_BINDING.driver}
          onInstalled={() => void availability.refetch()}
        />
      ) : (
        <ComposerPredictionSettingControl />
      )}
    </SettingRow>
  );
}
