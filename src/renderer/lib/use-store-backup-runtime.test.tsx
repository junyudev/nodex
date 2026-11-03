import { StrictMode } from "react";
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
  test("clears notices on opening and input transitions, while reads preserve the current notice", async () => {
    const port = portWith({
      start: async (command) => ({
        kind: "submitted",
        operationId: command.operationId,
        job: job(command.operationId, "failed"),
      }),
    });
    const view = renderHook(useStoreBackupRuntime, {
      initialProps: { open: false, port },
      wrapper: StrictMode,
    });
    await act(async () => {
      await view.result.current.startManual();
    });
    expect(view.result.current.notice?.message).toBe("Snapshot failed.");
    view.rerender({ open: true, port });
    expect(view.result.current.notice).toBeNull();
    await act(async () => {
      await view.result.current.startManual();
    });
    await act(async () => {
      await view.result.current.refresh();
    });
    expect(view.result.current.notice?.message).toBe("Snapshot failed.");
    view.rerender({ open: true, port: portWith({}) });
    expect(view.result.current.notice).toBeNull();
    view.unmount();
  });

  test("releases cancellation pending state after a failed cancellation", async () => {
    let fail!: (error: Error) => void;
    const cancel = vi.fn(
      () =>
        new Promise<BackupJobStatus>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const port = portWith({ job: async () => job("active"), cancel });
    const view = renderHook(() => useStoreBackupRuntime({ open: false, port }));
    await act(async () => {
      await view.result.current.refresh();
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = view.result.current.cancelJob();
    });
    expect(view.result.current.cancelPending).toBe(true);
    await act(async () => {
      fail(new Error("cancel unavailable"));
      await pending;
    });
    expect(view.result.current.cancelPending).toBe(false);
    expect(view.result.current.notice).toEqual({ tone: "error", message: "cancel unavailable" });
    expect(view.result.current.job?.state).toBe("running");
  });

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
    const port = portWith({ start });
    const { result } = renderHook(() => useStoreBackupRuntime({ open: true, port }));

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
    const port = portWith({
      start,
      job: async () => {
        throw new Error("progress unavailable");
      },
    });
    const { result } = renderHook(() => useStoreBackupRuntime({ open: true, port }));

    let outcome: BackupStartResult | undefined;
    await act(async () => {
      outcome = await result.current.startManual("Requested");
    });

    expect(outcome?.kind).toBe("already_running");
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.current.notice?.message).toBe("progress unavailable");
  });
});
