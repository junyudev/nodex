import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BackupCapacity,
  BackupJobStatus,
  BackupRecord,
  BackupStartResult,
  CreateBackupCommandInput,
  SnapshotStorageOptimization,
} from "../../shared/types";
import { resolveFormErrorMessage } from "./forms";
import { projectBackupJob } from "./backup-job-presentation";
import { createBoundedOperationId } from "../../shared/operation-identity";
import type { RendererCausalTraceContext } from "./renderer-causal-trace";
import { beginRendererOwnerTrace, recordRendererOwnerTrace } from "./renderer-causal-trace";
import type { BackupRuntimePort } from "./backup-runtime";

export interface StoreBackupRuntimeNotice {
  readonly message: string;
  readonly tone: "error" | "status";
}

export interface UseStoreBackupRuntimeInput {
  readonly open: boolean;
  readonly port: BackupRuntimePort;
}

/** Owns snapshot inventory, durable job convergence, cancellation, and polling. */
export function useStoreBackupRuntime({ open, port }: UseStoreBackupRuntimeInput) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [capacity, setCapacity] = useState<BackupCapacity | null>(null);
  const [storageOptimization, setStorageOptimization] =
    useState<SnapshotStorageOptimization | null>(null);
  const [job, setJob] = useState<BackupJobStatus | null>(null);
  const [polledJobId, setPolledJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [notice, setNotice] = useState<StoreBackupRuntimeNotice | null>(null);
  const pendingStart = useRef<{
    readonly command: CreateBackupCommandInput;
    readonly trace: RendererCausalTraceContext | null;
  } | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  const submitPendingStart = useCallback(
    async (pending: NonNullable<typeof pendingStart.current>): Promise<BackupStartResult> => {
      recordRendererOwnerTrace(pending.trace, {
        kind: "submitted",
        reason: "transport_submit",
      });
      try {
        const result = await port.start(pending.command);
        if (result.kind === "submitted") {
          recordRendererOwnerTrace(pending.trace, {
            kind: "pending",
            reason: "accepted_pending",
          });
          return result;
        }
        recordRendererOwnerTrace(pending.trace, {
          kind: "result",
          reason: "terminal_result",
        });
        recordRendererOwnerTrace(pending.trace, {
          kind: "settled",
          reason: "proof_complete",
        });
        if (pendingStart.current === pending) pendingStart.current = null;
        return result;
      } catch (cause) {
        recordRendererOwnerTrace(pending.trace, {
          kind: "failed",
          reason: "transport_failure",
        });
        throw cause;
      }
    },
    [port],
  );

  const reloadInventory = useCallback(async () => {
    const [records, nextCapacity] = await Promise.all([port.list(), port.capacity()]);
    setBackups(Array.isArray(records) ? records : []);
    setCapacity(nextCapacity);
  }, [port]);

  const reloadStorageOptimization = useCallback(async () => {
    const next = await port.storageOptimization();
    setStorageOptimization(next);
  }, [port]);

  const reloadJob = useCallback(async () => {
    const next = await port.job();
    setJob(next);
    setPolledJobId(next && projectBackupJob(next).active ? next.jobId : null);
  }, [port]);

  const refresh = useCallback(async () => {
    setNotice(null);
    await Promise.all([reloadInventory(), reloadStorageOptimization(), reloadJob()]);
  }, [reloadInventory, reloadJob, reloadStorageOptimization]);

  const settleJob = useCallback(
    async (settled: BackupJobStatus) => {
      setPolledJobId((current) => (current === settled.jobId ? null : current));
      const pending = pendingStart.current;
      if (pending?.command.operationId === settled.jobId) {
        recordRendererOwnerTrace(pending.trace, {
          kind: "result",
          reason: "terminal_result",
        });
        recordRendererOwnerTrace(pending.trace, {
          kind: "settled",
          reason: "proof_complete",
        });
        pendingStart.current = null;
      }
      if (settled.state === "completed") {
        await reloadInventory();
        setNotice({ message: "Manual snapshot created.", tone: "status" });
        return;
      }
      if (settled.state === "failed") {
        setNotice({ message: settled.error ?? "Could not create snapshot.", tone: "error" });
        return;
      }
      if (settled.state === "cancelled") {
        setNotice({ message: "Snapshot cancelled before publication.", tone: "status" });
      }
    },
    [reloadInventory],
  );

  const adoptStartResult = useCallback(
    async (result: BackupStartResult) => {
      if (result.kind === "submitted") {
        setJob(result.job);
        if (projectBackupJob(result.job).active) {
          setPolledJobId(result.job.jobId);
          return;
        }
        await settleJob(result.job);
        return;
      }
      setPolledJobId(result.activeJobId);
      const active = await port.job(result.activeJobId);
      if (active) {
        setJob(active);
        if (!projectBackupJob(active).active) {
          await settleJob(active);
          return;
        }
      }
      setNotice({
        message: "A snapshot is already running; showing its progress.",
        tone: "status",
      });
    },
    [port, settleJob],
  );

  const settleCoalescedStart = useCallback((requestedJobId: string, activeJobId: string) => {
    const pending = pendingStart.current;
    if (pending?.command.operationId === requestedJobId) {
      recordRendererOwnerTrace(pending.trace, {
        kind: "result",
        reason: "terminal_result",
      });
      recordRendererOwnerTrace(pending.trace, {
        kind: "settled",
        reason: "proof_complete",
      });
      pendingStart.current = null;
    }
    setNotice({
      message: `A snapshot is already running; reconnected to ${activeJobId}.`,
      tone: "status",
    });
  }, []);

  const presentation = job ? projectBackupJob(job) : null;
  useEffect(() => {
    if (!open || !polledJobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await port.job(polledJobId);
        if (disposed) return;
        if (!next) {
          const pending = pendingStart.current;
          if (pending?.command.operationId === polledJobId) {
            await adoptStartResult(await submitPendingStart(pending));
          }
          timer = setTimeout(poll, 250);
          return;
        }
        if (next.jobId === polledJobId) {
          setNotice(null);
        } else {
          settleCoalescedStart(polledJobId, next.jobId);
          setPolledJobId(next.jobId);
        }
        setJob(next);
        if (projectBackupJob(next).active) {
          timer = setTimeout(poll, 250);
          return;
        }
        await settleJob(next);
      } catch (cause) {
        if (disposed) return;
        setNotice({
          message: resolveFormErrorMessage(cause) ?? "Could not read snapshot progress.",
          tone: "error",
        });
        timer = setTimeout(poll, 1_000);
      }
    };
    timer = setTimeout(poll, 250);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    adoptStartResult,
    open,
    polledJobId,
    port,
    settleCoalescedStart,
    settleJob,
    submitPendingStart,
  ]);

  useEffect(() => {
    if (!open || !storageOptimization?.optimizing) return;
    const timer = setInterval(() => void reloadStorageOptimization(), 2_000);
    return () => clearInterval(timer);
  }, [open, reloadStorageOptimization, storageOptimization?.optimizing]);

  useEffect(() => {
    if (open) return;
    setNotice(null);
  }, [open]);

  const cancelJob = useCallback(async () => {
    if (!job || !projectBackupJob(job).cancellable) return;
    setCancelPending(true);
    setNotice(null);
    try {
      const cancelled = await port.cancel(job.jobId);
      setJob(cancelled);
      if (!projectBackupJob(cancelled).active) await settleJob(cancelled);
    } catch (cause) {
      setNotice({
        message: resolveFormErrorMessage(cause) ?? "Could not cancel snapshot.",
        tone: "error",
      });
    } finally {
      setCancelPending(false);
    }
  }, [job, port, settleJob]);

  const startManual = useCallback(
    async (label?: string): Promise<BackupStartResult> => {
      let pending = pendingStart.current;
      if (!pending) {
        const operationId = createBoundedOperationId("renderer.backup.manual");
        const trace = beginRendererOwnerTrace({
          semanticKey: "backup.create",
          operationIdentity: operationId,
          owner: "BackupRuntime",
          protocol: "pending_operation",
          scopeKind: "application",
        });
        pending = {
          command: {
            operationId,
            ...(label?.trim() ? { label: label.trim() } : {}),
          },
          trace,
        };
        pendingStart.current = pending;
        recordRendererOwnerTrace(trace, { kind: "local_intent", reason: "local_intent" });
      }
      if (!pending) throw new Error("Backup start ownership was not established");
      setSubmitting(true);
      setNotice(null);
      let result: BackupStartResult;
      try {
        result = await submitPendingStart(pending);
      } catch (cause) {
        setNotice({
          message: "Snapshot submission is unresolved. Retry will reconnect to the same operation.",
          tone: "error",
        });
        setSubmitting(false);
        throw cause;
      }
      try {
        await adoptStartResult(result);
      } catch (cause) {
        setNotice({
          message: resolveFormErrorMessage(cause) ?? "Could not read snapshot progress.",
          tone: "error",
        });
      }
      setSubmitting(false);
      return result;
    },
    [adoptStartResult, submitPendingStart],
  );

  return {
    backups,
    cancelJob,
    cancelPending,
    capacity,
    clearNotice,
    job,
    notice,
    presentation,
    refresh,
    reloadInventory,
    startManual,
    storageOptimization,
    submitting,
  } as const;
}
