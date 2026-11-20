import { isRemoteSpace } from "@/lib/renderer-space";
import { ChatTitleModelSettingRow } from "./chat-title-model-setting-row";
import { TerminalShellSettingRow } from "./terminal-shell-setting-row";
import { UsageMeterSettingRows } from "./usage-meter-setting-rows";
import { startTransition } from "react";
import { NodexButton } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { LanguageSettingRow } from "./language-setting-row";
import { useFirstRunEntry } from "@/features/first-run/first-run-state";
import { CodexRequestDiagnostics } from "@/features/local-conversation/codex-request-diagnostics";
import { AppUpdateSettingRows } from "./app-update-settings-control";
import { AppComponentsSettingsSection } from "@/features/app-components/app-components-settings-section";
import { WindowsStartupSettingsRow } from "./windows-startup-settings-row";
import {
  ComposerEnterBehaviorControl,
  ComposerPredictionSettingControl,
  CopyFileReferencesAsLocalPathsSettingControl,
  DiagnosticsSettingRows,
  FileLinkOpenerSettingControl,
  NfmAutolinkBareDomainsSettingControl,
  NfmAutolinkPasteSettingControl,
  NfmAutolinkTypingSettingControl,
  PasteResourceDescriptionSoftLimitSettingControl,
  PasteResourceTextThresholdSettingControl,
  SpellcheckSettingControl,
  ThreadDetailLevelSettingControl,
  ThreadNotificationSettingControl,
  ThreadQueueFollowUpsSettingControl,
  TelemetrySettingRows,
  WindowRestoreSettingControl,
} from "./workbench-settings-controls";
import { OPEN_SOURCE_LICENSES_SETTINGS_PATH } from "./workbench-settings-routes";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";

