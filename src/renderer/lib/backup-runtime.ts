import type {
  BackupCapacity,
  BackupJobStatus,
  BackupRecord,
  BackupStartResult,
  CreateBackupCommandInput,
  SnapshotStorageOptimization,
} from "../../shared/types";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

export interface BackupRuntimePort {
  readonly list: () => Promise<readonly BackupRecord[]>;
  readonly capacity: () => Promise<BackupCapacity>;
  readonly storageOptimization: () => Promise<SnapshotStorageOptimization>;
  readonly job: (jobId?: string) => Promise<BackupJobStatus | null>;
  readonly start: (command: CreateBackupCommandInput) => Promise<BackupStartResult>;
  readonly cancel: (jobId: string) => Promise<BackupJobStatus>;
}

const startBackupCommand = defineRendererCommand({
  key: "backup.create",
  channel: "backup:create",
  authority: "main",
  owner: "BackupRuntime",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "application" },
});

const cancelBackupCommand = defineRendererCommand({
  key: "backup.cancel",
  channel: "backup:cancel",
  authority: "main",
  owner: "BackupRuntime",
  protocol: { kind: "returned_value" },
});

/** Electron Adapter for the renderer-owned Backup job lifecycle. */
export const electronBackupRuntimePort: BackupRuntimePort = {
  list: () => invokeRendererQuery("backup:list"),
  capacity: () => invokeRendererQuery("backup:capacity:get"),
  storageOptimization: () => invokeRendererQuery("backup:storage-optimization:get"),
  job: (jobId) => invokeRendererQuery("backup:job:get", jobId),
  start: (command) => invokePlainCommand(startBackupCommand, command),
  cancel: (jobId) => invokePlainCommand(cancelBackupCommand, jobId),
};
