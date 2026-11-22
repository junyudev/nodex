import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "../../../shared/agent-runtime-settings";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { NodexSwitch } from "@/components/ui/button";
import { settingsMessages } from "@/components/workbench/workbench-settings-search-catalog";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { toastFailure } from "@/lib/failure-toast";
import { useIntl } from "@/lib/i18n";
import {
  conversationChoiceFor,
  resolveSubagentDelegation,
  subagentDelegationQueryOptions,
} from "./subagent-delegation";

/** The Settings answer every conversation follows until it chooses otherwise. */
const useSettingsDelegation = () => {
  const settings = useQuery(agentRuntimeSettingsQueryOptions());
  return {
    allowed:
      settings.data?.subagentsMayDelegate ?? DEFAULT_AGENT_RUNTIME_SETTINGS.subagentsMayDelegate,
    pending: settings.isPending,
  };
};

export function SubagentDelegationSettingControl() {
  const intl = useIntl();
  const client = useQueryClient();
  const settings = useSettingsDelegation();
  const save = useMutation({
    mutationFn: (subagentsMayDelegate: boolean) =>
      updateAgentRuntimeSettings(client, { subagentsMayDelegate }),
    onError: (cause) =>
      toastFailure(
        intl.formatMessage({
          id: "settings.subagentDelegation.couldntSave",
          defaultMessage: "Couldn’t save whether subagents can delegate",
        }),
        cause,
      ),
  });
  return (
    <NodexSwitch
      ariaLabel={intl.formatMessage(settingsMessages.agentsSubagentsCanDelegate)}
      checked={save.isPending ? save.variables : settings.allowed}
      disabled={settings.pending || save.isPending}
      onCheckedChange={(next) => save.mutate(next)}
    />
  );
}

/**
 * This conversation's answer, beside its work tree. It names itself only when it differs from
 * Settings; switching back to the Settings answer follows Settings again.
 */
export function SubagentDelegationConversationControl({ sessionId }: { sessionId: string }) {
  const intl = useIntl();
  const client = useQueryClient();
  const settings = useSettingsDelegation();
  const query = subagentDelegationQueryOptions(sessionId);
  const chosen = useQuery(query);
  const state = resolveSubagentDelegation(
    settings.allowed,
    chosen.data?.subagentsMayDelegate ?? null,
  );
  const save = useMutation({
    mutationFn: async (allowed: boolean) => {
      const subagentsMayDelegate = conversationChoiceFor(settings.allowed, allowed);
      await agentRuntimeRuntime.setSubagentDelegation({
        sessionId,
        requestId: createUuidV7(),
        subagentsMayDelegate,
      });
      return { subagentsMayDelegate };
    },
    onSuccess: (result) => client.setQueryData(query.queryKey, result),
    onError: (cause) =>
      toastFailure(
        intl.formatMessage({
          id: "conversation.subagentsPanel.delegationCouldntSave",
          defaultMessage: "Couldn’t change whether this chat’s subagents can delegate",
        }),
        cause,
      ),
  });
  const label = intl.formatMessage(settingsMessages.agentsSubagentsCanDelegate);
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-token-text-secondary">
      <span className="truncate">{label}</span>
      {state.source === "conversation" ? (
        <span className="shrink-0 text-token-text-tertiary">
          {intl.formatMessage({
            id: "conversation.subagentsPanel.delegationThisChat",
            defaultMessage: "This chat",
          })}
        </span>
      ) : null}
      <NodexSwitch
        size="compact"
        ariaLabel={label}
        checked={save.isPending ? save.variables : state.allowed}
        disabled={settings.pending || chosen.isPending || save.isPending}
        onCheckedChange={(next) => save.mutate(next)}
      />
    </div>
  );
}
