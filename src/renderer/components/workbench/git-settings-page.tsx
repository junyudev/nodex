import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { isCodexGitSettings } from "../../../shared/codex-git-settings";
import type { CodexGitSettings } from "../../lib/types";
import { readGitSettings, updateGitSettings } from "./workbench-settings-overlay-deps";
import { WorktreeAutoBranchPrefixSettingControl } from "./workbench-settings-controls";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
  NodexSettingsStackedRow,
} from "../ui/settings";

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

  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setDraft(value);
  }

  const changed = draft !== value;
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    return runWithCleanup(
      async () => {
        await onSave(draft);
      },
      { cleanup: () => setSaving(false) },
    );
  };

  // Saves when the field loses focus, like every other instruction field in Settings.
  return (
    <NodexSettingsStackedRow label={label} description={description}>
      <Textarea
        variant="settings"
        aria-label={ariaLabel}
        className="text-sm"
        disabled={saving}
        onBlur={() => void save()}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        rows={6}
        value={draft}
      />
    </NodexSettingsStackedRow>
  );
}

export function GitSettingsPage({
  onWorktreeAutoBranchPrefixChange,
  open,
  worktreeAutoBranchPrefix,
}: SettingsSectionPageProps) {
  const intl = useIntl();
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
        if (!isCodexGitSettings(next))
          throw new Error(
            getIntl().formatMessage({
              id: "settings.git.gitSettingsAreUnavailable",
              defaultMessage: "Git settings are unavailable",
            }),
          );
        setSettings((current) =>
          current.branchPrefix === next.branchPrefix &&
          current.commitInstructions === next.commitInstructions &&
          current.pullRequestInstructions === next.pullRequestInstructions
            ? current
            : next,
        );
      })
      .catch(() => {
        if (!disposed)
          toast.danger(
            getIntl().formatMessage({
              id: "settings.git.failedToLoadGitSettings",
              defaultMessage: "Failed to load Git settings",
            }),
          );
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const saveBranchPrefix = async (branchPrefix: string) => {
    if (branchSaving) return;
    setBranchSaving(true);
    return runWithCleanup(
      async () => {
        const next = await updateGitSettings({ branchPrefix });
        if (!isCodexGitSettings(next))
          throw new Error(
            intl.formatMessage({
              id: "settings.git.gitSettingsAreUnavailable",
              defaultMessage: "Git settings are unavailable",
            }),
          );
        setSettings(next);
        onWorktreeAutoBranchPrefixChange(next.branchPrefix);
        toast.success(
          intl.formatMessage({
            id: "settings.git.savedBranchPrefix",
            defaultMessage: "Saved branch prefix",
          }),
        );
      },
      {
        onError: () => {
          toast.danger(
            intl.formatMessage({
              id: "settings.git.failedToSaveBranchPrefix",
              defaultMessage: "Failed to save branch prefix",
            }),
          );
        },
        cleanup: () => {
          setBranchSaving(false);
        },
      },
    );
  };

  const saveInstructions = async (
    patch:
      | Pick<CodexGitSettings, "commitInstructions">
      | Pick<CodexGitSettings, "pullRequestInstructions">,
    successMessage: string,
    errorMessage: string,
  ) => {
    return runWithCleanup(
      async () => {
        const next = await updateGitSettings(patch);
        if (!isCodexGitSettings(next))
          throw new Error(
            intl.formatMessage({
              id: "settings.git.gitSettingsAreUnavailable",
              defaultMessage: "Git settings are unavailable",
            }),
          );
        setSettings(next);
        toast.success(successMessage);
      },
      {
        onError: () => {
          toast.danger(errorMessage);
        },
      },
    );
  };

  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.gitTitle)}
      subtitle={intl.formatMessage(settingsMessages.gitBranchNamingAndInstructionsUsedBy)}
    >
      <SectionBlock title={intl.formatMessage(settingsMessages.gitBranches)}>
        <SettingRow
          label={intl.formatMessage(settingsMessages.gitBranchPrefixLabel)}
          description={intl.formatMessage(settingsMessages.gitBranchPrefixDescription)}
        >
          <WorktreeAutoBranchPrefixSettingControl
            disabled={branchSaving}
            value={settings.branchPrefix}
            onChange={(branchPrefix) => void saveBranchPrefix(branchPrefix)}
          />
        </SettingRow>
      </SectionBlock>
      <SectionBlock>
        <GitInstructionSettingControl
          ariaLabel={intl.formatMessage(settingsMessages.gitCommitInstructionsLabel)}
          description={intl.formatMessage(settingsMessages.gitCommitInstructionsDescription)}
          label={intl.formatMessage(settingsMessages.gitCommitInstructionsLabel)}
          onSave={(commitInstructions) =>
            saveInstructions(
              { commitInstructions },
              intl.formatMessage({
                id: "settings.git.savedCommitInstructions",
                defaultMessage: "Saved commit instructions",
              }),
              intl.formatMessage({
                id: "settings.git.failedToSaveCommitInstructions",
                defaultMessage: "Failed to save commit instructions",
              }),
            )
          }
          placeholder={intl.formatMessage(settingsMessages.gitCommitInstructionsPlaceholder)}
          value={settings.commitInstructions}
        />
        <GitInstructionSettingControl
          ariaLabel={intl.formatMessage(settingsMessages.gitPullRequestInstructionsLabel)}
          description={intl.formatMessage(settingsMessages.gitPullRequestInstructionsDescription)}
          label={intl.formatMessage(settingsMessages.gitPullRequestInstructionsLabel)}
          onSave={(pullRequestInstructions) =>
            saveInstructions(
              { pullRequestInstructions },
              intl.formatMessage({
                id: "settings.git.savedPullRequestInstructions",
                defaultMessage: "Saved pull request instructions",
              }),
              intl.formatMessage({
                id: "settings.git.failedToSavePullRequestInstructions",
                defaultMessage: "Failed to save pull request instructions",
              }),
            )
          }
          placeholder={intl.formatMessage(settingsMessages.gitPullRequestInstructionsPlaceholder)}
          value={settings.pullRequestInstructions}
        />
      </SectionBlock>
    </SettingsPageSurface>
  );
}
