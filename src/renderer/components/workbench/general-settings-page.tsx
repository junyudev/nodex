import { startTransition } from "react";
import { NodexButton } from "@/components/ui/button";
import { CodexRequestDiagnostics } from "@/features/local-conversation/codex-request-diagnostics";
import { AppUpdateSettingRows } from "./app-update-settings-control";
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
  return (
    <SettingsPageSurface
      title="General"
      subtitle="How Nodex starts and updates, how chats and writing behave, and what you share."
    >
      <SectionBlock id="app" title="App">
        <SettingRow
          label="Restore windows"
          description="Choose which windows reopen after quitting Nodex."
        >
          <WindowRestoreSettingControl />
        </SettingRow>
        <AppUpdateSettingRows open={open} />
        <SettingRow
          label="Open source licenses"
          description="Third-party notices for bundled dependencies."
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
            View
          </NodexButton>
        </SettingRow>
      </SectionBlock>

      <SectionBlock id="chats" title="Chats">
        <SettingRow
          label="Thread detail"
          description="Choose how much command output to show in threads."
        >
          <ThreadDetailLevelSettingControl />
        </SettingRow>
        <SettingRow
          label="Show predictions"
          description="Suggest your next message after an agent replies."
        >
          <ComposerPredictionSettingControl />
        </SettingRow>
        <SettingRow
          label={`${isMacPlatform ? "Cmd" : "Ctrl"}+Enter to send long prompts`}
          description="Single-line prompts still send on Enter. Multiline prompts send with the modifier instead."
        >
          <ComposerEnterBehaviorControl
            value={composerEnterBehavior}
            onChange={onComposerEnterBehaviorChange}
          />
        </SettingRow>
        <SettingRow
          label="Queue follow-ups"
          description="While a thread is running, queue new messages by default instead of steering it right away."
        >
          <ThreadQueueFollowUpsSettingControl
            value={threadQueueFollowUpsEnabled}
            onChange={onThreadQueueFollowUpsEnabledChange}
          />
        </SettingRow>
      </SectionBlock>

      <SectionBlock id="writing" title="Writing">
        <SettingRow label="Spellcheck" description="Mark misspelled words wherever you type.">
          <SpellcheckSettingControl />
        </SettingRow>
        <SettingRow
          label="Auto-link while typing"
          description="Turn typed URLs into links as you finish the token."
        >
          <NfmAutolinkTypingSettingControl />
        </SettingRow>
        <SettingRow
          label="Auto-link on paste"
          description="Recognize links in pasted text, including inline URL spans inside longer content."
        >
          <NfmAutolinkPasteSettingControl />
        </SettingRow>
        <SettingRow
          label="Recognize bare domains"
          description="Link plain domains like example.com. Leave off to avoid filename-like text such as .md paths."
        >
          <NfmAutolinkBareDomainsSettingControl />
        </SettingRow>
        <SettingRow
          label="Large paste text threshold"
          description="Prompt when pasted plain text reaches this many characters, so you can materialize it instead of inflating the note."
        >
          <PasteResourceTextThresholdSettingControl />
        </SettingRow>
        <SettingRow
          label="Large paste description soft limit"
          description="Prompt before pasted plain text pushes the note near its description size ceiling."
        >
          <PasteResourceDescriptionSoftLimitSettingControl />
        </SettingRow>
      </SectionBlock>

      <SectionBlock id="files-and-links" title="Files & links">
        <SettingRow
          label="Copy file references as local paths"
          description="Use absolute local paths in copied plain text; Library Files resolve to this Profile’s immutable .blob files."
        >
          <CopyFileReferencesAsLocalPathsSettingControl />
        </SettingRow>
        <SettingRow
          label="Markdown file links"
          description="Choose which desktop app handles absolute local file links in rendered markdown."
        >
          <FileLinkOpenerSettingControl />
        </SettingRow>
      </SectionBlock>

      <SectionBlock id="notifications" title="Notifications">
        <ThreadNotificationSettingControl open={open} />
      </SectionBlock>

      <SectionBlock id="privacy" title="Privacy">
        <DiagnosticsSettingRows open={open} />
        <TelemetrySettingRows open={open} />
      </SectionBlock>

      <SectionBlock id="app-server-diagnostics" title="Troubleshooting">
        <CodexRequestDiagnostics enabled={open} />
      </SectionBlock>
    </SettingsPageSurface>
  );
}
