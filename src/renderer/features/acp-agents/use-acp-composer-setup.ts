import type { AgentModelSetupPresentation } from "@/components/shared/agent-runtime/agent-model-picker";
import { appScope, useScopeHandle } from "@/lib/maitai";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { ConversationProviderStatus } from "../local-conversation/thread-stage-types";
import { acpComposerSetupHint, acpProviderId, type AcpProviderSnapshot } from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import { openAcpAgentSetupDialog } from "./acp-agent-setup-dialog";
import { acpAgentsOwner, useAcpAgents } from "./use-acp-agents";

interface ComposerInstance {
  readonly binding: AgentBackendBinding;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * The model menu's ACP setup entries and the Composer's sign-in prompt, from the Runtime state
 * the Composer already read. Each opens the instance's setup dialog in place.
 */
export function useAcpComposerSetup({
  providers,
  instances,
  selected,
  openSettings,
  owner = acpAgentsOwner,
}: {
  readonly providers: readonly AcpProviderSnapshot[];
  readonly instances: readonly ComposerInstance[];
  readonly selected: AgentBackendBinding;
  readonly openSettings: (instanceId: string) => void;
  readonly owner?: AcpAgentsOwner;
}): {
  readonly setups: readonly AgentModelSetupPresentation[];
  readonly status: ConversationProviderStatus | null;
} {
  const appHandle = useScopeHandle(appScope);
  const { activities } = useAcpAgents(owner);
  const entries = instances.flatMap((instance) => {
    const binding = instance.binding;
    if (binding.kind !== "acp" || !binding.instanceConfigId || !instance.enabled) return [];
    const instanceId = binding.instanceConfigId;
    const providerId = acpProviderId({
      id: instanceId,
      agentDefinitionId: binding.agentDefinitionId,
    });
    const hint = acpComposerSetupHint(
      providers.find((entry) => entry.instanceId === providerId),
      activities.get(instanceId),
    );
    if (!hint) return [];
    const open = (showModels?: () => void) =>
      openAcpAgentSetupDialog(appHandle, {
        owner,
        instanceId,
        ...(showModels ? { onShowModels: showModels } : {}),
        onOpenSettings: () => openSettings(instanceId),
      });
    return [{ instance, instanceId, hint, open }];
  });
  const selectedEntry =
    selected.kind === "acp"
      ? entries.find((entry) => entry.instanceId === selected.instanceConfigId)
      : undefined;
  return {
    setups: entries.map(({ instance, hint, open }) => ({
      kind: "acp",
      label: instance.label,
      hint: hint.hint,
      tone: hint.tone,
      action: { kind: "open", open: ({ showModels }) => open(showModels) },
    })),
    status:
      selectedEntry?.hint.hint === "Sign in"
        ? {
            message: `Sign in to ${selectedEntry.instance.label} to send messages.`,
            actions: [
              {
                label: "Sign in",
                pendingLabel: "Opening…",
                run: async () => selectedEntry.open(),
              },
            ],
          }
        : null,
  };
}
