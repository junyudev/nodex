import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { localAgentsRuntime } from "@/lib/local-agents-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { LocalAgentFound, LocalAgentId } from "../../../shared/local-agents";
import type { AcpAgentsOwner } from "../acp-agents/acp-agents-owner";
import { acpAgentsOwner, useAcpAgents } from "../acp-agents/use-acp-agents";
import { localAgentInstance, localAgentSuggestions } from "./local-agents-model";

/** Main caches a scan briefly too; this keeps one answer while setup and Settings are open. */
const SCAN_STALE_MS = 30_000;

async function connectLocalAgent(
  owner: AcpAgentsOwner,
  agent: LocalAgentFound,
): Promise<string | null> {
  const instance = localAgentInstance(agent);
  const outcome = await owner.addInstance(instance);
  if (!outcome.ok) {
    toast.danger(outcome.message);
    return null;
  }
  owner.connect(instance.id);
  return instance.id;
}

/**
 * Agents installed on this computer that Nodex can connect in one step. Connecting adds an
 * ordinary ACP instance that runs the found command, then connects it.
 */
export function useLocalAgentSuggestions(owner: AcpAgentsOwner = acpAgentsOwner) {
  const client = useQueryClient();
  const scan = useQuery({
    queryKey: queryKeys.localAgents(),
    queryFn: () => localAgentsRuntime.scan(),
    staleTime: (query) => (query.state.data?.agents.length ? SCAN_STALE_MS : 0),
    retry: 1,
    refetchOnWindowFocus: true,
  });
  const rescan = useCallback(async () => {
    const queryKey = queryKeys.localAgents();
    // A pending normal query cannot satisfy an explicit fresh scan.
    await client.cancelQueries({ queryKey, exact: true });
    await client.prefetchQuery({
      queryKey,
      queryFn: () => localAgentsRuntime.scan({ fresh: true }),
      staleTime: 0,
      retry: 1,
    });
  }, [client]);
  const acp = useAcpAgents(owner);
  const [connecting, setConnecting] = useState<LocalAgentId | null>(null);
  const suggestions = localAgentSuggestions(
    scan.data?.agents ?? [],
    acp.settings?.instances ?? null,
  );
  /** Resolves to the new instance's id, or null when it couldn't be added. */
  const connect = (agent: LocalAgentFound): Promise<string | null> => {
    if (connecting) return Promise.resolve(null);
    setConnecting(agent.id);
    return connectLocalAgent(owner, agent).finally(() => setConnecting(null));
  };
  // Settled once both answers are in; a failed read offers nothing rather than holding setup open.
  const settled = !scan.isPending && (acp.settings !== null || acp.loadError !== null);
  return { suggestions, connecting, connect, settled, rescan };
}
