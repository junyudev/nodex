import { useCallback, useEffect, useState } from "react";
import {
  readAcpAgentSettings,
  readClaudeAgentSettings,
} from "../../lib/workbench-settings-runtime";
import { readOpenCodeAgentSettings } from "../../lib/opencode-agent-settings-runtime";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import type { AgentCatalogInstance } from "./use-agent-model-catalog";
import { usesHostOpenCodeExecutable } from "../opencode-setup/opencode-setup-model";

/** Settings supply runtime identity; each runtime remains responsible for its model catalog. */
export function useAgentInstances() {
  const [state, setState] = useState<{
    readonly instances: readonly AgentCatalogInstance[];
    readonly loading: boolean;
    readonly error: string | null;
  }>({ instances: [], loading: true, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => resolveRendererTransport().subscribeAgentSettingsChanges(refresh), [refresh]);
  useEffect(() => {
    let disposed = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void Promise.all([
      readClaudeAgentSettings(),
      readOpenCodeAgentSettings(),
      readAcpAgentSettings(),
    ])
      .then(([claude, opencode, acp]) => {
        if (disposed) return;
        setState({
          loading: false,
          error: null,
          instances: [
            ...claude.instances.map((instance) => ({
              binding: { kind: "claude" as const, instanceConfigId: instance.id },
              label: instance.displayName,
              enabled: instance.enabled,
            })),
            ...opencode.instances.map((instance) => ({
              binding: { kind: "opencode" as const, instanceConfigId: instance.id },
              label: instance.displayName,
              enabled: instance.enabled,
              usesHostExecutable: usesHostOpenCodeExecutable(instance),
            })),
            ...acp.instances.map((instance) => ({
              binding: {
                kind: "acp" as const,
                instanceConfigId: instance.id,
                agentDefinitionId: instance.agentDefinitionId,
              },
              label:
                instance.agentDefinitionId === "claude-agent-acp"
                  ? "Claude Agent"
                  : instance.agentDefinitionId,
              enabled: instance.enabled,
            })),
          ],
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          instances: [],
          loading: false,
          error: error instanceof Error ? error.message : "Could not load Agent profiles",
        });
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  return { ...state, refresh };
}
