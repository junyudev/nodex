import { useCallback, useEffect, useState } from "react";
import { CLAUDE_ACP_AGENT_DEFINITION } from "../../../shared/acp-agent-definitions";
import type { AcpAgentInstanceConfig, AcpAgentSettings } from "../../../shared/types";
import { NodexButton } from "../ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "../ui/dropdown";
import { Input } from "../ui/input";
import { NodexCheckbox, NodexSettingsRow as SettingRow } from "../ui/settings";
import { readAcpAgentSettings, updateAcpAgentSettings } from "./workbench-settings-overlay-deps";

const INSTANCE_ID = "claude-main";
const emptyInstance = (): AcpAgentInstanceConfig => ({
  id: INSTANCE_ID,
  agentDefinitionId: CLAUDE_ACP_AGENT_DEFINITION.id,
  packageRoot: "",
  nodeExecutable: "",
  enabled: false,
  credentials: { kind: "inherit-host-profile" },
  proxy: "inherit-host",
});

const fieldClassName = "h-8 w-[min(28rem,45vw)] text-sm";
const pickerClassName = "w-[min(28rem,45vw)]";

export interface AcpAgentSettingsRuntime {
  readonly read: () => Promise<AcpAgentSettings>;
  readonly update: (input: {
    readonly instances: AcpAgentInstanceConfig[];
  }) => Promise<AcpAgentSettings>;
}

const DEFAULT_RUNTIME: AcpAgentSettingsRuntime = {
  read: readAcpAgentSettings,
  update: updateAcpAgentSettings,
};

export function AcpAgentSettingsControl({
  open,
  runtime = DEFAULT_RUNTIME,
}: {
  readonly open: boolean;
  readonly runtime?: AcpAgentSettingsRuntime;
}) {
  const [snapshot, setSnapshot] = useState<AcpAgentSettings>({ instances: [] });
  const [draft, setDraft] = useState<AcpAgentInstanceConfig>(emptyInstance);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void runtime
      .read()
      .then((value) => {
        if (!active) return;
        setSnapshot(value);
        setDraft(value.instances.find(({ id }) => id === INSTANCE_ID) ?? emptyInstance());
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load ACP Agents.");
      });
    return () => {
      active = false;
    };
  }, [open, runtime]);

  const save = useCallback(async () => {
    if (saving) return;
    if (!draft.packageRoot.trim() || !draft.nodeExecutable.trim()) {
      setError("Package root and Node executable must be absolute paths.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const otherInstances = snapshot.instances.filter(({ id }) => id !== INSTANCE_ID);
      const next = await runtime.update({
        instances: [...otherInstances, draft],
      });
      setSnapshot(next);
      setDraft(next.instances.find(({ id }) => id === INSTANCE_ID) ?? emptyInstance());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save ACP Agent settings.");
    } finally {
      setSaving(false);
    }
  }, [draft, runtime, saving, snapshot.instances]);

  return (
    <>
      <SettingRow
        label={`${CLAUDE_ACP_AGENT_DEFINITION.title} ${CLAUDE_ACP_AGENT_DEFINITION.packageVersion}`}
        description="User-managed local code. Nodex checks ACP compatibility before launch, but does not verify the package or its dependency bytes."
      >
        <div className="flex items-center gap-2 text-sm text-token-text-secondary">
          <NodexCheckbox
            ariaLabel={`Enable ${CLAUDE_ACP_AGENT_DEFINITION.title}`}
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
          Enabled
        </div>
      </SettingRow>
      <SettingRow
        label="Package root"
        description={`Absolute folder containing your local installation of ${CLAUDE_ACP_AGENT_DEFINITION.packageName}. Enabling it authorizes that code to run with the credential policy below.`}
      >
        <Input
          aria-label="Claude ACP package root"
          className={fieldClassName}
          onChange={(event) =>
            setDraft((current) => ({ ...current, packageRoot: event.target.value }))
          }
          placeholder="/absolute/path/to/claude-agent-acp"
          spellCheck={false}
          value={draft.packageRoot}
        />
      </SettingRow>
      <SettingRow
        label="Node executable"
        description={`Node ${CLAUDE_ACP_AGENT_DEFINITION.minimumNodeMajor} or newer; checked before launch.`}
      >
        <Input
          aria-label="Claude ACP Node executable"
          className={fieldClassName}
          onChange={(event) =>
            setDraft((current) => ({ ...current, nodeExecutable: event.target.value }))
          }
          placeholder="/absolute/path/to/node"
          spellCheck={false}
          value={draft.nodeExecutable}
        />
      </SettingRow>
      <SettingRow
        label="Credentials"
        description="Use the host Claude profile, or isolate the Agent in a separate home. Secrets are never copied into Nodex settings."
      >
        <NodexOptionPicker
          value={draft.credentials.kind}
          options={[
            { value: "inherit-host-profile", label: "Use host profile" },
            { value: "isolated-home", label: "Use isolated home" },
          ]}
          onValueChange={(value) =>
            setDraft((current) => ({
              ...current,
              credentials:
                value === "isolated-home"
                  ? { kind: "isolated-home", home: "" }
                  : { kind: "inherit-host-profile" },
            }))
          }
          triggerButton={
            <NodexSettingsDropdownTrigger
              aria-label="Claude ACP credential policy"
              className={pickerClassName}
            >
              {draft.credentials.kind === "isolated-home"
                ? "Use isolated home"
                : "Use host profile"}
            </NodexSettingsDropdownTrigger>
          }
        />
      </SettingRow>
      {draft.credentials.kind === "isolated-home" ? (
        <SettingRow
          label="Isolated home"
          description="Absolute directory owned by this Agent instance."
        >
          <Input
            aria-label="Claude ACP isolated home"
            className={fieldClassName}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                credentials: { kind: "isolated-home", home: event.target.value },
              }))
            }
            placeholder="/absolute/path/to/claude-home"
            spellCheck={false}
            value={draft.credentials.home}
          />
        </SettingRow>
      ) : null}
      <SettingRow
        label="System proxy"
        description="Proxy variables are inherited only when explicitly enabled."
      >
        <NodexOptionPicker
          value={draft.proxy}
          options={[
            { value: "inherit-host", label: "Respect system proxy" },
            { value: "isolated", label: "Do not inherit proxy" },
          ]}
          onValueChange={(value) =>
            setDraft((current) => ({
              ...current,
              proxy: value === "inherit-host" ? "inherit-host" : "isolated",
            }))
          }
          triggerButton={
            <NodexSettingsDropdownTrigger
              aria-label="Claude ACP proxy policy"
              className={pickerClassName}
            >
              {draft.proxy === "inherit-host" ? "Respect system proxy" : "Do not inherit proxy"}
            </NodexSettingsDropdownTrigger>
          }
        />
      </SettingRow>
      <SettingRow
        label="ACP capability boundary"
        description="Sessions, tools, permissions, filesystem, terminal, modes, and config options are capability-negotiated. Codex-only Browser, review, and subagent features stay unavailable unless an Agent advertises a compatible extension."
      >
        <NodexButton disabled={saving} onClick={() => void save()} size="sm" variant="secondary">
          {saving ? "Saving…" : "Save Agent"}
        </NodexButton>
      </SettingRow>
      {error ? <div className="p-3 text-sm text-danger">{error}</div> : null}
    </>
  );
}