export function GeneralSettingsPage({
  composerEnterBehavior,
  isMacPlatform,
  onComposerEnterBehaviorChange,
  onPathChange,
  onThreadQueueFollowUpsEnabledChange,
  open,
  threadQueueFollowUpsEnabled,
}: SettingsSectionPageProps) {
  const intl = useIntl();
  const { runSetupAgain } = useFirstRunEntry();
  return (
    <SettingsPageSurface
      title={intl.formatMessage({ id: "settings.general.title", defaultMessage: "General" })}
      subtitle={intl.formatMessage({
        id: "settings.general.subtitle",
        defaultMessage:
          "How Nodex starts and updates, how chats and writing behave, and what you share.",
      })}
    >
      <SectionBlock
        id="app"
        title={intl.formatMessage({ id: "settings.general.app.title", defaultMessage: "App" })}
      >
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.restoreWindows.label",
            defaultMessage: "Restore windows",
          })}
          description={intl.formatMessage({
            id: "settings.general.restoreWindows.description",
            defaultMessage: "Choose which windows reopen after quitting Nodex.",
          })}
        >
          <WindowRestoreSettingControl />
        </SettingRow>
        <TerminalShellSettingRow />
        <LanguageSettingRow />
        <AppUpdateSettingRows open={open} />
        <WindowsStartupSettingsRow open={open} />
        {/* Setup connects this desktop's own Agents and Projects, which a team window never reads. */}
        {isRemoteSpace() ? null : (
          <SettingRow
            label={intl.formatMessage({
              id: "settings.general.runSetup.label",
              defaultMessage: "Run setup again",
            })}
            description={intl.formatMessage({
              id: "settings.general.runSetup.description",
              defaultMessage: "Connect Agents and add projects.",
            })}
          >
            <NodexButton variant="secondary" size="xs" onClick={() => void runSetupAgain()}>
              <FormattedMessage id="settings.general.runSetup.action" defaultMessage="Run setup" />
            </NodexButton>
          </SettingRow>
        )}
        <SettingRow
          label={intl.formatMessage({
            id: "settings.openSourceLicenses.rowLabel",
            defaultMessage: "Open source licenses",
          })}
          description={intl.formatMessage({
            id: "settings.openSourceLicenses.rowDescription",
            defaultMessage: "Third-party notices for bundled dependencies.",
          })}
        >
          <NodexButton
            variant="secondary"
            size="xs"
            onClick={() => {
              startTransition(() => {
                onPathChange(OPEN_SOURCE_LICENSES_SETTINGS_PATH);
              });
            }}
          >
            <FormattedMessage id="settings.openSourceLicenses.view" defaultMessage="View" />
          </NodexButton>
        </SettingRow>
      </SectionBlock>

      {/* Components install on this desktop; a team window has none of its own. */}
      {isRemoteSpace() ? null : <AppComponentsSettingsSection />}

      <UsageMeterSettingRows />

      {/* Titles and predictions come from this desktop's own Agents, never a team Space's host. */}
      <SectionBlock
        id="chats"
        title={intl.formatMessage({ id: "settings.general.chats.title", defaultMessage: "Chats" })}
      >
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.threadDetail.label",
            defaultMessage: "Thread detail",
          })}
          description={intl.formatMessage({
            id: "settings.general.threadDetail.description",
            defaultMessage: "Choose how much command output to show in threads.",
          })}
        >
          <ThreadDetailLevelSettingControl />
        </SettingRow>
        {isRemoteSpace() ? null : (
          <SettingRow
            label={intl.formatMessage({
              id: "settings.general.messagePredictions.label",
              defaultMessage: "Show predictions",
            })}
            description={intl.formatMessage({
              id: "settings.general.messagePredictions.description",
              defaultMessage: "Suggest your next message after an agent replies.",
            })}
          >
            <ComposerPredictionSettingControl />
          </SettingRow>
        )}
        <SettingRow
          label={intl.formatMessage(
            {
              id: "settings.general.enterBehavior.label",
              defaultMessage: "{modifier}+Enter to send long prompts",
            },
            { modifier: isMacPlatform ? "Cmd" : "Ctrl" },
          )}
          description={intl.formatMessage({
            id: "settings.general.enterBehavior.description",
            defaultMessage:
              "Single-line prompts still send on Enter. Multiline prompts send with the modifier instead.",
          })}
        >
          <ComposerEnterBehaviorControl
            value={composerEnterBehavior}
            onChange={onComposerEnterBehaviorChange}
          />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.queueFollowUps.label",
            defaultMessage: "Queue follow-ups",
          })}
          description={intl.formatMessage({
            id: "settings.general.queueFollowUps.description",
            defaultMessage:
              "While a thread is running, queue new messages by default instead of steering it right away.",
          })}
        >
          <ThreadQueueFollowUpsSettingControl
            value={threadQueueFollowUpsEnabled}
            onChange={onThreadQueueFollowUpsEnabledChange}
          />
        </SettingRow>
        {isRemoteSpace() ? null : <ChatTitleModelSettingRow />}
      </SectionBlock>

      <SectionBlock
        id="writing"
        title={intl.formatMessage({
          id: "settings.general.writing.title",
          defaultMessage: "Writing",
        })}
      >
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.spellcheck.label",
            defaultMessage: "Spellcheck",
          })}
          description={intl.formatMessage({
            id: "settings.general.spellcheck.description",
            defaultMessage: "Mark misspelled words wherever you type.",
          })}
        >
          <SpellcheckSettingControl />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.autolinkTyping.label",
            defaultMessage: "Auto-link while typing",
          })}
          description={intl.formatMessage({
            id: "settings.general.autolinkTyping.description",
            defaultMessage: "Turn typed URLs into links as you finish the token.",
          })}
        >
          <NfmAutolinkTypingSettingControl />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.autolinkPaste.label",
            defaultMessage: "Auto-link on paste",
          })}
          description={intl.formatMessage({
            id: "settings.general.autolinkPaste.description",
            defaultMessage:
              "Recognize links in pasted text, including inline URL spans inside longer content.",
          })}
        >
          <NfmAutolinkPasteSettingControl />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.autolinkBareDomains.label",
            defaultMessage: "Recognize bare domains",
          })}
          description={intl.formatMessage({
            id: "settings.general.autolinkBareDomains.description",
            defaultMessage:
              "Link plain domains like example.com. Leave off to avoid filename-like text such as .md paths.",
          })}
        >
          <NfmAutolinkBareDomainsSettingControl />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.pasteTextThreshold.label",
            defaultMessage: "Large paste text threshold",
          })}
          description={intl.formatMessage({
            id: "settings.general.pasteTextThreshold.description",
            defaultMessage:
              "Prompt when pasted plain text reaches this many characters, so you can materialize it instead of inflating the note.",
          })}
        >
          <PasteResourceTextThresholdSettingControl />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.pasteDescriptionLimit.label",
            defaultMessage: "Large paste description soft limit",
          })}
          description={intl.formatMessage({
            id: "settings.general.pasteDescriptionLimit.description",
            defaultMessage:
              "Prompt before pasted plain text pushes the note near its description size ceiling.",
          })}
        >
          <PasteResourceDescriptionSoftLimitSettingControl />
        </SettingRow>
      </SectionBlock>

      <SectionBlock
        id="files-and-links"
        title={intl.formatMessage({
          id: "settings.general.filesAndLinks.title",
          defaultMessage: "Files & links",
        })}
      >
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.copyFileReferences.label",
            defaultMessage: "Copy file references as local paths",
          })}
          description={intl.formatMessage({
            id: "settings.general.copyFileReferences.description",
            defaultMessage:
              "Use absolute local paths in copied plain text; Library Files resolve to this Profile’s immutable .blob files.",
          })}
        >
          <CopyFileReferencesAsLocalPathsSettingControl />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage({
            id: "settings.general.markdownFileLinks.label",
            defaultMessage: "Markdown file links",
          })}
          description={intl.formatMessage({
            id: "settings.general.markdownFileLinks.description",
            defaultMessage:
              "Choose which desktop app handles absolute local file links in rendered markdown.",
          })}
        >
          <FileLinkOpenerSettingControl />
        </SettingRow>
      </SectionBlock>

      <SectionBlock
        id="notifications"
        title={intl.formatMessage({
          id: "settings.general.notifications",
          defaultMessage: "Notifications",
        })}
      >
        <ThreadNotificationSettingControl open={open} />
      </SectionBlock>

      <SectionBlock
        id="privacy"
        title={intl.formatMessage({
          id: "settings.general.privacy.title",
          defaultMessage: "Privacy",
        })}
      >
        <DiagnosticsSettingRows open={open} />
        <TelemetrySettingRows open={open} />
      </SectionBlock>

      <SectionBlock
        id="app-server-diagnostics"
        title={intl.formatMessage({
          id: "settings.general.troubleshooting.title",
          defaultMessage: "Troubleshooting",
        })}
      >
        <CodexRequestDiagnostics enabled={open} />
      </SectionBlock>
    </SettingsPageSurface>
  );
}
