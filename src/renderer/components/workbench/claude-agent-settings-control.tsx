import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import {
  environmentDraftInput,
  validateEnvironmentDraft,
  type ClaudeEnvironmentDraft,
} from "../../lib/claude-environment-editor";
import { ClaudeEnvironmentEditor } from "./claude-environment-editor";
import { useEffect, useState } from "react";
import { ClaudeCustomModelsEditor } from "./claude-custom-models-editor";
import type { ClaudeAgentSettings, UpdateClaudeAgentSettingsInput } from "../../../shared/types";
import { NodexButton } from "../ui/button";
import { Input } from "../ui/input";
import { NodexCheckbox, NodexSettingsRow } from "../ui/settings";
import {
  readClaudeAgentSettings,
  updateClaudeAgentSettings,
} from "./workbench-settings-overlay-deps";

export interface ClaudeAgentSettingsRuntime {
  readonly read: () => Promise<ClaudeAgentSettings>;
  readonly update: (input: UpdateClaudeAgentSettingsInput) => Promise<ClaudeAgentSettings>;
}
const defaultRuntime: ClaudeAgentSettingsRuntime = {
  read: readClaudeAgentSettings,
  update: updateClaudeAgentSettings,
};
export function ClaudeAgentSettingsControl({
  open,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: ClaudeAgentSettingsRuntime;
}) {
  const [settings, setSettings] = useState<ClaudeAgentSettings>({ instances: [] });
  const [draft, setDraft] = useState(defaultClaudeInstance);
  const [loading, setLoading] = useState(true);
  const [environments, setEnvironments] = useState<Record<string, ClaudeEnvironmentDraft[]>>({});
  const environment = environments[draft.id] ?? [];
  const setEnvironment = (rows: ClaudeEnvironmentDraft[]) =>
    setEnvironments((current) => ({ ...current, [draft.id]: rows }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void runtime
      .read()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        const instance = value.instances[0] ?? defaultClaudeInstance();
        setDraft(instance);
        setEnvironments(
          Object.fromEntries(
            value.instances.map((entry) => [
              entry.id,
              entry.environment.map((variable) => ({ ...variable, id: crypto.randomUUID() })),
            ]),
          ),
        );
        setLoading(false);
      })
      .catch((cause) => {
        if (active) {
          setError(String(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, runtime]);
  const stagedInstances = () =>
    settings.instances.some(({ id }) => id === draft.id)
      ? settings.instances.map((entry) => (entry.id === draft.id ? draft : entry))
      : [...settings.instances, draft];
  const choose = (id: string) => {
    const instances = stagedInstances();
    const next = instances.find((entry) => entry.id === id);
    if (!next) return;
    setSettings({ instances });
    setDraft(next);
    setError(null);
  };
  const add = () => {
    const next = {
      ...defaultClaudeInstance(),
      id: crypto.randomUUID(),
      displayName: "Claude profile",
    };
    setSettings({ instances: [...stagedInstances(), next] });
    setDraft(next);
    setError(null);
  };
  const remove = () => {
    const instances = stagedInstances().filter(({ id }) => id !== draft.id);
    setSettings({ instances });
    setDraft(instances[0] ?? { ...defaultClaudeInstance(), enabled: false });
    setEnvironments((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== draft.id)),
    );
  };
  const save = async () => {
    if (saving || loading) return;
    const validation = Object.values(environments).map(validateEnvironmentDraft).find(Boolean);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await runtime.update({
        instances: stagedInstances().map((entry) => ({
          ...entry,
          environment: environmentDraftInput(environments[entry.id] ?? []),
        })),
      });
      setSettings(next);
      const saved = next.instances.find(({ id }) => id === draft.id);
      if (saved) {
        setDraft(saved);
        setEnvironments(
          Object.fromEntries(
            next.instances.map((entry) => [
              entry.id,
              entry.environment.map((variable) => ({ ...variable, id: crypto.randomUUID() })),
            ]),
          ),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <NodexSettingsRow label="Claude profile">
        <div className="flex items-center gap-2">
          <select
            aria-label="Claude profile"
            className="h-8 bg-transparent text-sm"
            value={draft.id}
            disabled={loading || saving}
            onChange={(event) => choose(event.target.value)}
          >
            {stagedInstances().map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName}
              </option>
            ))}
          </select>
          <NodexButton size="sm" variant="ghost" disabled={loading || saving} onClick={add}>
            Add
          </NodexButton>
          <NodexButton
            size="sm"
            variant="ghost"
            disabled={loading || saving || stagedInstances().length < 2}
            onClick={remove}
          >
            Remove
          </NodexButton>
        </div>
      </NodexSettingsRow>
      <NodexSettingsRow label="Name">
        <Input
          aria-label="Claude profile name"
          className="h-8 w-[min(28rem,45vw)] text-sm"
          value={draft.displayName}
          disabled={loading || saving}
          onChange={(event) =>
            setDraft((current) => ({ ...current, displayName: event.target.value }))
          }
        />
      </NodexSettingsRow>
      <NodexSettingsRow label="Enabled">
        <NodexCheckbox
          ariaLabel="Enable Claude Code"
          checked={draft.enabled}
          disabled={loading || saving}
          onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
        />
      </NodexSettingsRow>
      <NodexSettingsRow label="Executable">
        <Input
          aria-label="Claude Code executable"
          className="h-8 w-[min(28rem,45vw)] text-sm"
          value={draft.binaryPath}
          disabled={loading || saving}
          placeholder="claude"
          spellCheck={false}
          onChange={(event) =>
            setDraft((current) => ({ ...current, binaryPath: event.target.value }))
          }
        />
      </NodexSettingsRow>
      <NodexSettingsRow
        label="Config directory"
        description="Leave empty to use your normal Claude Code account."
      >
        <Input
          aria-label="Claude Code config directory"
          className="h-8 w-[min(28rem,45vw)] text-sm"
          value={draft.configDirectory}
          disabled={loading || saving}
          placeholder="Default"
          spellCheck={false}
          onChange={(event) =>
            setDraft((current) => ({ ...current, configDirectory: event.target.value }))
          }
        />
      </NodexSettingsRow>
      <ClaudeEnvironmentEditor
        rows={environment}
        disabled={loading || saving}
        onChange={setEnvironment}
      />
      <ClaudeCustomModelsEditor
        models={draft.customModels}
        disabled={loading || saving}
        onChange={(customModels) => setDraft((current) => ({ ...current, customModels }))}
      />
      <div className="flex items-center justify-end gap-3 p-3">
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={loading || saving || !draft.binaryPath.trim() || !draft.displayName.trim()}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </NodexButton>
      </div>
    </>
  );
}
