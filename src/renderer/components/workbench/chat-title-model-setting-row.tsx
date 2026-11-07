import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import type { AgentRuntimeTitleModel } from "../../../shared/agent-runtime-settings";
import { AgentModelPicker } from "@/components/shared/agent-runtime/agent-model-picker";
import { AgentProviderIcon } from "@/components/shared/icons";
import { NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexSettingsRow } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { useAgentInstances } from "@/features/local-conversation/use-agent-instances";
import { useAgentSettingsNavigation } from "@/lib/agent-settings-navigation";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { readableIpcError } from "@/lib/ipc-error-message";
import {
  useAgentRuntimeProviders,
  useRefreshAgentRuntimeProviders,
} from "@/lib/use-agent-runtime-providers";
import { cn } from "@/lib/utils";
import {
  CHAT_TITLE_MODEL_DEFAULT_LABEL,
  chatTitleModelPicker,
  describeChatTitleModel,
} from "./chat-title-model";

/** The model that titles new chats. Effort is always its lightest, so only the model is offered. */
export function ChatTitleModelSettingRow() {
  const client = useQueryClient();
  const settings = useQuery(agentRuntimeSettingsQueryOptions());
  const providers = useAgentRuntimeProviders();
  const refresh = useRefreshAgentRuntimeProviders();
  const { instances } = useAgentInstances();
  const openAgentSettings = useAgentSettingsNavigation();
  const choice = settings.data?.titleModel ?? null;
  const catalog = {
    providers: providers.data ?? [],
    state: providers.data
      ? ("ready" as const)
      : providers.error
        ? ("error" as const)
        : ("loading" as const),
    instances,
  };
  const presentation = describeChatTitleModel(catalog, choice);
  const picker = chatTitleModelPicker(catalog, choice);
  const save = (titleModel: AgentRuntimeTitleModel | null) =>
    updateAgentRuntimeSettings(client, { titleModel });
  return (
    <NodexSettingsRow
      label="Title chats with"
      description="Each chat's own Agent titles it. A model chosen here receives every first message."
    >
      <div className="w-56 max-w-full">
        <AgentModelPicker
          modelOnly
          disabled={!settings.data}
          triggerStyle="settings"
          triggerButton={
            <NodexSettingsDropdownTrigger
              aria-label="Title chats with"
              className={cn(
                "w-full min-w-0 justify-between",
                presentation.status === "unavailable" && "text-token-error-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {presentation.kind ? (
                  <AgentProviderIcon kind={presentation.kind} className="size-3.5 shrink-0" />
                ) : null}
                <span className="min-w-0 truncate">{presentation.line}</span>
              </span>
            </NodexSettingsDropdownTrigger>
          }
          allowInherit
          inheritLabel={CHAT_TITLE_MODEL_DEFAULT_LABEL}
          inheritance={choice ? "explicit" : "inherited"}
          onInherit={() =>
            void save(null).catch((error: unknown) =>
              toast.danger(readableIpcError(error, "Title model was not saved")),
            )
          }
          models={[]}
          selection={{
            kind: picker.selected.binding.kind,
            model: picker.selected.model,
            reasoningEffort: "default",
            serviceTier: null,
          }}
          onSelectionChange={() => {}}
          catalog={{
            entries: picker.entries,
            selected: picker.selected,
            loading: catalog.state === "loading",
            error: catalog.state === "error" ? "Couldn’t load Agents" : null,
            choose: async (selection) => {
              const instanceId = agentRuntimeProviderId(selection.binding);
              if (instanceId) await save({ instanceId, model: selection.model });
            },
            refresh,
            reload: () => void providers.refetch(),
            manage: () => openAgentSettings?.(),
          }}
        />
      </div>
    </NodexSettingsRow>
  );
}
