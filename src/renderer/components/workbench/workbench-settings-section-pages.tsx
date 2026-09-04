import { RecoveryEntry } from "@/features/document-recovery/recovery-entry";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { startTransition, useCallback, useEffect, useState } from "react";
import { AppUpdateSettingsControl } from "./app-update-settings-control";
import { AcpAgentSettingsControl } from "./acp-agent-settings-control";
import { AgentImportSettingsPage } from "./agent-import-settings-page";
import { ArchivedChatsSettingsPage } from "./archived-chats-settings-page";
import { ComputerUseSettingsPage } from "./computer-use-settings-page";
import { KeyboardShortcutsSettingsPage } from "./keyboard-shortcuts-settings-page";
import { LocalEnvironmentsSettingsPage } from "./local-environments-settings-page";
import { ManagedWorktreesSettingControl } from "./managed-worktrees-settings-control";
import { WorkbenchHooksSettingsPage } from "./workbench-hooks-settings-page";
import { BrowserSettingsPage } from "@/features/browser-sidebar/browser-settings-pages";
import { VoiceSettingsPage } from "@/features/dictation/voice-settings-page";
import {
  FULL_ACCESS_PERMISSION_DESCRIPTION,
  PermissionModeDropdown,
} from "@/features/local-conversation/view/shared/permission-mode-dropdown";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { isCodexGitSettings } from "../../../shared/codex-git-settings";
import type { CodexGitSettings, CodexPermissionState } from "../../lib/types";
import {
  readCodexPermissionState,
  readGitSettings,
  revealFileInManager,
  updateCodexPermissionConfigValue,
  updateCodexPermissionMode,
  updateGitSettings,
} from "./workbench-settings-overlay-deps";
import {
  BackupSettingsControl,
  CodeFontSizeSettingControl,
  ComposerEnterBehaviorControl,
  ConfigValueDropdown,
  CopyFileReferencesAsLocalPathsSettingControl,
  DiagnosticsSettingControl,
  FileLinkOpenerSettingControl,
  formatApprovalPolicyLabel,
  formatSandboxModeLabel,
  NfmAutolinkBareDomainsSettingControl,
  NfmAutolinkPasteSettingControl,
  NfmAutolinkTypingSettingControl,
  PasteResourceDescriptionSoftLimitSettingControl,
  PasteResourceTextThresholdSettingControl,
  ReducedMotionSettingControl,
  SansFontSizeSettingControl,
  ServiceTierSettingControl,
  TaskShorthandPagePromotionSettingControl,
  SpellcheckSettingControl,
  ThemeSettingControl,
  ThreadDetailLevelSettingControl,
  ThreadNotificationSettingControl,
  ThreadQueueFollowUpsSettingControl,
  TogglePill,
  TelemetrySettingControl,
  WindowRestoreSettingControl,
  WorktreeAutoBranchPrefixSettingControl,
} from "./workbench-settings-route-shell";
import type {
  SettingsPageComponentRegistry,
  SettingsSectionPageProps,
} from "./workbench-settings-page-registry";
import { OPEN_SOURCE_LICENSES_SETTINGS_PATH } from "./workbench-settings-routes";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";

function usePermissionSettings(activeProjectId: string | null, open: boolean) {
  const [permissionState, setPermissionState] = useState<CodexPermissionState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPermissionState = useCallback(async () => {
    const nextState = await readCodexPermissionState(activeProjectId);
    setPermissionState(nextState);
  }, [activeProjectId]);

  useEffect(() => {
    if (!open) return;

    void loadPermissionState().catch((err) => {
      setError(err instanceof Error ? err.message : "Could not load agent settings.");
    });
  }, [activeProjectId, loadPermissionState, open]);

  const writeConfigValue = useCallback(
    async (keyPath: string, value: unknown) => {
      setBusyKey(keyPath);
      setError(null);
      try {
        const nextState = await updateCodexPermissionConfigValue(activeProjectId, keyPath, value);
        setPermissionState(nextState);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save config setting.");
      } finally {
        setBusyKey(null);
      }
    },
    [activeProjectId],
  );

  const handlePermissionModeChange = useCallback(
    async (mode: "auto" | "guardian-approvals" | "full-access" | "custom") => {
      setBusyKey("permission-mode");
      setError(null);
      try {
        const nextState = await updateCodexPermissionMode(activeProjectId, mode);
        setPermissionState(nextState);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save permission mode.");
      } finally {
        setBusyKey(null);
      }
    },
    [activeProjectId],
  );

  return {
    busyKey,
    error,
    handlePermissionModeChange,
    permissionState,
    writeConfigValue,
  };
}

