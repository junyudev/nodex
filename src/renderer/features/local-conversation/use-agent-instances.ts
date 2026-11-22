import { getIntl } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { isRemoteSpace } from "../../lib/renderer-space";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";
import { CODEX_BINDING } from "../../../shared/agents/codex";
import { agentDefinition, profileAgentDefinitions } from "../../../shared/agents/registry";
import { readAcpAgentSettings } from "../../lib/workbench-settings-runtime";
import { readAgentProfiles } from "../../lib/agent-profiles-runtime";
import type { AgentProfileDefinition } from "../../../shared/agents/profile-definition";
import { acpRegistryAgent } from "../../../shared/agents/acp-registry";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import type { AgentCatalogInstance } from "./use-agent-model-catalog";

/** Team inventory comes from its execution owner; personal inventory uses this Desktop's settings. */
const readInstances = async (): Promise<readonly AgentCatalogInstance[]> => {
  if (isRemoteSpace()) {
    const providers = await agentRuntimeRuntime.catalog();
    return providers
      .filter((provider) => provider.instanceId !== CODEX_BINDING.instanceId)
      .map((provider) => ({
        binding: { driver: provider.driver, instanceId: provider.instanceId },
        label: provider.displayName ?? agentDefinition(provider.driver).label,
        enabled: provider.enabled,
        usesHostExecutable: false,
      }));
  }
  const [profiles, acp] = await Promise.all([
    Promise.all(
      profileAgentDefinitions.map(async (definition) => {
        const { instances } = await readAgentProfiles(definition.driver);
        const profile: AgentProfileDefinition = definition.profile;
        return instances.map((instance) => ({
          binding: { driver: instance.driver, instanceId: instance.id },
          label: instance.displayName,
          enabled: instance.enabled,
          usesHostExecutable: profile.usesHostExecutable?.(instance),
        }));
      }),
    ),
    readAcpAgentSettings(),
  ]);
  return [
    ...profiles.flat(),
    ...acp.instances.map((instance) => ({
      binding: { driver: acpRegistryAgent.driver, instanceId: instance.id },
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
          error:
            error instanceof Error
              ? error.message
              : getIntl().formatMessage({
                  id: "conversation.useAgentInstances.profilesLoadFailed",
                  defaultMessage: "Could not load Agent profiles",
                }),
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
