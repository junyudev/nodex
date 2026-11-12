import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPluginResult, PluginPreview } from "../../../shared/agent-plugins/ipc";
import {
  agentPluginAdapter,
  agentPluginListKey,
  agentPluginListOptions,
} from "../../lib/agent-plugin-adapter";
import { toast } from "@/components/ui/toast";

export type AgentPluginAction =
  | { readonly kind: "install"; readonly directory: string; readonly previewDigest: string }
  | { readonly kind: "reload"; readonly id: string }
  | {
      readonly kind: "set-project-enabled";
      readonly id: string;
      readonly projectId: string;
      readonly enabled: boolean;
    }
  | { readonly kind: "uninstall"; readonly id: string; readonly data: "keep" | "delete" }
  | { readonly kind: "repair-writer" };

export interface AgentPluginManagement {
  readonly reviewFolder: () => Promise<
    AgentPluginResult<{ directory: string; preview: PluginPreview } | null>
  >;
  readonly apply: (action: AgentPluginAction) => Promise<AgentPluginResult<void>>;
  readonly pending: boolean;
}

async function reviewFolder() {
  const picked = await agentPluginAdapter.pickFolder();
  if (!picked.ok) return picked;
  if (picked.value === null) return { ok: true, value: null } as const;
  const preview = await agentPluginAdapter.preview(picked.value);
  if (!preview.ok) return preview;
  return { ok: true, value: { directory: picked.value, preview: preview.value } } as const;
}

function execute(action: AgentPluginAction) {
  switch (action.kind) {
    case "install":
      return agentPluginAdapter.install(action.directory, action.previewDigest);
    case "reload":
      return agentPluginAdapter.reload(action.id);
    case "set-project-enabled":
      return agentPluginAdapter.setProjectEnabled(action.id, action.projectId, action.enabled);
    case "uninstall":
      return agentPluginAdapter.uninstall(action.id, action.data);
    case "repair-writer":
      return agentPluginAdapter.repairWriter();
  }
}

export function useAgentPluginInstallations(projectId: string | null) {
  return useQuery(agentPluginListOptions(projectId));
}

export function useAgentPluginManagement(): AgentPluginManagement {
  const client = useQueryClient();
  const { mutateAsync, isPending } = useMutation({
    mutationFn: async (action: AgentPluginAction): Promise<AgentPluginResult<void>> => {
      const result = await execute(action).catch(() => ({
        ok: false as const,
        error: {
          code: "unknown",
          message: "Could not confirm the change. Check the installation list.",
        },
      }));
      const key =
        action.kind === "set-project-enabled"
          ? agentPluginListOptions(action.projectId).queryKey
          : agentPluginListKey();
      await client.invalidateQueries({ queryKey: key });
      if (!result.ok) return result;
      for (const warning of result.value?.cleanupWarnings ?? []) {
        if (warning.kind === "data") toast.warning("Some plugin data could not be deleted.");
        else if (warning.kind === "generation")
          toast.warning("An old plugin copy could not be removed.");
        else toast.warning("The plugin registry lock could not be released.");
      }
      return { ok: true, value: undefined };
    },
  });
  return {
    reviewFolder: () =>
      reviewFolder().catch(() => ({
        ok: false,
        error: { code: "unavailable", message: "Could not review the plugin folder." },
      })),
    apply: mutateAsync,
    pending: isPending,
  };
}
