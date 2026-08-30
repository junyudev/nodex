import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type {
  BackupJobStatus,
  BackupStartResult,
  CreateBackupCommandInput,
} from "../../shared/types";
import type { BackupRuntimePort } from "./backup-runtime";
import { useStoreBackupRuntime } from "./use-store-backup-runtime";

const progress: BackupJobStatus["progress"] = {
  databaseCopiedPages: 0,
  databaseTotalPages: 0,
  databaseBusyRetries: 0,
  assetBytesCopied: 0,
  databaseCopyMs: 0,
  assetCopyMs: 0,
  validationMs: 0,
  digestMs: 0,
  publishMs: 0,
  writerHeldMs: 0,
};

const job = (jobId: string, state: BackupJobStatus["state"] = "running"): BackupJobStatus => ({
  jobId,
  state,
  phase: state === "failed" ? "failed" : "database_snapshot",
  completedUnits: state === "failed" ? 0 : 1,
  totalUnits: 7,
  startedAt: 1,
  updatedAt: 2,
  backup: null,
  error: state === "failed" ? "Snapshot failed." : null,
  progress,
});

const portWith = (overrides: Partial<BackupRuntimePort>): BackupRuntimePort => ({
  list: async () => [],
  capacity: async () => ({
    availableBytes: 1_000_000,
    estimatedNextBackupBytes: 100,
    safetyMarginBytes: 100,
    totalReadyBytes: 0,
    manualReadyBytes: 0,
    automaticReadyBytes: 0,
    canCreate: true,
  }),
  storageOptimization: async () => ({
    optimizing: false,
    commitHead: 0,
    replayFloor: 0,
    pendingCommitMetadata: 0,
    pendingReceiptMetadata: 0,
    retainedCommitCount: 0,
    retainedDeliveryBytes: 0,
    retainedReceiptCount: 0,
    retainedReceiptBytes: 0,
    receiptFloorAt: null,
    lastPrunedCommit: 0,
    freelistPages: 0,
    reclaimableBytes: 0,
  }),
  job: async () => null,
  start: async () => {
    throw new Error("unused");
  },
  cancel: async (jobId) => job(jobId, "cancelled"),
  ...overrides,
});

describe("useStoreBackupRuntime", () => {
  test("retries an unresolved submission with the exact operation and normalized label", async () => {
    const commands: CreateBackupCommandInput[] = [];
    const start = vi.fn(async (command: CreateBackupCommandInput) => {
      commands.push(command);
      if (commands.length === 1) throw new Error("response lost");
      return {
        kind: "submitted" as const,
        operationId: command.operationId,
        job: job(command.operationId, "failed"),
      };
    });
    const { result } = renderHook(() =>
      useStoreBackupRuntime({ open: true, port: portWith({ start }) }),
    );

    await act(async () => {
      await expect(result.current.startManual("  Before migration  ")).rejects.toThrow(
        "response lost",
      );
    });
    expect(result.current.notice?.message).toContain("Retry will reconnect");

    await act(async () => {
      await result.current.startManual("Changed after uncertainty");
    });

    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.label).toBe("Before migration");
    expect(commands[0]?.operationId).toContain(":renderer.backup.manual:");
  });

  test("keeps an already-running outcome distinct from the requested operation", async () => {
    const activeJob = job("backup:active");
    const port = portWith({
      start: async (command) => ({
        kind: "already_running",
        operationId: command.operationId,
        activeJobId: activeJob.jobId,
      }),
      job: async (jobId) => (jobId === activeJob.jobId ? activeJob : null),
    });
    const { result } = renderHook(() => useStoreBackupRuntime({ open: true, port }));

    let requestedOperationId = "";
    await act(async () => {
      const outcome = await result.current.startManual("Requested");
      requestedOperationId = outcome.operationId;
      expect(outcome.kind).toBe("already_running");
    });

    await waitFor(() => expect(result.current.job?.jobId).toBe(activeJob.jobId));
    expect(requestedOperationId).not.toBe(activeJob.jobId);
    expect(result.current.notice?.message).toContain("already running");
  });

  test("does not turn an accepted start into an unknown outcome when progress is unavailable", async () => {
    const start = vi.fn(async (command: CreateBackupCommandInput) => ({
      kind: "already_running" as const,
      operationId: command.operationId,
      activeJobId: "backup:active",
    }));
    const { result } = renderHook(() =>
      useStoreBackupRuntime({
        open: true,
        port: portWith({
          start,
          job: async () => {
            throw new Error("progress unavailable");
          },
        }),
      }),
    );

    let outcome: BackupStartResult | undefined;
    await act(async () => {
      outcome = await result.current.startManual("Requested");
    });

    expect(outcome?.kind).toBe("already_running");
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.current.notice?.message).toBe("progress unavailable");
  });
});
