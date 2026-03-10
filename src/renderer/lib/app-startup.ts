import type {
  AppInitializationStep,
  DatabaseMigrationProgress,
} from "../../shared/app-startup";

export const MIGRATION_STATUS_LINES = [
  "Preparing your workspace...",
  "Migrating your local database",
  "This can take a minute on larger boards",
] as const;

export function getStartupStatus(
  step: AppInitializationStep,
  lineIndex: number,
): string {
  if (step.phase === "done") {
    return "Ready";
  }

  if (step.phase === "sqlite_waiting") {
    return MIGRATION_STATUS_LINES[
      Math.max(0, Math.min(MIGRATION_STATUS_LINES.length - 1, lineIndex))
    ];
  }

  return "Preparing your workspace...";
}

export function getStartupProgressValue(
  step: AppInitializationStep,
  migrationProgress: DatabaseMigrationProgress | null,
): number {
  if (step.phase === "done") return 100;
  if (step.phase !== "sqlite_waiting") return 18;
  if (!migrationProgress || migrationProgress.type === "Done") return 100;
  return Math.max(24, Math.min(100, migrationProgress.value));
}
