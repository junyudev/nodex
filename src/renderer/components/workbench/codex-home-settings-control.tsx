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
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [open, runtime]);

  const save = async () => {
    if (!settings || saving || draft.trim() === settings.homePath) return;
    setSaving(true);
    setError(null);
    try {
      const next = await runtime.update({ homePath: draft });
      setSettings(next);
      setDraft(next.homePath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <NodexSettingsRow
      label="Codex home"
      description={
        <>
          {settings?.activeHomePath}
          {settings?.restartRequired ? (
            <div role="status">Restart Nodex to use {settings.resolvedHomePath}.</div>
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
        <NodexButton
          variant="secondary"
          size="sm"
          disabled={!settings || saving || draft.trim() === settings.homePath}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </NodexButton>
      </div>
    </NodexSettingsRow>
  );
}
