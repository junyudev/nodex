import { useCallback, useEffect, useState } from "react";
import { NodexButton } from "@/components/ui/button";
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
