import { useIntl } from "@/lib/i18n";
import { useState } from "react";

import { AppStatusNotice, AppStatusNoticeAction } from "@/components/app-status-notice";
import { AlertTriangle } from "@/components/shared/icons/generic-icons";
import { useToaster } from "@/components/ui/toast";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { useAgentRuntimeConnectionState } from "@/lib/agent-runtime-session-activity";
import { readableIpcError } from "@/lib/ipc-error-message";

/**
 * Shown only when execution has stopped making progress, never merely because the computer is
 * busy: a busy process is explained where something waits for it. Requests keep waiting and settle
 * when it answers, so only the person using Nodex can choose to replace it.
 */
export function AgentRuntimeStatusNotice() {
  const intl = useIntl();
  const connection = useAgentRuntimeConnectionState();
  const toast = useToaster();
  const [restarting, setRestarting] = useState(false);
  if (connection.status !== "unresponsive") return null;
  const { generation } = connection;

  const restart = () => {
    setRestarting(true);
    void agentRuntimeRuntime
      .restart({ generation })
      .catch((cause: unknown) => {
        toast.danger(
          intl.formatMessage({
            id: "components.agentRuntimeStatusNotice.restartError",
            defaultMessage: "Agent execution could not restart",
          }),
          {
            description: readableIpcError(cause),
          },
        );
      })
      .finally(() => setRestarting(false));
  };

  return (
    <AppStatusNotice
      actions={
        <AppStatusNoticeAction
          disabled={restarting}
          onClick={restart}
          tooltip={intl.formatMessage({
            id: "components.agentRuntimeStatusNotice.restartTooltip",
            defaultMessage: "Interrupts running Agents. They recover after the restart.",
          })}
        >
          {restarting
            ? intl.formatMessage({
                id: "components.agentRuntimeStatusNotice.restarting",
                defaultMessage: "Restarting…",
              })
            : intl.formatMessage({
                id: "components.agentRuntimeStatusNotice.restart",
                defaultMessage: "Restart",
              })}
        </AppStatusNoticeAction>
      }
      detail={intl.formatMessage({
        id: "components.agentRuntimeStatusNotice.stuckDetail",
        defaultMessage: "It hasn’t made progress for over a minute.",
      })}
      icon={<AlertTriangle className="icon-2xs shrink-0 text-[var(--color-text-warning)]" />}
      label={intl.formatMessage({
        id: "components.agentRuntimeStatusNotice.unresponsive",
        defaultMessage: "Agent execution isn't responding",
      })}
    />
  );
}
