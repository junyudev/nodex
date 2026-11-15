import type { AgentChoice } from "@nodex/mobile-protocol";
import { useEffect } from "react";

import { useAgentCatalog, useHosts } from "../../runtime";
import { composerDraftKey, useHomeState } from "../home/home-state";
import { atOfferedEffort, offeredEfforts } from "./agent-choice";

/**
 * How hard an open chat reasons: what its host reports, until the person picks another effort
 * here. The pick rides on their next messages and lets go once the host runs at it, so the chat
 * follows a later change made on the desktop.
 */
export const useChatEffort = (sessionId: string, agent: AgentChoice | null) => {
  const { activeHostId } = useHosts();
  const { catalog } = useAgentCatalog();
  const key = composerDraftKey(activeHostId, `chat:${sessionId}`);
  const picked = useHomeState((state) => state.efforts[key] ?? null);
  const setEffort = useHomeState((state) => state.setEffort);
  const reported = agent?.reasoningEffort ?? null;
  const efforts = offeredEfforts(catalog, agent);
  const selected = agent ? atOfferedEffort(catalog, agent, picked).reasoningEffort : null;

  useEffect(() => {
    if (picked !== null && picked === reported) setEffort(key, null);
  }, [key, picked, reported, setEffort]);

  return {
    /** Empty when the chat's model offers no choice, which leaves nothing to show. */
    efforts,
    selected,
    label: efforts.find((effort) => effort.id === selected)?.label ?? null,
    /** What a message sent now asks its host to change; null when it already runs at `selected`. */
    pending: selected === reported ? null : selected,
    pick: (effort: string) => setEffort(key, effort),
  };
};
