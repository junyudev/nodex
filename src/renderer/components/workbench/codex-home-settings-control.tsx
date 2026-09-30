import { useEffect, useState } from "react";
import type {
  CodexHomeSettingsSnapshot,
  CodexHomeSettingsUpdateInput,
} from "../../../shared/codex-home-settings";
import { NodexButton } from "../ui/button";
import { Input } from "../ui/input";
import { NodexSettingsRow } from "../ui/settings";
import { readCodexHomeSettings, updateCodexHomeSettings } from "./workbench-settings-overlay-deps";

export interface CodexHomeSettingsRuntime {
  readonly read: () => Promise<CodexHomeSettingsSnapshot>;
  readonly update: (input: CodexHomeSettingsUpdateInput) => Promise<CodexHomeSettingsSnapshot>;
}

const defaultRuntime: CodexHomeSettingsRuntime = {
  read: readCodexHomeSettings,
  update: updateCodexHomeSettings,
};

export function CodexHomeSettingsControl({
  open,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: CodexHomeSettingsRuntime;
}) {
  const [settings, setSettings] = useState<CodexHomeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [accountDraft, setAccountDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSettings(null);
    setError(null);
    void runtime.read().then(
      (value) => {
        if (!active) return;
        setSettings(value);
        setDraft(value.homePath);
        setAccountDraft(value.accountHomePath);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [open, runtime]);

  const changed = Boolean(
    settings &&
    (draft.trim() !== settings.homePath || accountDraft.trim() !== settings.accountHomePath),
  );
  const save = async () => {
    if (!settings || saving || !changed) return;
    setSaving(true);
    setError(null);
    try {
      const next = await runtime.update({ homePath: draft, accountHomePath: accountDraft });
      setSettings(next);
      setDraft(next.homePath);
      setAccountDraft(next.accountHomePath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <NodexSettingsRow label="Codex home" description={settings?.activeHomePath}>
        <Input
          aria-label="Codex home"
          className="w-64 max-w-full"
          value={draft}
          placeholder="Default"
          disabled={!settings || saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void save();
          }}
        />
      </NodexSettingsRow>
      <NodexSettingsRow
        label="Account directory"
        description={
          <>
            {settings?.activeAccountHomePath ?? "Uses Codex home"}
            {settings?.restartRequired ? (
              <div role="status">Restart Nodex to apply the saved directories.</div>
            ) : null}
            {error ? (
              <div role="alert" className="text-destructive">
                {error}
              </div>
            ) : null}
          </>
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <Input
            aria-label="Codex account directory"
            className="w-64 max-w-full"
            value={accountDraft}
            placeholder="Same as Codex home"
            disabled={!settings || saving}
            onChange={(event) => setAccountDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void save();
            }}
          />
          <NodexButton
            variant="secondary"
            size="sm"
            disabled={!settings || saving || !changed}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </NodexButton>
        </div>
      </NodexSettingsRow>
    </>
  );
}
