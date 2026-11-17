import type { AppInitializationStep } from "../../shared/app-startup";
import type { MessageDescriptor } from "../../shared/i18n/messages";

/**
 * The startup shell's copy. Only these descriptors load with the shell; the formatter that reads
 * them in the display language loads once the language is ready (see `startup-copy`).
 */
export const startupShellMessages = {
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
  migrating: { id: "startup.migration.indeterminate", defaultMessage: "Updating local data…" },
  migrationProgress: {
    id: "startup.migration.progress",
    defaultMessage: "Updating local data… {fraction, number, percent}",
  },
} as const satisfies Record<string, MessageDescriptor & { readonly defaultMessage: string }>;

type StartupMessage = (typeof startupShellMessages)[keyof typeof startupShellMessages];

export type StartupFormat = (message: StartupMessage, values?: Record<string, number>) => string;

/**
 * English without its arguments, for a shell whose formatter could not load: the failure state
 * must still name its way out.
 */
export const fallbackStartupFormat: StartupFormat = (message) =>
  message.defaultMessage.replace(/\s*\{[^}]*\}/gu, "");

export type StartupShellText =
  | {
      readonly phase: "failed";
      readonly status: string;
      readonly title: string;
      readonly detail: string;
      readonly restart: string;
    }
  | { readonly phase: "opening"; readonly status: string; readonly visibleStatus: string | null };

/** What the shell says at a step: visible copy is reserved for real local-data work. */
export function startupShellText(
  step: AppInitializationStep,
  format: StartupFormat,
): StartupShellText {
  if (step.phase === "failed")
    return {
      phase: "failed",
      status: format(startupShellMessages.failureStatus),
      title: format(startupShellMessages.failureTitle),
      detail: format(startupShellMessages.failureDetail),
      restart: format(startupShellMessages.restart),
    };
  if (step.phase !== "migrating")
    return { phase: "opening", status: format(startupShellMessages.opening), visibleStatus: null };
  const migration =
    step.completed === undefined || step.total === undefined || step.total <= 0
      ? format(startupShellMessages.migrating)
      : format(startupShellMessages.migrationProgress, {
          fraction:
            Math.floor((Math.min(Math.max(step.completed, 0), step.total) / step.total) * 100) /
            100,
        });
  return { phase: "opening", status: migration, visibleStatus: migration };
}
