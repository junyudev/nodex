import { useEffect } from "react";
import type { CodexScheduledAutomation } from "../../../shared/types";
import { publishCodexHeartbeatEnabled } from "../../lib/codex-automation-runtime";
import { useCodexScheduledAutomations } from "../../lib/use-codex-scheduled-automations";
import { RuntimeHeartbeatAutomationTarget } from "./runtime-heartbeat-automation";

export function listHeartbeatAutomationTargetSessionIds(
  automations: readonly CodexScheduledAutomation[],
): string[] {
  return Array.from(
    new Set(
      automations.flatMap((automation) => {
        if (automation.kind !== "heartbeat" || automation.status !== "ACTIVE") return [];
        const sessionId = automation.targetSessionId?.trim();
        return sessionId ? [sessionId] : [];
      }),
    ),
  );
}

/** Heartbeats retain execution controls for their stable Session, never transcript bodies. */
export function HeartbeatAutomationController() {
  const electronAvailable = typeof window !== "undefined" && Boolean(window.api);
  const automations = useCodexScheduledAutomations();
  useEffect(() => {
    if (!electronAvailable) return;
    void publishCodexHeartbeatEnabled({ enabled: true }).catch(() => undefined);
  }, [electronAvailable]);
  return (
    <>
      {listHeartbeatAutomationTargetSessionIds(automations.data ?? []).map((sessionId) => (
        <RuntimeHeartbeatAutomationTarget key={sessionId} sessionId={sessionId} />
      ))}
    </>
  );
}
