import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRuntimeWritingModel } from "../../../shared/agent-runtime-settings";
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
  writingModelDefaultLabelMessage,
  writingModelPicker,
  describeWritingModel,
} from "./writing-model";

/** Writing requests use the lightest effort, so the picker offers only models. */
export function WritingModelSettingRow() {
  const intl = useIntl();
  const client = useQueryClient();
  const settings = useQuery(agentRuntimeSettingsQueryOptions());
  const providers = useAgentRuntimeProviders();
  const refresh = useRefreshAgentRuntimeProviders();
  const { instances } = useAgentInstances();
  const openAgentSettings = useAgentSettingsNavigation();
  const choice = settings.data?.writingModel ?? null;
  const catalog = {
    providers: providers.data ?? [],
    state: providers.data
      ? ("ready" as const)
      : providers.error
        ? ("error" as const)
        : ("loading" as const),
    instances,
  };
  const presentation = describeWritingModel(catalog, choice);
  const picker = writingModelPicker(catalog, choice);
  const save = (writingModel: AgentRuntimeWritingModel | null) =>
    updateAgentRuntimeSettings(client, { writingModel });
  return (
    <NodexSettingsRow
      label={intl.formatMessage(settingsMessages.writingModelLabel)}
      description={intl.formatMessage(settingsMessages.writingModelDescription)}
    >
      <div className="w-56 max-w-full">
        <AgentModelPicker
          modelOnly
          disabled={!settings.data}
          triggerStyle="settings"
          triggerButton={
            <NodexSettingsDropdownTrigger
              aria-label={intl.formatMessage(settingsMessages.writingModelLabel)}
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
          inheritLabel={intl.formatMessage(writingModelDefaultLabelMessage)}
          inheritance={choice ? "explicit" : "inherited"}
          onInherit={() =>
            void save(null).catch((error: unknown) =>
              toast.danger(
                readableIpcError(
                  error,
                  intl.formatMessage({
                    id: "settings.writingModel.wasNotSaved",
                    defaultMessage: "Couldn’t save the writing model",
                  }),
                ),
              ),
            )
          }
          models={[]}
          selection={{
            kind: picker.selected.binding.driver,
            model: picker.selected.model,
            reasoningEffort: "default",
            serviceTier: null,
          }}
          onSelectionChange={() => {}}
          catalog={{
            entries: picker.entries,
            selected: picker.selected,
            loading: catalog.state === "loading",
            error:
              catalog.state === "error"
                ? intl.formatMessage({
                    id: "settings.writingModel.couldntLoadAgents",
                    defaultMessage: "Couldn’t load Agents",
                  })
                : null,
            choose: async (selection) => {
              const instanceId = selection.binding.instanceId;
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
