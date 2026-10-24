import { useSyncExternalStore } from "react";
import { acpAgentsRuntime } from "../../lib/acp-agents-runtime";
import { resolveRendererTransport } from "../../lib/renderer-transport";
import {
  createAcpAgentsOwner,
  type AcpAgentsOwner,
  type AcpAgentsSnapshot,
} from "./acp-agents-owner";

const JOURNAL_KEY = "nodex.acp-agents.operations.v1";

/** This window's ACP management view; its operation journal survives a renderer reload. */
export const acpAgentsOwner: AcpAgentsOwner = createAcpAgentsOwner({
  runtime: acpAgentsRuntime,
  subscribeChanges: (listener) =>
    resolveRendererTransport().subscribeAgentSettingsChanges(listener),
  journal: {
    read: () => window.sessionStorage.getItem(JOURNAL_KEY),
    write: (value) =>
      value === null
        ? window.sessionStorage.removeItem(JOURNAL_KEY)
        : window.sessionStorage.setItem(JOURNAL_KEY, value),
  },
});

export function useAcpAgents(owner: AcpAgentsOwner = acpAgentsOwner): AcpAgentsSnapshot {
  return useSyncExternalStore(owner.subscribe, owner.getSnapshot);
}
