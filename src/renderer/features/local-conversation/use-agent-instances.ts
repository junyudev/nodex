import { useCallback, useEffect, useState } from "react";
import { isRemoteSpace } from "../../lib/renderer-space";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";
import { agentBackendKindOfRuntimeDriver } from "../../../shared/agent-backend";
import {
  readAcpAgentSettings,
  readClaudeAgentSettings,
} from "../../lib/workbench-settings-runtime";
import { readOpenCodeAgentSettings } from "../../lib/opencode-agent-settings-runtime";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import type { AgentCatalogInstance } from "./use-agent-model-catalog";
import { usesHostOpenCodeExecutable } from "../opencode-setup/opencode-setup-model";

/** Team inventory comes from its execution owner; personal inventory uses this Desktop's settings. */
const readInstances = async (): Promise<readonly AgentCatalogInstance[]> => {
  if (isRemoteSpace()) {
    const providers = await agentRuntimeRuntime.catalog();
    return providers.flatMap((provider): AgentCatalogInstance[] => {
      const kind = agentBackendKindOfRuntimeDriver(provider.driver);
      if (!kind || kind === "codex") return [];
      return [
        {
          binding:
            kind === "acp"
              ? {
                  kind,
                  instanceConfigId: provider.instanceId,
                  runtimeInstanceId: provider.instanceId,
                  agentDefinitionId: provider.instanceId,
                }
              : {
                  kind,
                  instanceConfigId: provider.instanceId,
                  runtimeInstanceId: provider.instanceId,
                },
          label: provider.displayName ?? "Agent",
          enabled: provider.enabled,
          usesHostExecutable: false,
        },
      ];
    });
  }
  const [claude, opencode, acp] = await Promise.all([
    readClaudeAgentSettings(),
    readOpenCodeAgentSettings(),
    readAcpAgentSettings(),
  ]);
  return [
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
      label: instance.displayName,
      enabled: instance.enabled,
    })),
  ];
};

/** Each runtime remains responsible for its model catalog. */
export function useAgentInstances() {
  const [state, setState] = useState<{
    readonly instances: readonly AgentCatalogInstance[];
    readonly revision: number;
    readonly error: string | null;
  }>({ instances: [], revision: -1, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => resolveRendererTransport().subscribeAgentSettingsChanges(refresh), [refresh]);
  useEffect(() => {
    let disposed = false;
    void readInstances()
      .then((instances) => {
        if (disposed) return;
        setState({ revision, error: null, instances });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          instances: [],
          revision,
          error: error instanceof Error ? error.message : "Could not load Agent profiles",
        });
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  return {
    instances: state.instances,
    loading: state.revision !== revision,
    error: state.revision === revision ? state.error : null,
    refresh,
  };
}
