import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import type { CodexHeartbeatDecision } from "./codex-turn-notification";
import type { CodexScheduledAutomationNotificationPolicy } from "./types";

/** A saved notification preference overrides model-authored heartbeat decisions. */
export const automationNotificationDecision = (
  policy: CodexScheduledAutomationNotificationPolicy | null | undefined,
  status: Turn["status"],
): CodexHeartbeatDecision | null => {
  if (policy !== "failed_runs_only" || status === "inProgress") return null;
  return status === "failed" ? "NOTIFY" : "DONT_NOTIFY";
};
