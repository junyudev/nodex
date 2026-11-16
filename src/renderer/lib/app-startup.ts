import type { AppInitializationStep } from "../../shared/app-startup";
import { defineMessages, getIntl } from "./i18n";

export const startupShellMessages = defineMessages({
  opening: { id: "startup.shell.opening", defaultMessage: "Opening Nodex…" },
  failureStatus: {
    id: "startup.shell.failureStatus",
    defaultMessage: "Nodex could not finish opening.",
  },
  failureTitle: {
    id: "startup.shell.failureTitle",
    defaultMessage: "Nodex could not finish opening",
  },
  failureDetail: {
    id: "startup.shell.failureDetail",
    defaultMessage: "Restart Nodex to try again.",
  },
  restart: { id: "startup.shell.restart", defaultMessage: "Restart Nodex" },
});

/** Visible startup copy is reserved for real local-data work; ordinary opening stays quiet. */
export function getStartupStatus(step: AppInitializationStep): string | null {
  if (step.phase !== "migrating") return null;
  if (step.completed === undefined || step.total === undefined || step.total <= 0) {
    return getIntl().formatMessage({
      id: "startup.migration.indeterminate",
      defaultMessage: "Updating local data…",
    });
  }
  const percentage = Math.floor(
    (Math.min(Math.max(step.completed, 0), step.total) / step.total) * 100,
  );
  return getIntl().formatMessage(
    {
      id: "startup.migration.progress",
      defaultMessage: "Updating local data… {fraction, number, percent}",
    },
    { fraction: percentage / 100 },
  );
}
