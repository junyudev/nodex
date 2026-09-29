import { useEffect, useState } from "react";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import type { ClaudeDiscovery } from "../../../shared/claude-models";

const defaultOptions: readonly AgentSessionConfigSelectOption[] = [];
const freshnessMs = 60_000;
const failureDelaysMs = [1_000, 4_000, 15_000] as const;
const subscribeSettings = (listener: () => void) =>
  resolveRendererTransport().subscribeClaudeAgentSettingsChanges(listener);

/** Discovery follows the draft's Project and Claude instance; late replies cannot cross scopes. */
export function useClaudeModelCatalog(
  instanceConfigId: string | null,
  projectId: string | null,
  read = agentBackendRuntime.claudeDiscovery,
  subscribe = subscribeSettings,
) {
  const key = JSON.stringify([instanceConfigId, projectId]);
  const [catalog, setCatalog] = useState<{
    key: string;
    options: readonly AgentSessionConfigSelectOption[];
    error: string | null;
    discovery: ClaudeDiscovery | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribe(() => setRevision((current) => current + 1)), [subscribe]);
  useEffect(() => {
    if (!instanceConfigId) return;
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
    const refresh = async () => {
      if (disposed || controller) return;
      controller = new AbortController();
      try {
        const discovery = await read({ instanceConfigId, projectId }, controller.signal);
        if (disposed) return;
        failures = 0;
        setCatalog({ key, options: discovery.models, discovery, error: discovery.health.error });
        schedule(freshnessMs);
      } catch {
        if (disposed) return;
        setCatalog((previous) => ({
          ...(previous?.key === key ? previous : { options: defaultOptions, discovery: null }),
          key,
          error: "Could not discover Claude models. Reconnect or update the selected profile.",
        }));
        schedule(failureDelaysMs[failures++] ?? freshnessMs);
      } finally {
        controller = null;
      }
    };
    const refreshWhenDue = () => {
      if (disposed || controller || !visible() || Date.now() < nextRefreshAt) return;
      void refresh();
    };
    window.addEventListener("focus", refreshWhenDue);
    document.addEventListener("visibilitychange", refreshWhenDue);
    void refresh();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenDue);
      document.removeEventListener("visibilitychange", refreshWhenDue);
    };
  }, [instanceConfigId, projectId, key, read, revision]);
  return catalog?.key === key ? catalog : { options: defaultOptions, error: null, discovery: null };
}
