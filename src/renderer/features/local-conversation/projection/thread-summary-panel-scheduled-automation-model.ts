import type { CodexScheduledAutomation } from "@/lib/types";
import {
  formatCodexScheduledAutomationNextRunLabel,
  formatCodexScheduledAutomationRruleSummary,
} from "@/lib/codex-scheduled-automation-display";
import type { ThreadSummaryPanelScheduledAutomationRow } from "../thread-stage-types";

interface BuildThreadSummaryPanelScheduledAutomationRowInput {
  automations: readonly CodexScheduledAutomation[];
  sessionId: string | null;
  now?: Date;
}

function isActiveHeartbeatAutomationForSession(
  automation: CodexScheduledAutomation,
  sessionId: string,
): boolean {
  return (
    automation.kind === "heartbeat" &&
    automation.status === "ACTIVE" &&
    automation.targetSessionId === sessionId
  );
}

export function buildThreadSummaryPanelScheduledAutomationRow({
  automations,
  sessionId,
  now = new Date(),
}: BuildThreadSummaryPanelScheduledAutomationRowInput): ThreadSummaryPanelScheduledAutomationRow | null {
  if (!sessionId) return null;

  const automation = automations.find((candidate) =>
    isActiveHeartbeatAutomationForSession(candidate, sessionId),
  );
  if (!automation) return null;

  return {
    id: automation.id,
    name: automation.name,
    scheduleSummary: formatCodexScheduledAutomationRruleSummary(automation.rrule),
    nextRunLabel: formatCodexScheduledAutomationNextRunLabel(automation.nextRunAt, now),
  };
}
