import type { AppInitializationStep } from "../../shared/app-startup";

/** Visible startup copy is reserved for real local-data work; ordinary opening stays quiet. */
export function getStartupStatus(step: AppInitializationStep): string | null {
  if (step.phase !== "migrating") return null;
  if (step.completed === undefined || step.total === undefined || step.total <= 0) {
    return "Updating local data…";
  }
  const percentage = Math.floor(
    (Math.min(Math.max(step.completed, 0), step.total) / step.total) * 100,
  );
  return `Updating local data… ${percentage}%`;
}