export function GeneralSettingsPage({
  activeProjectId,
  composerEnterBehavior,
  isMacPlatform,
  onComposerEnterBehaviorChange,
  onPathChange,
  onThreadQueueFollowUpsEnabledChange,
  open,
  threadQueueFollowUpsEnabled,
}: SettingsSectionPageProps) {
  const {
    handlePermissionModeChange,
    permissionState,
    error: permissionError,
  } = usePermissionSettings(activeProjectId, open);

  return (
    <SettingsPageSurface title="General" subtitle="App-wide shell behavior and notifications.">
      <SectionBlock id="permissions" title="Permissions">
        <SettingRow
          label="Default permissions mode"
          description={
            permissionState?.mode === "full-access"
              ? FULL_ACCESS_PERMISSION_DESCRIPTION
              : "Choose the preset used for new local tasks."
          }
        >
          <PermissionModeDropdown
            selectedMode={permissionState?.mode ?? "custom"}
            availableModes={permissionState?.availableModes}
            autoReviewAvailable={permissionState?.autoReviewAvailable ?? false}
            triggerStyle="settings"
            onSelect={(mode) => {
              void handlePermissionModeChange(mode);
            }}
          />
        </SettingRow>
      </SectionBlock>

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

      <SectionBlock id="composer" title="Composer">
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
          description="Use absolute local paths in copied plain text; Page Files resolve to this Profile’s immutable .blob files."
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

      {permissionError ? (
        <div className="text-sm text-[var(--red-text)]">{permissionError}</div>
      ) : null}
    </SettingsPageSurface>
  );
}

export function AppearanceSettingsPage() {
  return (
    <SettingsPageSurface
      title="Appearance"
      subtitle="Theme and typography tokens used across the app."
    >
      <SectionBlock title="Theme">
        <SettingRow label="Theme" description="Match system mode or force a fixed theme.">
          <ThemeSettingControl />
        </SettingRow>
        <SettingRow
          label="Reduced motion"
          description="Follow the system setting, reduce interface motion, or allow full motion."
        >
          <ReducedMotionSettingControl />
        </SettingRow>
        <SettingRow
          label="Sans font size"
          description="Scales shared sans typography tokens and chat body text across the app."
        >
          <SansFontSizeSettingControl />
        </SettingRow>
        <SettingRow
          label="Code font size"
          description="Sets editor/code typography globally via --vscode-editor-font-size."
        >
          <CodeFontSizeSettingControl />
        </SettingRow>
      </SectionBlock>
    </SettingsPageSurface>
  );
}

