import { getIntl } from "@/lib/i18n";
import type { BackupJobPhase, BackupJobStatus } from "../../shared/types";

export interface BackupJobPresentation {
  readonly active: boolean;
  readonly cancellable: boolean;
  readonly phaseLabel: string;
  readonly progressTotal: number;
  readonly progressUnits: number;
}

const backupJobPhaseLabel = (phase: BackupJobPhase): string => {
  switch (phase) {
    case "queued":
      return "Queued";
    case "preparing":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.preparing",
        defaultMessage: "Preparing snapshot",
      });
    case "cancellation_requested":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.cancelling",
        defaultMessage: "Cancelling snapshot",
      });
    case "cancelled":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.cancelled",
        defaultMessage: "Snapshot cancelled",
      });
    case "database_snapshot":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.copyingDatabase",
        defaultMessage: "Copying database",
      });
    case "asset_copy":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.copyingAssets",
        defaultMessage: "Copying assets",
      });
    case "validation":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.checkingDatabase",
        defaultMessage: "Checking database integrity",
      });
    case "digest":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.sealingEvidence",
        defaultMessage: "Sealing integrity evidence",
      });
    case "commit":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.recording",
        defaultMessage: "Recording snapshot",
      });
    case "publishing":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.publishing",
        defaultMessage: "Publishing snapshot",
      });
    case "ready":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.ready",
        defaultMessage: "Snapshot ready",
      });
    case "failed":
      return getIntl().formatMessage({
        id: "lib.backupJobPresentation.failed",
        defaultMessage: "Snapshot failed",
      });
  }
};

export function projectBackupJob(job: BackupJobStatus): BackupJobPresentation {
  const active = job.state === "queued" || job.state === "running";
  const progressUnits =
    job.phase === "database_snapshot" && job.progress.databaseTotalPages > 0
      ? job.completedUnits + job.progress.databaseCopiedPages / job.progress.databaseTotalPages
      : job.completedUnits;

  return {
    active,
    cancellable: active && job.phase !== "commit" && job.phase !== "publishing",
    phaseLabel: backupJobPhaseLabel(job.phase),
    progressTotal: Math.max(1, job.totalUnits),
    progressUnits,
  };
}
