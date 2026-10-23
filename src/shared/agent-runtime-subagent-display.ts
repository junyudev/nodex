import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { projectCodexSubagentPathDisplayName } from "./codex-subagent-display";

type SubagentDisplaySource = Pick<
  Extract<AgentTurnItem, { type: "subagent" }>,
  "driver" | "origin" | "title"
>;

/**
 * Codex reports native activity paths as task titles. Keep that path as detail while
 * presenting the same readable name across the transcript, overview and child tabs.
 * Application-authored titles and other providers' names are never interpreted as paths.
 */
export function projectAgentRuntimeSubagentDisplay(source: SubagentDisplaySource): {
  readonly displayName: string | null;
  readonly agentPath: string | null;
} {
  const title = source.title?.trim() || null;
  if (
    source.origin !== "provider_native" ||
    source.driver !== "codex" ||
    title === null ||
    !/^\/root\/[^/\s]+(?:\/[^/\s]+)*$/u.test(title)
  )
    return { displayName: title, agentPath: null };

  return {
    displayName: projectCodexSubagentPathDisplayName(title),
    agentPath: title,
  };
}
