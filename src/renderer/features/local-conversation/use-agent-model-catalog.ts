import { useCallback, useEffect, useState } from "react";
import type {
  AgentModelCatalog,
  AgentModelCatalogInput,
  ExternalAgentBinding,
} from "../../../shared/agent-model-catalog";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import { agentBindingKey } from "../../lib/agent-model-selection";

export interface AgentCatalogInstance {
  readonly binding: ExternalAgentBinding;
  readonly label: string;
  readonly enabled: boolean;
  /** Runs the host's default executable, which host setup can install. */
  readonly usesHostExecutable?: boolean;
}

export interface AgentCatalogEntry {
  readonly instance: AgentCatalogInstance;
  readonly catalog: AgentModelCatalog | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const subscribeSettings = (listener: () => void) =>
  resolveRendererTransport().subscribeAgentSettingsChanges(listener);

/** Catalog responses are fenced by exact Project, runtime instance and attached execution scope. */
export function useAgentModelCatalogs(
  input: {
    readonly instances: readonly AgentCatalogInstance[];
    readonly projectId: string | null;
    readonly threadId?: string | null;
    readonly observedExecutionLocation?: string | null;
  },
  {
    read = agentBackendRuntime.modelCatalog,
    subscribe = subscribeSettings,
  }: {
    readonly read?: typeof agentBackendRuntime.modelCatalog;
    readonly subscribe?: typeof subscribeSettings;
  } = {},
) {
  const key = JSON.stringify([
    input.projectId,
    input.threadId ?? null,
    input.observedExecutionLocation ?? null,
    input.instances.filter((instance) => instance.enabled).map((instance) => instance.binding),
  ]);
  const [state, setState] = useState<{
    readonly key: string;
    readonly entries: ReadonlyMap<string, Omit<AgentCatalogEntry, "instance">>;
  } | null>(null);
  const [refresh, setRefresh] = useState({ revision: 0, force: false });
  const refreshCatalogs = useCallback(() => {
    setRefresh((current) => ({ revision: current.revision + 1, force: true }));
  }, []);
  useEffect(
    () =>
      subscribe(() => setRefresh((current) => ({ revision: current.revision + 1, force: false }))),
    [subscribe],
  );
  useEffect(() => {
    const [projectId, threadId, , bindings] = JSON.parse(key) as [
      string | null,
      string | null,
      string | null,
      readonly ExternalAgentBinding[],
    ];
    const controller = new AbortController();
    const entries = new Map<string, Omit<AgentCatalogEntry, "instance">>();
    setState({ key, entries });
    let next = 0;
    const loadNext = async () => {
      while (!controller.signal.aborted) {
        const binding = bindings[next++];
        if (!binding) return;
        const scope: AgentModelCatalogInput["scope"] = threadId
          ? { kind: "thread", threadId }
          : { kind: "project", projectId, binding };
        try {
          const catalog = await read(
            { scope, ...(refresh.force ? { forceReload: true } : {}) },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (agentBindingKey(catalog.binding) !== agentBindingKey(binding))
            throw new Error("This model catalog belongs to another Agent instance");
          entries.set(agentBindingKey(binding), {
            catalog,
            loading: false,
            error: catalog.health.error,
          });
        } catch (error: unknown) {
          if (controller.signal.aborted) return;
          entries.set(agentBindingKey(binding), {
            catalog: null,
            loading: false,
            error: error instanceof Error ? error.message : "Could not load models",
          });
        }
        setState({ key, entries: new Map(entries) });
      }
    };
    // Discovery can start native processes and crosses a bounded per-viewer request boundary.
    for (let worker = 0; worker < Math.min(2, bindings.length); worker++) void loadNext();
    return () => controller.abort();
  }, [key, read, refresh]);
  const entries: readonly AgentCatalogEntry[] = input.instances
    .filter((instance) => instance.enabled)
    .map((instance) => ({
      instance,
      ...(state?.key === key ? state.entries.get(agentBindingKey(instance.binding)) : undefined),
      catalog:
        state?.key === key
          ? (state.entries.get(agentBindingKey(instance.binding))?.catalog ?? null)
          : null,
      loading:
        state?.key === key
          ? (state.entries.get(agentBindingKey(instance.binding))?.loading ?? true)
          : true,
      error:
        state?.key === key
          ? (state.entries.get(agentBindingKey(instance.binding))?.error ?? null)
          : null,
    }));
  return { entries, refresh: refreshCatalogs };
}
