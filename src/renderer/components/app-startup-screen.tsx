import { useEffect, useMemo, useState } from "react";
import type {
  AppInitializationStep,
  DatabaseMigrationProgress,
} from "../../shared/app-startup";
import {
  getStartupProgressValue,
  getStartupStatus,
} from "../lib/app-startup";

const MESSAGE_DELAYS_MS = [2800, 8400] as const;

export interface AppStartupScreenProps {
  step: AppInitializationStep;
  migrationProgress: DatabaseMigrationProgress | null;
}

export function AppStartupScreen({
  step,
  migrationProgress,
}: AppStartupScreenProps) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    setMessageIndex(0);

    if (step.phase !== "sqlite_waiting") {
      return;
    }

    const timers = MESSAGE_DELAYS_MS.map((delay, index) =>
      window.setTimeout(() => {
        setMessageIndex(index + 1);
      }, delay),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [step.phase]);

  const status = useMemo(
    () => getStartupStatus(step, messageIndex),
    [messageIndex, step],
  );
  const progressValue = useMemo(
    () => getStartupProgressValue(step, migrationProgress),
    [migrationProgress, step],
  );
  const progressLabel = `${Math.round(progressValue)}%`;

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-(--background) text-(--foreground)">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--foreground)_7%,transparent),transparent_55%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)]" />
      <div className="relative flex w-[24rem] flex-col gap-5 rounded-[24px] border border-(--border) bg-[color-mix(in_srgb,var(--background)_88%,transparent)] px-7 py-6 shadow-[0_24px_80px_color-mix(in_srgb,var(--background-secondary)_55%,transparent)] backdrop-blur-xl">
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-[18px] bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] text-base font-semibold tracking-[0.18em] text-(--foreground-secondary)">
            NX
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold tracking-[0.22em] text-(--foreground-tertiary) uppercase">
              Nodex
            </div>
            <h1 className="mt-1 text-[1.05rem] font-medium tracking-[-0.02em] text-(--foreground)">
              {step.phase === "sqlite_waiting"
                ? "Applying local data updates"
                : "Opening your workspace"}
            </h1>
            <p className="mt-1 text-sm/6 text-(--foreground-secondary)" aria-live="polite">
              {status}
            </p>
          </div>
        </div>

        <div className="space-y-2.5">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
            aria-label="Database migration progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(progressValue)}
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-(--accent-blue)"
              style={{ width: `${progressValue}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-(--foreground-tertiary)">
            <span>
              {step.phase === "sqlite_waiting"
                ? "Keeping existing boards intact while the schema catches up"
                : "Preparing the local database and workbench state"}
            </span>
            <span className="shrink-0 tabular-nums text-(--foreground-secondary)">
              {progressLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
