import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import {
  environmentDraftInput,
  validateEnvironmentDraft,
  type ClaudeEnvironmentDraft,
} from "../../lib/claude-environment-editor";
import { ClaudeEnvironmentEditor } from "./claude-environment-editor";
import { useEffect, useState } from "react";
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
  const [environment, setEnvironment] = useState<ClaudeEnvironmentDraft[]>([]);
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
        const instance =
          value.instances.find(({ id }) => id === "claude-default") ?? defaultClaudeInstance();
        setDraft(instance);
        setEnvironment(
          instance.environment.map((variable) => ({ ...variable, id: crypto.randomUUID() })),
        );
        setLoading(false);
      })
      .catch((cause) => {
        if (active) {
          setError(String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [open, runtime]);
  const save = async () => {
    if (saving || loading) return;
    const validation = validateEnvironmentDraft(environment);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await runtime.update({
        instances: [
          ...settings.instances.filter(({ id }) => id !== draft.id),
          { ...draft, environment: environmentDraftInput(environment) },
        ],
      });
      setSettings(next);
      const saved = next.instances.find(({ id }) => id === draft.id);
      if (saved) {
        setDraft(saved);
        setEnvironment(
          saved.environment.map((variable) => ({ ...variable, id: crypto.randomUUID() })),
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
      <NodexSettingsRow
        label="Claude Code"
        description="Uses your Claude Code login, instructions, skills, hooks, and MCP servers."
      >
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
      <div className="flex items-center justify-end gap-3 p-3">
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={loading || saving || !draft.binaryPath.trim()}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </NodexButton>
      </div>
    </>
  );
}
