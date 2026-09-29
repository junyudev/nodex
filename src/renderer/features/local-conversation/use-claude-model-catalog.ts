import { useEffect, useState } from "react";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { CLAUDE_DEFAULT_MODEL } from "../../../shared/claude-models";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";

const defaultOptions = [CLAUDE_DEFAULT_MODEL];

/** Discovery follows the draft's Project and Claude instance; late replies cannot cross scopes. */
export function useClaudeModelCatalog(
  instanceConfigId: string | null,
  projectId: string | null,
  read = agentBackendRuntime.claudeModels,
) {
  const key = JSON.stringify([instanceConfigId, projectId]);
  const [catalog, setCatalog] = useState<{
    key: string;
    options: readonly AgentSessionConfigSelectOption[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!instanceConfigId || !projectId) return;
    let disposed = false;
    void read({ instanceConfigId, projectId }).then(
      (options) => {
        if (!disposed) setCatalog({ key, options, error: null });
      },
      () => {
        if (!disposed)
          setCatalog({
            key,
            options: defaultOptions,
            error: "Could not load Claude models. Check the executable in Agent settings.",
          });
      },
    );
    return () => {
      disposed = true;
    };
  }, [instanceConfigId, projectId, key, read]);
  return catalog?.key === key ? catalog : { options: defaultOptions, error: null };
}
