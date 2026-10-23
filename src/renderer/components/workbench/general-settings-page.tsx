import { startTransition } from "react";
import { NodexButton } from "@/components/ui/button";
import { CodexRequestDiagnostics } from "@/features/local-conversation/codex-request-diagnostics";
import { AppUpdateSettingsControl } from "./app-update-settings-control";
import {
  ComposerEnterBehaviorControl,
  ComposerPredictionSettingControl,
  CopyFileReferencesAsLocalPathsSettingControl,
  DiagnosticsSettingControl,
  FileLinkOpenerSettingControl,
  NfmAutolinkBareDomainsSettingControl,
  NfmAutolinkPasteSettingControl,
  NfmAutolinkTypingSettingControl,
  PasteResourceDescriptionSoftLimitSettingControl,
  PasteResourceTextThresholdSettingControl,
  ServiceTierSettingControl,
  SpellcheckSettingControl,
  ThreadDetailLevelSettingControl,
  ThreadNotificationSettingControl,
  ThreadQueueFollowUpsSettingControl,
  TelemetrySettingControl,
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
    <SettingsPageSurface title="General" subtitle="App-wide shell behavior and notifications.">
      <SectionBlock id="general" title="General">
        <SettingRow
          label="Restore windows"
          description="Choose which workbench windows reopen after quitting Nodex."
        >
          <WindowRestoreSettingControl />
        </SettingRow>
        <SettingRow
          label="Service tier"
          description="Choose the default speed for new thread requests. Standard is the default; Fast opts into the faster tier."
        >
          <ServiceTierSettingControl />
        </SettingRow>
        <SettingRow
          label="App updates"
          description="Packaged macOS builds can check, download, and install stable updates in the background."
        >
          <AppUpdateSettingsControl open={open} />
        </SettingRow>
        <SettingRow
          label="Diagnostics"
          description="Optionally send crash diagnostics and masked session replays to Sentry. Prompts, transcripts, card text, and local payloads are scrubbed before upload."
        >
          <DiagnosticsSettingControl open={open} />
        </SettingRow>
        <SettingRow
          label="Telemetry"
          description="Optionally send anonymous product events and filtered technical web analytics to Statsig. Prompts, transcripts, card text, and file paths are not sent."
        >
          <TelemetrySettingControl open={open} />
        </SettingRow>
        <SettingRow
          label="Open source licenses"
          description="Third-party notices for bundled dependencies"
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

      <SectionBlock id="app-server-diagnostics" title="App server diagnostics">
        <CodexRequestDiagnostics enabled={open} />
      </SectionBlock>

      <SectionBlock id="composer" title="Composer">
        <SettingRow
          label="Show predictions"
          description="Suggest your next message after an agent replies."
        >
          <ComposerPredictionSettingControl />
        </SettingRow>
        <SettingRow
          label="Thread detail"
          description="Choose how much command output to show in threads."
        >
          <ThreadDetailLevelSettingControl />
        </SettingRow>
        <SettingRow
          label="Spellcheck"
          description="Inline text correction for editable writing surfaces."
        >
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
        <SettingRow
          label={`${isMacPlatform ? "Cmd" : "Ctrl"}+Enter to send long prompts`}
          description="Single-line prompts still send on Enter. Multiline prompts switch to the modifier chord when this is enabled."
        >
          <ComposerEnterBehaviorControl
            value={composerEnterBehavior}
            onChange={onComposerEnterBehaviorChange}
          />
        </SettingRow>
        <SettingRow
          label="Queue follow-ups"
          description="While a thread is running, use queue as the default submit action instead of immediate steering."
        >
          <ThreadQueueFollowUpsSettingControl
            value={threadQueueFollowUpsEnabled}
            onChange={onThreadQueueFollowUpsEnabledChange}
          />
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
    </SettingsPageSurface>
  );
}
