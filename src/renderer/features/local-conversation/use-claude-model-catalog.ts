import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import type { ClaudeDiscovery, ClaudeDiscoveryScope } from "../../../shared/claude-models";

const defaultOptions: readonly AgentSessionConfigSelectOption[] = [];
const freshnessMs = 60_000;
const failureDelaysMs = [1_000, 4_000, 15_000] as const;
const subscribeSettings = (listener: () => void) =>
  resolveRendererTransport().subscribeClaudeAgentSettingsChanges(listener);

/** Main resolves attached execution locations; late replies cannot cross scopes or handoffs. */
export function useClaudeModelCatalog(
  scope: ClaudeDiscoveryScope | null,
  {
    read = agentBackendRuntime.claudeDiscovery,
    subscribe = subscribeSettings,
    observedExecutionLocation = null,
  }: {
    readonly read?: typeof agentBackendRuntime.claudeDiscovery;
    readonly subscribe?: typeof subscribeSettings;
    readonly observedExecutionLocation?: string | null;
  } = {},
) {
  const threadId = scope?.kind === "thread" ? scope.threadId : null;
  const instanceConfigId = scope?.kind === "project" ? scope.instanceConfigId : null;
  const projectId = scope?.kind === "project" ? scope.projectId : null;
  const key = JSON.stringify([threadId, instanceConfigId, projectId, observedExecutionLocation]);
  const [catalog, setCatalog] = useState<{
    key: string;
    options: readonly AgentSessionConfigSelectOption[];
    error: string | null;
    discovery: ClaudeDiscovery | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const refreshOwner = useRef<{
    readonly key: string;
    readonly refresh: () => Promise<void>;
  } | null>(null);
  const refreshCatalog = useCallback(async () => {
    const owner = refreshOwner.current;
    if (owner?.key === key) await owner.refresh();
  }, [key]);
  useEffect(() => subscribe(() => setRevision((current) => current + 1)), [subscribe]);
  useEffect(() => {
    const requestScope: ClaudeDiscoveryScope | null = threadId
      ? { kind: "thread", threadId }
      : instanceConfigId
        ? { kind: "project", instanceConfigId, projectId }
        : null;
    if (!requestScope) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let nextRefreshAt = 0;
    let failures = 0;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = (delay: number) => {
      if (timer !== null) clearTimeout(timer);
      nextRefreshAt = Date.now() + delay;
      timer = setTimeout(() => {
        timer = null;
        refreshWhenDue();
      }, delay);
    };
    const refresh = async (force = false) => {
      if (disposed || (controller && !force)) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const discovery = await read(
          { scope: requestScope, ...(force ? { forceReload: true } : {}) },
          request.signal,
        );
        if (disposed || controller !== request) return;
        failures = 0;
        setCatalog({ key, options: discovery.models, discovery, error: discovery.health.error });
        schedule(freshnessMs);
      } catch {
        if (disposed || controller !== request) return;
        const error = "Could not discover Claude models. Reconnect or update the selected profile.";
        setCatalog((previous) => ({
          ...(previous?.key === key ? previous : { options: defaultOptions, discovery: null }),
          key,
          error,
        }));
        schedule(failureDelaysMs[failures++] ?? freshnessMs);
        if (force) throw new Error(error);
      } finally {
        if (controller === request) controller = null;
      }
    };
    const refreshWhenDue = () => {
      if (disposed || controller || !visible() || Date.now() < nextRefreshAt) return;
      void refresh();
    };
    window.addEventListener("focus", refreshWhenDue);
    document.addEventListener("visibilitychange", refreshWhenDue);
    const owner = { key, refresh: () => refresh(true) };
    refreshOwner.current = owner;
    void refresh();
    return () => {
      disposed = true;
      if (refreshOwner.current === owner) refreshOwner.current = null;
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenDue);
      document.removeEventListener("visibilitychange", refreshWhenDue);
    };
  }, [threadId, instanceConfigId, projectId, key, read, revision]);
  return {
    ...(catalog?.key === key ? catalog : { options: defaultOptions, error: null, discovery: null }),
    refresh: scope ? refreshCatalog : undefined,
  };
}