export function AgentSettingsPage({ activeProjectId, open }: SettingsSectionPageProps) {
  const { busyKey, error, permissionState, writeConfigValue } = usePermissionSettings(
    activeProjectId,
    open,
  );

  const openConfigToml = useCallback(async () => {
    const configPath = permissionState?.configTarget.filePath?.trim();
    if (!configPath) {
      return;
    }

    await revealFileInManager(configPath);
  }, [permissionState?.configTarget.filePath]);

  const approvalPolicyValue = formatApprovalPolicyLabel(permissionState?.approvalPolicy ?? null);
  const sandboxModeValue = formatSandboxModeLabel(permissionState?.sandboxMode ?? null);
  const networkAccessValue =
    permissionState?.sandbox?.type === "workspaceWrite"
      ? permissionState.sandbox.networkAccess
      : false;

  return (
    <SettingsPageSurface title="Agent" subtitle="Configuration and raw config.toml settings.">
      <SectionBlock title="Configuration">
        <SettingRow
          label="Approval policy"
          description="Raw `approval_policy` value for this config target."
        >
          <ConfigValueDropdown
            value={approvalPolicyValue}
            disabled={busyKey !== null}
            onSelect={(value) => {
              void writeConfigValue("approval_policy", value);
            }}
            options={[
              { value: "untrusted", label: "untrusted" },
              { value: "on-request", label: "on-request" },
              { value: "never", label: "never" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Sandbox settings"
          description="Raw `sandbox_mode` value for this config target."
        >
          <ConfigValueDropdown
            value={sandboxModeValue}
            disabled={busyKey !== null}
            onSelect={(value) => {
              void writeConfigValue("sandbox_mode", value);
            }}
            options={[
              { value: "read-only", label: "read-only" },
              { value: "workspace-write", label: "workspace-write" },
              { value: "danger-full-access", label: "danger-full-access" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Allow network access"
          description="Controls `sandbox_workspace_write.network_access`."
        >
          <TogglePill
            ariaLabel="Allow network access"
            value={networkAccessValue}
            disabled={busyKey !== null || permissionState?.sandboxMode !== "workspace-write"}
            onChange={(value) => {
              void writeConfigValue("sandbox_workspace_write.network_access", value);
            }}
          />
        </SettingRow>
        <SettingRow
          label="config.toml"
          description={permissionState?.configTarget.filePath ?? "No writable config target"}
        >
          <NodexButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={!permissionState?.configTarget.filePath}
            onClick={() => {
              void openConfigToml();
            }}
          >
            Reveal
          </NodexButton>
        </SettingRow>
      </SectionBlock>

      <SectionBlock title="Agent backends">
        <AcpAgentSettingsControl open={open} />
      </SectionBlock>

      {error ? <div className="text-sm text-[var(--red-text)]">{error}</div> : null}
    </SettingsPageSurface>
  );
}

export function PageSettingsPage({
  onTaskShorthandPagePromotionEnabledChange,
  taskShorthandPagePromotionEnabled,
}: SettingsSectionPageProps) {
  return (
    <SettingsPageSurface title="Pages" subtitle="Page creation and import behavior.">
      <SectionBlock id="block-import" title="Block import">
        <SettingRow
          label="Task shorthand on Block → Page"
          description="Interpret task metadata when a Block is promoted into a Page. 1XL(ui, unclear) Fix import → Fix import · P1 · XL · ui · unclear"
        >
          <TaskShorthandPagePromotionSettingControl
            value={taskShorthandPagePromotionEnabled}
            onChange={onTaskShorthandPagePromotionEnabledChange}
          />
        </SettingRow>
      </SectionBlock>
    </SettingsPageSurface>
  );
}

export function WorktreesSettingsPage({ open, onOpenThread }: SettingsSectionPageProps) {
  return (
    <SettingsPageSurface title="Worktrees">
      <ManagedWorktreesSettingControl open={open} onOpenThread={onOpenThread} />
    </SettingsPageSurface>
  );
}

function GitInstructionSettingControl({
  ariaLabel,
  description,
  label,
  onSave,
  placeholder,
  value,
}: {
  ariaLabel: string;
  description: string;
  label: string;
  onSave: (value: string) => Promise<void>;
  placeholder: string;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(value), [value]);

  const changed = draft !== value;
  const save = useCallback(async () => {
    if (!changed || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }, [changed, draft, onSave, saving]);

  return (
    <SectionBlock title={label}>
      <div className="flex items-start justify-between gap-4 p-3 pb-0">
        <p className="text-sm text-token-text-secondary">{description}</p>
        <NodexButton
          variant="secondary"
          size="sm"
          disabled={!changed || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </NodexButton>
      </div>
      <div className="p-3 pt-2">
        <textarea
          aria-label={ariaLabel}
          className="mt-1.5 w-full resize-y rounded-md border border-token-input-border bg-token-input-background px-2.5 py-2 text-sm text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border disabled:cursor-not-allowed disabled:opacity-50"
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          rows={6}
          value={draft}
        />
      </div>
    </SectionBlock>
  );
}

export function GitSettingsPage({
  onWorktreeAutoBranchPrefixChange,
  open,
  worktreeAutoBranchPrefix,
}: SettingsSectionPageProps) {
  const [settings, setSettings] = useState<CodexGitSettings>({
    branchPrefix: worktreeAutoBranchPrefix,
    commitInstructions: "",
    pullRequestInstructions: "",
  });
  const [branchSaving, setBranchSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void readGitSettings()
      .then((next) => {
        if (disposed) return;
        if (!isCodexGitSettings(next)) throw new Error("Git settings are unavailable");
        setSettings((current) =>
          current.branchPrefix === next.branchPrefix &&
          current.commitInstructions === next.commitInstructions &&
          current.pullRequestInstructions === next.pullRequestInstructions
            ? current
            : next,
        );
      })
      .catch(() => {
        if (!disposed) toast.danger("Failed to load Git settings");
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const saveBranchPrefix = useCallback(
    async (branchPrefix: string) => {
      if (branchSaving) return;
      setBranchSaving(true);
      try {
        const next = await updateGitSettings({ branchPrefix });
        if (!isCodexGitSettings(next)) throw new Error("Git settings are unavailable");
        setSettings(next);
        onWorktreeAutoBranchPrefixChange(next.branchPrefix);
        toast.success("Saved branch prefix");
      } catch {
        toast.danger("Failed to save branch prefix");
      } finally {
        setBranchSaving(false);
      }
    },
    [branchSaving, onWorktreeAutoBranchPrefixChange],
  );

  const saveInstructions = useCallback(
    async (
      patch:
        | Pick<CodexGitSettings, "commitInstructions">
        | Pick<CodexGitSettings, "pullRequestInstructions">,
      successMessage: string,
      errorMessage: string,
    ) => {
      try {
        const next = await updateGitSettings(patch);
        if (!isCodexGitSettings(next)) throw new Error("Git settings are unavailable");
        setSettings(next);
        toast.success(successMessage);
      } catch {
        toast.danger(errorMessage);
      }
    },
    [],
  );

  return (
    <SettingsPageSurface
      title="Git"
      subtitle="Branch naming and instructions used by Nodex for Git operations."
    >
      <SectionBlock title="Branches">
        <SettingRow
          label="Branch prefix"
          description="Prefix used when Nodex creates new branches."
        >
          <WorktreeAutoBranchPrefixSettingControl
            disabled={branchSaving}
            value={settings.branchPrefix}
            onChange={(branchPrefix) => void saveBranchPrefix(branchPrefix)}
          />
        </SettingRow>
      </SectionBlock>
      <GitInstructionSettingControl
        ariaLabel="Commit instructions"
        description="Added to commit message generation prompts."
        label="Commit instructions"
        onSave={(commitInstructions) =>
          saveInstructions(
            { commitInstructions },
            "Saved commit instructions",
            "Failed to save commit instructions",
          )
        }
        placeholder="Add commit message guidance…"
        value={settings.commitInstructions}
      />
      <GitInstructionSettingControl
        ariaLabel="Pull request instructions"
        description="Added to PR title and description generation prompts."
        label="Pull request instructions"
        onSave={(pullRequestInstructions) =>
          saveInstructions(
            { pullRequestInstructions },
            "Saved pull request instructions",
            "Failed to save pull request instructions",
          )
        }
        placeholder="Add pull request guidance…"
        value={settings.pullRequestInstructions}
      />
    </SettingsPageSurface>
  );
}

export function LocalEnvironmentsSettingsSectionPage({
  activeProjectId,
  initialLocalEnvironmentConfigPath,
  initialLocalEnvironmentProjectId,
  onRequestProjectPickerOpen,
  open,
  projects,
}: SettingsSectionPageProps) {
  return (
    <LocalEnvironmentsSettingsPage
      open={open}
      active
      projects={projects}
      activeProjectId={activeProjectId}
      initialProjectId={initialLocalEnvironmentProjectId}
      initialConfigPath={initialLocalEnvironmentConfigPath}
      onAddProject={onRequestProjectPickerOpen}
      renderShell={({ title, subtitle, backSlot, action, children }) => (
        <SettingsPageSurface title={title} subtitle={subtitle} backSlot={backSlot} action={action}>
          {children}
        </SettingsPageSurface>
      )}
    />
  );
}

export function BackupsSettingsPage({ open }: SettingsSectionPageProps) {
  const library = useLibraryMetadata(open);
  return (
    <SettingsPageSurface
      title="Backups"
      subtitle="Snapshot cadence, retention, and restore operations."
    >
      {library.data?.libraryId ? (
        <div className="mb-5">
          <RecoveryEntry
            scope={{ libraryId: library.data.libraryId, accessContext: { kind: "library" } }}
            alwaysVisible
          />
        </div>
      ) : null}
      <BackupSettingsControl open={open} />
    </SettingsPageSurface>
  );
}

export const SETTINGS_PAGE_COMPONENTS: SettingsPageComponentRegistry = {
  general: GeneralSettingsPage,
  appearance: AppearanceSettingsPage,
  voice: VoiceSettingsPage,
  browser: BrowserSettingsPage,
  "computer-use": ComputerUseSettingsPage,
  "keyboard-shortcuts": KeyboardShortcutsSettingsPage,
  agent: AgentSettingsPage,
  import: AgentImportSettingsPage,
  page: PageSettingsPage,
  git: GitSettingsPage,
  worktrees: WorktreesSettingsPage,
  "local-environments": LocalEnvironmentsSettingsSectionPage,
  hooks: WorkbenchHooksSettingsPage,
  "data-controls": ArchivedChatsSettingsPage,
  backups: BackupsSettingsPage,
};
