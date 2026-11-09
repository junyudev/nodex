import type { Automation } from "@/lib/types";
import {
  formatAutomationNextRunLabel,
  formatAutomationRruleSummary,
} from "@/lib/automation-display";
import type { ThreadSummaryPanelAutomationRow } from "../thread-stage-types";

interface BuildThreadSummaryPanelAutomationRowInput {
  automations: readonly Automation[];
  sessionId: string | null;
  now?: Date;
}

function isActiveHeartbeatAutomationForSession(automation: Automation, sessionId: string): boolean {
  return (
    automation.kind === "heartbeat" &&
    automation.status === "ACTIVE" &&
    automation.targetSessionId === sessionId
  );
}

export function buildThreadSummaryPanelAutomationRow({
  automations,
  sessionId,
  now = new Date(),
}: BuildThreadSummaryPanelAutomationRowInput): ThreadSummaryPanelAutomationRow | null {
  if (!sessionId) return null;

  const automation = automations.find((candidate) =>
    isActiveHeartbeatAutomationForSession(candidate, sessionId),
  );
  if (!automation) return null;

  return {
    id: automation.id,
    name: automation.name,
    scheduleSummary: formatAutomationRruleSummary(automation.rrule),
    nextRunLabel: formatAutomationNextRunLabel(automation.nextRunAt, now),
  };
}
