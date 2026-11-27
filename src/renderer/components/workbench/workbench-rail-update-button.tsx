import { useEffect, useState, type ReactNode } from "react";
import { ActivitySpinnerIcon, DownloadIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { summarizeAppUpdateReleaseNotes } from "@/lib/app-update-release-summary";
import { installAppUpdate } from "@/lib/app-update-runtime";
import { useIntl } from "@/lib/i18n";
import type { AppUpdateStatus } from "@/lib/types";
import { useAppUpdateStatus } from "../../app-providers";
import { WORKBENCH_RAIL_BUTTON_CLASS } from "./workbench-app-rail";

type RailUpdatePhase =
  | { readonly kind: "downloading"; readonly percent: number | null }
  | { readonly kind: "installing" }
  | { readonly kind: "ready" };

/** Updates download on their own; the rail shows one from its download until it installs. */
function resolveRailUpdatePhase(status: AppUpdateStatus): RailUpdatePhase | null {
  switch (status.status) {
    case "available":
      return { kind: "downloading", percent: null };
    case "downloading":
      return { kind: "downloading", percent: status.progressPercent };
    case "downloaded":
      return { kind: "ready" };
    case "installing":
      return { kind: "installing" };
    default:
      return null;
  }
}

const REMINDER_STORAGE_KEY = "nodex.appUpdate.railReminderAt";
const REMIND_LATER_MS = 60 * 60 * 1000;

function readReminderAt(): number {
  const value = Number(globalThis.localStorage?.getItem(REMINDER_STORAGE_KEY) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** "Later" hides a ready update for an hour in every window. */
function useUpdateReminder() {
  const [reminderAt, setReminderAt] = useState(readReminderAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = reminderAt - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [reminderAt]);
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === REMINDER_STORAGE_KEY) setReminderAt(readReminderAt());
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, []);
  return {
    snoozed: reminderAt > now,
    remindLater: () => {
      const next = Date.now() + REMIND_LATER_MS;
      globalThis.localStorage?.setItem(REMINDER_STORAGE_KEY, String(next));
      setReminderAt(next);
    },
  };
}

const PROGRESS_RADIUS = 6;
const PROGRESS_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RADIUS;

function UpdateProgressRing({ percent }: { readonly percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" fill="none" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={PROGRESS_RADIUS}
        strokeWidth="2"
        stroke="currentColor"
        opacity={0.3}
      />
      <circle
        cx="8"
        cy="8"
        r={PROGRESS_RADIUS}
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={`${((PROGRESS_CIRCUMFERENCE * clamped) / 100).toFixed(2)} ${PROGRESS_CIRCUMFERENCE.toFixed(2)}`}
        className="transition-[stroke-dasharray] duration-300 ease-out motion-reduce:transition-none"
      />
    </svg>
  );
}

/** The accent disc: a download arrow when ready, else how far the update has come. */
function UpdateDisc({ phase }: { readonly phase: RailUpdatePhase }) {
  return (
    <span className="inline-flex size-6 items-center justify-center rounded-full bg-(--color-background-accent-solid) text-(--color-text-accent-solid)">
      {phase.kind === "ready" ? (
        <DownloadIcon className="size-4" />
      ) : phase.kind === "downloading" && phase.percent !== null ? (
        <UpdateProgressRing percent={phase.percent} />
      ) : (
        <ActivitySpinnerIcon className="size-3.5" />
      )}
    </span>
  );
}

/** What the update brings, read from its release notes, with the actions a ready one offers. */
function UpdateCard({
  status,
  phase,
  onRestart,
  onLater,
}: {
  readonly status: AppUpdateStatus;
  readonly phase: RailUpdatePhase;
  readonly onRestart: () => void;
  readonly onLater: () => void;
}) {
  const intl = useIntl();
  const summary = summarizeAppUpdateReleaseNotes(status.releaseNotes);
  const version = status.availableVersion?.trim() || null;
  const state =
    phase.kind === "ready"
      ? intl.formatMessage({
          id: "workbench.railUpdate.ready",
          defaultMessage: "Update ready",
        })
      : phase.kind === "installing"
        ? intl.formatMessage({
            id: "workbench.railUpdate.installing",
            defaultMessage: "Installing update…",
          })
        : phase.percent === null
          ? intl.formatMessage({
              id: "workbench.railUpdate.downloading",
              defaultMessage: "Downloading update…",
            })
          : intl.formatMessage(
              {
                id: "workbench.railUpdate.downloadingPercent",
                defaultMessage: "Downloading update · {percent}",
              },
              { percent: intl.formatNumber(phase.percent / 100, { style: "percent" }) },
            );
  return (
    <div className="flex w-72 max-w-full flex-col gap-2 p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-token-text-secondary">{state}</span>
        <span className="text-sm font-medium text-token-text-primary">
          {version
            ? intl.formatMessage(
                { id: "workbench.railUpdate.version", defaultMessage: "Nodex {version}" },
                { version },
              )
            : intl.formatMessage({
                id: "workbench.railUpdate.newVersion",
                defaultMessage: "A new version of Nodex",
              })}
        </span>
      </div>
      {summary.headline ? (
        <p className="text-sm text-pretty text-token-text-primary">{summary.headline}</p>
      ) : null}
      {summary.highlights.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-token-text-secondary">
          {summary.highlights.map((highlight) => (
            <li key={highlight} className="flex gap-1.5">
              <span aria-hidden="true">·</span>
              <span className="line-clamp-2 min-w-0">{highlight}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {phase.kind === "ready" ? (
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <NodexButton size="toolbar" variant="ghost" onClick={onLater}>
            {intl.formatMessage({ id: "workbench.railUpdate.later", defaultMessage: "Later" })}
          </NodexButton>
          <NodexButton size="toolbar" variant="primary" onClick={onRestart}>
            {intl.formatMessage({
              id: "workbench.railUpdate.restart",
              defaultMessage: "Restart to update",
            })}
          </NodexButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The app update at the top of the rail's foot: an accent disc that fills while the update
 * downloads and offers Restart to update once it is ready. Hovering it shows what the update
 * brings.
 */
export function WorkbenchRailUpdateButton() {
  const intl = useIntl();
  const status = useAppUpdateStatus();
  const { snoozed, remindLater } = useUpdateReminder();
  const phase = status ? resolveRailUpdatePhase(status) : null;
  if (!status || !phase || (phase.kind === "ready" && snoozed)) return null;

  const restart = () => {
    void installAppUpdate().then((installed) => {
      if (installed === true) return;
      toast.danger(
        intl.formatMessage({
          id: "workbench.railUpdate.restartFailed",
          defaultMessage: "Couldn’t restart to install the update",
        }),
      );
    });
  };
  const label =
    phase.kind === "ready"
      ? intl.formatMessage({
          id: "workbench.railUpdate.restartLabel",
          defaultMessage: "Restart to update",
        })
      : intl.formatMessage({
          id: "workbench.railUpdate.progressLabel",
          defaultMessage: "Update progress",
        });

  let trigger: ReactNode;
  if (phase.kind === "ready") {
    trigger = (
      <NodexButton
        aria-label={label}
        data-rail-update="ready"
        variant="ghostSecondary"
        size="icon"
        className={WORKBENCH_RAIL_BUTTON_CLASS}
        onClick={restart}
      >
        <UpdateDisc phase={phase} />
      </NodexButton>
    );
  } else {
    const percent = phase.kind === "downloading" ? phase.percent : null;
    trigger = (
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        tabIndex={0}
        data-rail-update={phase.kind}
        className="no-drag inline-flex size-9 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
      >
        <UpdateDisc phase={phase} />
      </span>
    );
  }

  return (
    <span className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none">
      <NodexTooltip
        side="right"
        surface="rich"
        hoverable
        tooltipContent={
          <UpdateCard status={status} phase={phase} onRestart={restart} onLater={remindLater} />
        }
      >
        {trigger}
      </NodexTooltip>
    </span>
  );
}
