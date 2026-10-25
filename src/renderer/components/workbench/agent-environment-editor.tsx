import { useId, useState, type ClipboardEvent } from "react";
import { ENVIRONMENT_VALUE_LIMIT } from "../../../shared/agent-environment";
import {
  environmentAssignmentPaste,
  environmentIsSensitive,
  mergeEnvironmentPaste,
  parseEnvironmentAssignments,
  type AgentEnvironmentDraft,
  type AgentEnvironmentPolicy,
} from "../../lib/agent-environment-editor";
import { Input } from "../ui/input";
import { NodexButton } from "../ui/button";
import { NodexCheckbox, NodexSettingsRow } from "../ui/settings";

const emptySuggestedNames: readonly string[] = [];

export function AgentEnvironmentEditor({
  rows,
  disabled,
  onChange,
  policy,
  suggestedNames = emptySuggestedNames,
}: {
  readonly rows: readonly AgentEnvironmentDraft[];
  readonly disabled: boolean;
  readonly onChange: (rows: AgentEnvironmentDraft[]) => void;
  readonly policy: AgentEnvironmentPolicy;
  readonly suggestedNames?: readonly string[];
}) {
  const namesId = useId();
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<AgentEnvironmentDraft>) => {
    setError(null);
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>, allowBareAssignment = false) => {
    const text = event.clipboardData.getData("text/plain");
    if (!environmentAssignmentPaste(text, allowBareAssignment)) return;
    event.preventDefault();
    const parsed = parseEnvironmentAssignments(text, policy);
    if (parsed.error !== undefined) {
      setError(parsed.error);
      return;
    }
    const next = mergeEnvironmentPaste(rows, parsed.variables);
    if (next.length > policy.limit) {
      setError(`Use at most ${policy.limit} variables.`);
      return;
    }
    setError(null);
    onChange(next);
  };
  return (
    <div>
      <NodexSettingsRow
        variant="nested"
        label="Environment variables"
        description="Paste a .env file or export lines to add several at once."
      >
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={disabled || rows.length >= policy.limit}
          onClick={() =>
            onChange([...rows, { id: crypto.randomUUID(), name: "", value: "", sensitive: true }])
          }
        >
          Add variable
        </NodexButton>
      </NodexSettingsRow>
      <datalist id={namesId}>
        {suggestedNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {rows.length > 0 && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          {rows.map((row, index) => (
            <div key={row.id} className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                className="h-8 min-w-0 flex-1 basis-48 font-mono text-xs"
                aria-label={`Variable name ${index + 1}`}
                placeholder="VARIABLE_NAME"
                list={namesId}
                value={row.name}
                disabled={disabled || row.value === null}
                maxLength={128}
                spellCheck={false}
                autoComplete="off"
                onPaste={(event) => paste(event, true)}
                onChange={(event) =>
                  update(row.id, {
                    name: event.target.value,
                    sensitive: environmentIsSensitive(event.target.value.trim()),
                  })
                }
              />
              <Input
                className="h-8 min-w-0 flex-1 basis-48 font-mono text-xs"
                aria-label={`Variable value ${index + 1}`}
                type={row.sensitive ? "password" : "text"}
                value={row.value ?? ""}
                disabled={disabled}
                maxLength={ENVIRONMENT_VALUE_LIMIT}
                placeholder={
                  row.value === null ? "Saved secret — enter to replace" : "Value (can be empty)"
                }
                autoComplete="off"
                spellCheck={false}
                onPaste={paste}
                onChange={(event) => update(row.id, { value: event.target.value })}
              />
              <label className="flex items-center gap-1.5 text-xs text-token-text-secondary">
                <NodexCheckbox
                  ariaLabel={`Secret variable ${index + 1}`}
                  checked={row.sensitive}
                  disabled={disabled || row.value === null}
                  onCheckedChange={(sensitive) => update(row.id, { sensitive })}
                />
                Secret
              </label>
              <NodexButton
                variant="ghost"
                size="sm"
                aria-label={`Remove variable ${index + 1}`}
                disabled={disabled}
                onClick={() => {
                  setError(null);
                  onChange(rows.filter(({ id }) => id !== row.id));
                }}
              >
                ×
              </NodexButton>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
