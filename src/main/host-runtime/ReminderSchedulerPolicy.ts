import type { AutomationReminderClaim } from "../../host/automation-application/AutomationApplication";
import { formatReminderBody, type ReminderNotificationPayload } from "../reminder-notification";

export const REMINDER_SCHEDULER_INTERVAL_MS = 30_000;
export const REMINDER_SCHEDULER_MAX_PER_TICK = 100;
export const REMINDER_LEASE_DURATION_MS = 2 * 60_000;
export const REMINDER_RETRY_DELAY_MS = 30_000;

export const reminderNotification = (
  claim: AutomationReminderClaim,
): ReminderNotificationPayload => {
  const occurrenceStart = new Date(claim.occurrenceStart);
  if (!Number.isFinite(occurrenceStart.getTime())) {
    throw new Error("Reminder claim occurrence start is invalid");
  }
  return {
    projectId: claim.projectId,
    pageId: claim.pageId,
    occurrenceStart: occurrenceStart.toISOString(),
    title: claim.title,
    body: formatReminderBody(occurrenceStart, claim.reminderOffsetMinutes),
    reminderOffsetMinutes: claim.reminderOffsetMinutes,
  };
};
