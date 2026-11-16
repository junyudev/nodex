import { getIntl } from "@/lib/i18n";
import type { ProjectSessionThreadSummary } from "../../shared/types";

export type ThreadStatusDisplayLabel = string;

export function resolveThreadStatusDisplayLabel(
  thread: Pick<ProjectSessionThreadSummary, "archived" | "statusActiveFlags" | "statusType">,
): ThreadStatusDisplayLabel {
  if (thread.archived)
    return getIntl().formatMessage({
      id: "lib.threadStatusDisplay.archived",
      defaultMessage: "Archived",
    });
  if (thread.statusType === "systemError")
    return getIntl().formatMessage({
      id: "lib.threadStatusDisplay.error",
      defaultMessage: "Error",
    });
  if (thread.statusActiveFlags.includes("waitingOnApproval")) {
    return getIntl().formatMessage({
      id: "lib.threadStatusDisplay.needsApproval",
      defaultMessage: "Needs approval",
    });
  }
  if (thread.statusActiveFlags.includes("waitingOnUserInput")) {
    return getIntl().formatMessage({
      id: "lib.threadStatusDisplay.waiting",
      defaultMessage: "Waiting",
    });
  }
  if (thread.statusType === "active")
    return getIntl().formatMessage({
      id: "lib.threadStatusDisplay.running",
      defaultMessage: "Running",
    });
  if (thread.statusType === "idle")
    return getIntl().formatMessage({
      id: "lib.threadStatusDisplay.ready",
      defaultMessage: "Ready",
    });
  return getIntl().formatMessage({
    id: "lib.threadStatusDisplay.thread",
    defaultMessage: "Thread",
  });
}
