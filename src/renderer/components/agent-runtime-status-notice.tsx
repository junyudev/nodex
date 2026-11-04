import { useState } from "react";

import { AppStatusNotice, AppStatusNoticeAction } from "@/components/app-status-notice";
import { AlertTriangle } from "@/components/shared/icons/generic-icons";
import { useToaster } from "@/components/ui/toast";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { useAgentRuntimeConnectionState } from "@/lib/agent-runtime-session-activity";
import { readableIpcError } from "@/lib/ipc-error-message";

/**
 * Waiting on a busy execution process stays honest without ending anything: requests keep waiting
 * and settle when it answers, so only the person using Nodex can choose to replace it.
 */
export function AgentRuntimeStatusNotice() {
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
        toast.danger("Agent execution could not restart", {
          description: readableIpcError(cause),
        });
      })
      .finally(() => setRestarting(false));
  };

  return (
    <AppStatusNotice
      actions={
        <AppStatusNoticeAction
          disabled={restarting}
          onClick={restart}
          tooltip="Interrupts running Agents. They recover after the restart."
        >
          {restarting ? "Restarting…" : "Restart"}
        </AppStatusNoticeAction>
      }
      detail="Your computer may be busy. Nodex will catch up."
      icon={<AlertTriangle className="icon-2xs shrink-0 text-[var(--color-text-warning)]" />}
      label="Agent execution isn't responding"
    />
  );
}
