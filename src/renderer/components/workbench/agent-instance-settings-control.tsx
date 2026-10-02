import { useEffect, useState, type ReactNode } from "react";
import type {
  AgentEnvironmentInput,
  AgentEnvironmentVariable,
} from "../../../shared/agent-environment";
import {
  environmentDraftInput,
  validateEnvironmentDraft,
  type AgentEnvironmentDraft,
  type AgentEnvironmentPolicy,
} from "../../lib/agent-environment-editor";
import { AgentEnvironmentEditor } from "./agent-environment-editor";
import { NodexButton } from "../ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "../ui/dropdown";
import { Input } from "../ui/input";
import { NodexCheckbox, NodexSettingsRow } from "../ui/settings";

interface AgentInstanceFields {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly environment: AgentEnvironmentVariable[];
}

type InstanceInput<Instance extends AgentInstanceFields> = Omit<Instance, "environment"> & {
  readonly environment: AgentEnvironmentInput[];
};

export interface AgentInstanceSettingsRuntime<Instance extends AgentInstanceFields> {
  readonly read: () => Promise<{ readonly instances: Instance[] }>;
  readonly update: (input: { readonly instances: InstanceInput<Instance>[] }) => Promise<{
    readonly instances: Instance[];
  }>;
}

/** Shares instance editing and secret retention while each runtime owns its native settings. */
export function AgentInstanceSettingsControl<Instance extends AgentInstanceFields>({
  open,
  label,
  executablePlaceholder,
  runtime,
  defaultInstance,
  createInstance,
  environmentPolicy,
  environmentSuggestions,
  fields,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly executablePlaceholder: string;
  readonly runtime: AgentInstanceSettingsRuntime<Instance>;
  readonly defaultInstance: () => Instance;
  readonly createInstance: () => Instance;
  readonly environmentPolicy: AgentEnvironmentPolicy;
  readonly environmentSuggestions: readonly string[];
  readonly fields: (input: {
    readonly draft: Instance;
    readonly disabled: boolean;
    readonly change: (patch: Partial<Instance>) => void;
  }) => ReactNode;
}) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [draft, setDraft] = useState<Instance | null>(null);
  const [environments, setEnvironments] = useState<Record<string, AgentEnvironmentDraft[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = loading || loadFailed || saving;
  const stagedInstances = draft
    ? instances.some(({ id }) => id === draft.id)
      ? instances.map((entry) => (entry.id === draft.id ? draft : entry))
      : [...instances, draft]
    : instances;

  const acceptEnvironments = (next: readonly Instance[]) =>
    setEnvironments(
      Object.fromEntries(
        next.map((entry) => [
          entry.id,
          entry.environment.map((variable) => ({ ...variable, id: crypto.randomUUID() })),
        ]),
      ),
    );

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    void runtime.read().then(
      (next) => {
        if (!active) return;
        setInstances(next.instances);
        setDraft(next.instances[0] ?? defaultInstance());
        acceptEnvironments(next.instances);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [open, runtime, defaultInstance]);

  const change = (patch: Partial<Instance>) => {
    setError(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const choose = (id: string) => {
    const next = stagedInstances.find((entry) => entry.id === id);
    if (!next) return;
    setInstances(stagedInstances);
    setDraft(next);
    setError(null);
  };
  const add = () => {
    const next = createInstance();
    setInstances([...stagedInstances, next]);
    setDraft(next);
    setError(null);
  };
  const remove = () => {
    if (!draft) return;
    const remaining = stagedInstances.filter(({ id }) => id !== draft.id);
    setInstances(remaining);
    setDraft(remaining[0] ?? null);
    setEnvironments((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== draft.id)),
    );
    setError(null);
  };
  const save = async () => {
    if (disabled) return;
    const validation = stagedInstances
      .map((entry) => validateEnvironmentDraft(environments[entry.id] ?? [], environmentPolicy))
      .find(Boolean);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await runtime.update({
        instances: stagedInstances.map((entry) => ({
          ...entry,
          environment: environmentDraftInput(environments[entry.id] ?? [], environmentPolicy),
        })),
      });
      setInstances(next.instances);
      setDraft(next.instances.find(({ id }) => id === draft?.id) ?? next.instances[0] ?? null);
      acceptEnvironments(next.instances);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <NodexSettingsRow label="Profile">
        {draft ? (
          <NodexOptionPicker
            value={draft.id}
            options={stagedInstances.map((entry) => ({
              value: entry.id,
              label: entry.displayName,
            }))}
            search="filter"
            disabled={disabled}
            onValueChange={choose}
            triggerButton={
              <NodexSettingsDropdownTrigger aria-label={`${label} profile`}>
                {draft.displayName}
              </NodexSettingsDropdownTrigger>
            }
          />
        ) : null}
        <NodexButton
          aria-label={`Add ${label} profile`}
          size="sm"
          variant="ghost"
          disabled={disabled || stagedInstances.length >= 32}
          onClick={add}
        >
          Add
        </NodexButton>
        {draft ? (
          <NodexButton
            aria-label={`Remove ${label} profile`}
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={remove}
          >
            Remove
          </NodexButton>
        ) : null}
      </NodexSettingsRow>
      {draft ? (
        <>
          <NodexSettingsRow label="Name">
            <Input
              aria-label={`${label} profile name`}
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.displayName}
              disabled={disabled}
              onChange={(event) => change({ displayName: event.target.value } as Partial<Instance>)}
            />
          </NodexSettingsRow>
          <NodexSettingsRow label="Enabled">
            <NodexCheckbox
              ariaLabel={`Enable ${label}`}
              checked={draft.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => change({ enabled } as Partial<Instance>)}
            />
          </NodexSettingsRow>
          <NodexSettingsRow label="Executable">
            <Input
              aria-label={`${label} executable`}
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.binaryPath}
              disabled={disabled}
              placeholder={executablePlaceholder}
              spellCheck={false}
              onChange={(event) => change({ binaryPath: event.target.value } as Partial<Instance>)}
            />
          </NodexSettingsRow>
          {fields({ draft, disabled, change })}
          <AgentEnvironmentEditor
            key={draft.id}
            rows={environments[draft.id] ?? []}
            disabled={disabled}
            policy={environmentPolicy}
            suggestedNames={environmentSuggestions}
            onChange={(rows) => setEnvironments((current) => ({ ...current, [draft.id]: rows }))}
          />
        </>
      ) : null}
      <div className="flex items-center justify-end gap-3 p-3">
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={
            disabled ||
            stagedInstances.some((entry) => !entry.binaryPath.trim() || !entry.displayName.trim())
          }
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </NodexButton>
      </div>
    </>
  );
}
