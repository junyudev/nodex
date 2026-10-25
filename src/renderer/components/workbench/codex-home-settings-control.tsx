import { useState } from "react";
import type {
  CodexHomeSettingsSnapshot,
  CodexHomeSettingsUpdateInput,
} from "../../../shared/codex-home-settings";
import { useSettingsRead } from "../../lib/use-settings-read";
import { OpenAIIcon } from "../shared/icons";
import { NodexButton } from "../ui/button";
import { Input } from "../ui/input";
import {
  NodexSettingsRow,
  NodexSettingsSection,
  type NodexSettingsDisclosureState,
} from "../ui/settings";
import {
  CodexSetupImportControl,
  type CodexSetupImportRuntime,
} from "./codex-setup-import-control";
import { readCodexHomeSettings, updateCodexHomeSettings } from "./workbench-settings-overlay-deps";

export interface CodexHomeSettingsRuntime {
  readonly read: () => Promise<CodexHomeSettingsSnapshot>;
  readonly update: (input: CodexHomeSettingsUpdateInput) => Promise<CodexHomeSettingsSnapshot>;
}

const defaultRuntime: CodexHomeSettingsRuntime = {
  read: readCodexHomeSettings,
  update: updateCodexHomeSettings,
};

/** What the collapsed Codex section says about the folders Codex runs from. */
export function codexHomeSummary(settings: CodexHomeSettingsSnapshot | null): string | null {
  if (!settings) return null;
  if (settings.restartRequired) return "Restart to apply";
  const customHome = settings.source !== "default";
  const separateAccount = settings.activeAccountHomePath !== null;
  if (customHome && separateAccount) return "Custom home · separate account";
  if (customHome) return "Custom home";
  return separateAccount ? "Separate account" : "Default setup";
}

function InUsePath({ path }: { readonly path: string | null | undefined }) {
  if (!path) return null;
  return (
    <span className="block">
      In use: <bdi className="font-mono">{path}</bdi>
    </span>
  );
}

/** Settings > Agents > Codex: the native home and account Codex runs from, and setup import. */
export function CodexAgentSettingsSection({
  open,
  disclosure,
  runtime = defaultRuntime,
  importRuntime,
}: {
  readonly open: boolean;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly runtime?: CodexHomeSettingsRuntime;
  readonly importRuntime?: CodexSetupImportRuntime;
}) {
  const [settings, setSettings] = useState<CodexHomeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [accountDraft, setAccountDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = (value: CodexHomeSettingsSnapshot) => {
    setSettings(value);
    setDraft(value.homePath);
    setAccountDraft(value.accountHomePath);
  };
  const {
    reading,
    error: loadError,
    retry,
    serialize,
  } = useSettingsRead(open, () => runtime.read(), accept);
  const editable = settings !== null && !reading && loadError === null && !saving;

  const changed = Boolean(
    settings &&
    (draft.trim() !== settings.homePath || accountDraft.trim() !== settings.accountHomePath),
  );
  const save = async () => {
    if (!editable || !changed) return;
    setSaving(true);
    setError(null);
    try {
      accept(
        await serialize(() => runtime.update({ homePath: draft, accountHomePath: accountDraft })),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const saveOnEnter = (event: { key: string; preventDefault: () => void }) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  };

  return (
    <NodexSettingsSection
      id="codex"
      title="Codex"
      icon={<OpenAIIcon />}
      description="OpenAI's coding agent. Nodex shares its setup and history with the Codex app and CLI."
      summary={loadError ? "Couldn't load" : codexHomeSummary(settings)}
      disclosure={disclosure}
    >
      <NodexSettingsRow
        label="Codex home"
        description={
          <>
            Settings, skills and conversation history.
            <InUsePath path={settings?.activeHomePath} />
          </>
        }
      >
        <Input
          aria-label="Codex home"
          className="w-64 max-w-full"
          value={draft}
          placeholder="Default"
          disabled={!editable}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={saveOnEnter}
        />
      </NodexSettingsRow>
      <NodexSettingsRow
        label="Account directory"
        description={
          <>
            A separate folder for another Codex sign-in. History stays shared.
            <InUsePath path={settings?.activeAccountHomePath} />
          </>
        }
      >
        <Input
          aria-label="Codex account directory"
          className="w-64 max-w-full"
          value={accountDraft}
          placeholder="Same as Codex home"
          disabled={!editable}
          spellCheck={false}
          onChange={(event) => setAccountDraft(event.target.value)}
          onKeyDown={saveOnEnter}
        />
      </NodexSettingsRow>
      {loadError ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            Couldn't load the Codex folders. {loadError}
          </p>
          <NodexButton size="xs" variant="secondary" onClick={retry}>
            Try again
          </NodexButton>
        </div>
      ) : changed || settings?.restartRequired || error ? (
        <div className="flex min-h-12 flex-wrap items-center justify-end gap-2 px-4 py-2.5">
          <span className="min-w-0 flex-1 text-xs">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : changed ? (
              <span className="text-token-text-secondary">Applies after restarting Nodex.</span>
            ) : (
              <span role="status" className="text-token-text-secondary">
                Restart Nodex to apply the saved directories.
              </span>
            )}
          </span>
          {changed ? (
            <>
              <NodexButton
                variant="ghost"
                size="sm"
                disabled={!editable}
                onClick={() => {
                  if (!settings) return;
                  setDraft(settings.homePath);
                  setAccountDraft(settings.accountHomePath);
                  setError(null);
                }}
              >
                Discard
              </NodexButton>
              <NodexButton
                variant="secondary"
                size="sm"
                disabled={!editable}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </NodexButton>
            </>
          ) : null}
        </div>
      ) : null}
      <CodexSetupImportControl open={open} runtime={importRuntime} />
    </NodexSettingsSection>
  );
}
