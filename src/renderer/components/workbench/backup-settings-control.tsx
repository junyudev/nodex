import { useForm, useStore } from "@tanstack/react-form";
import { useCallback, useEffect, useState } from "react";
import { DeleteIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { Input } from "../ui/input";
import {
  backupRuntimePort,
  deleteBackup,
  readBackupSettings,
  readHistorySettings,
  restoreBackup,
  updateBackupSettings,
  updateHistorySettings,
} from "./workbench-settings-overlay-deps";
import { handleFormSubmit, resolveFormErrorMessage, resolveZodErrorMessage } from "../../lib/forms";
import { useStoreBackupRuntime } from "../../lib/use-store-backup-runtime";
import type { BackupRecord, BackupSettings, HistorySettings, Project } from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  BACKUP_SCHEDULE_FORM_DEFAULTS,
  BackupScheduleFormSchema,
  HISTORY_RETENTION_FORM_DEFAULTS,
  HistoryRetentionFormSchema,
  MANUAL_SNAPSHOT_FORM_DEFAULTS,
  ManualSnapshotFormSchema,
} from "./workbench-settings-form-schemas";
import {
  NodexSettingsNumberInput,
  NodexSettingsSection as SectionBlock,
  NodexSettingsRow as SettingRow,
} from "../ui/settings";

const BACKUP_TRIGGER_LABELS: Record<BackupRecord["trigger"], string> = {
  manual: "Manual",
  auto: "Auto",
  "pre-restore": "Safety",
};

function formatBackupSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatBackupTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BackupSettingsControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [historySettings, setHistorySettings] = useState<HistorySettings | null>(null);
  const backupRuntime = useStoreBackupRuntime({ open, port: backupRuntimePort });
  const {
    backups,
    cancelJob: cancelBackupJob,
    cancelPending,
    capacity: backupCapacity,
    clearNotice: clearBackupNotice,
    job: backupJob,
    notice: backupNotice,
    presentation: backupJobPresentation,
    refresh: refreshBackupRuntime,
    reloadInventory: loadBackups,
    startManual: startManualBackup,
    storageOptimization,
  } = backupRuntime;
  const [createSafetyBackup, setCreateSafetyBackup] = useState(true);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    "refresh" | "save" | "create" | "restore" | "delete" | null
  >(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scheduleForm = useForm({
    defaultValues: BACKUP_SCHEDULE_FORM_DEFAULTS,
    validators: {
      onSubmit: BackupScheduleFormSchema,
    },
    onSubmitInvalid: ({ value }) => {
      const parsed = BackupScheduleFormSchema.safeParse(value);
      setError(resolveZodErrorMessage(parsed.error) ?? "Could not save backup schedule.");
      setStatus(null);
    },
    onSubmit: async ({ value }) => {
      if (!settings) return;
      const parsed = BackupScheduleFormSchema.parse(value);

      setBusyAction("save");
      setError(null);
      setStatus(null);

      try {
        const updated = await updateBackupSettings({
          autoEnabled: settings.envOverrides.autoEnabled
            ? settings.autoEnabled
            : parsed.autoEnabled,
          intervalHours: settings.envOverrides.intervalHours
            ? settings.intervalHours
            : parsed.intervalHours,
          retentionCount: settings.envOverrides.retentionCount
            ? settings.retentionCount
            : parsed.retentionCount,
          retentionGiB: settings.envOverrides.retentionGiB
            ? settings.retentionGiB
            : parsed.retentionGiB,
        });
        setSettings(updated);
        scheduleForm.reset({
          autoEnabled: updated.autoEnabled,
          intervalHours: String(updated.intervalHours),
          retentionCount: String(updated.retentionCount),
          retentionGiB: String(updated.retentionGiB),
        });
        setStatus("Backup schedule saved.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not save backup schedule.");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const historyForm = useForm({
    defaultValues: HISTORY_RETENTION_FORM_DEFAULTS,
    validators: {
      onSubmit: HistoryRetentionFormSchema,
    },
    onSubmitInvalid: ({ value }) => {
      const parsed = HistoryRetentionFormSchema.safeParse(value);
      setError(resolveZodErrorMessage(parsed.error) ?? "Could not save history retention.");
      setStatus(null);
    },
    onSubmit: async ({ value }) => {
      if (!historySettings) return;
      const parsed = HistoryRetentionFormSchema.parse(value);

      setBusyAction("save");
      setError(null);
      setStatus(null);

      try {
        const updated = await updateHistorySettings({
          retentionCount: historySettings.envOverrides.retentionCount
            ? historySettings.retentionCount
            : parsed.retentionCount,
        });
        setHistorySettings(updated);
        historyForm.reset({
          retentionCount: String(updated.retentionCount),
        });
        setStatus("History retention saved.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not save history retention.");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const snapshotForm = useForm({
    defaultValues: MANUAL_SNAPSHOT_FORM_DEFAULTS,
    validators: {
      onSubmit: ManualSnapshotFormSchema,
    },
    onSubmit: async ({ value, formApi }) => {
      const parsed = ManualSnapshotFormSchema.parse(value);
      setBusyAction("create");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      try {
        const result = await startManualBackup(parsed.label || undefined);
        formApi.reset();
        setStatus(
          result.kind === "submitted"
            ? "Snapshot started in the background."
            : "A snapshot was already running. Showing its progress.",
        );
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not create backup.");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const scheduleValues = useStore(scheduleForm.store, (state) => state.values);
  const historyValues = useStore(historyForm.store, (state) => state.values);
  const snapshotValues = useStore(snapshotForm.store, (state) => state.values);

  const loadBackupSettings = useCallback(async () => {
    const data = await readBackupSettings();
    setSettings(data);
    scheduleForm.reset({
      autoEnabled: data.autoEnabled,
      intervalHours: String(data.intervalHours),
      retentionCount: String(data.retentionCount),
      retentionGiB: String(data.retentionGiB),
    });
  }, [scheduleForm]);

  const loadHistorySettings = useCallback(async () => {
    const data = await readHistorySettings();
    setHistorySettings(data);
    historyForm.reset({
      retentionCount: String(data.retentionCount),
    });
  }, [historyForm]);

  const refresh = useCallback(async () => {
    setBusyAction("refresh");
    setError(null);
    setStatus(null);

    try {
      await Promise.all([loadBackupSettings(), loadHistorySettings(), refreshBackupRuntime()]);
      setConfirmRestoreId(null);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load backups.");
    } finally {
      setBusyAction(null);
    }
  }, [loadBackupSettings, loadHistorySettings, refreshBackupRuntime]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (open) return;
    clearBackupNotice();
    setStatus(null);
    setError(null);
    setConfirmRestoreId(null);
    setConfirmDeleteId(null);
    snapshotForm.reset();
  }, [clearBackupNotice, historyForm, open, snapshotForm]);

  const handleRestoreBackup = useCallback(
    async (backupId: string) => {
      if (confirmRestoreId !== backupId) {
        setConfirmDeleteId(null);
        setConfirmRestoreId(backupId);
        setStatus("Click Restore again to confirm.");
        return;
      }

      setBusyAction("restore");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      try {
        await restoreBackup({
          backupId,
          confirm: true,
          createSafetyBackup,
        });
        await loadBackups();
        setConfirmRestoreId(null);
        setStatus("Backup restored.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not restore backup.");
      } finally {
        setBusyAction(null);
      }
    },
    [clearBackupNotice, confirmRestoreId, createSafetyBackup, loadBackups],
  );

  const handleDeleteBackup = useCallback(
    async (backupId: string) => {
      if (confirmDeleteId !== backupId) {
        setConfirmRestoreId(null);
        setConfirmDeleteId(backupId);
        setStatus(null);
        setError(null);
        return;
      }

      setBusyAction("delete");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      try {
        await deleteBackup(backupId);
        await loadBackups();
        setConfirmDeleteId(null);
        setStatus("Snapshot deleted.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not delete backup.");
      } finally {
        setBusyAction(null);
      }
    },
    [clearBackupNotice, confirmDeleteId, loadBackups],
  );

  const hasBackupEnvOverrides =
    settings?.envOverrides.autoEnabled ||
    settings?.envOverrides.intervalHours ||
    settings?.envOverrides.retentionCount ||
    settings?.envOverrides.retentionGiB;
  const hasHistoryEnvOverride = historySettings?.envOverrides.retentionCount;
  const backupProgressUnits = backupJobPresentation?.progressUnits ?? 0;
  const backupProgressTotal = backupJobPresentation?.progressTotal ?? 1;
  const isBackupBusy = busyAction !== null || cancelPending;

  return (
    <div className="flex flex-col gap-[var(--padding-panel)]">
      <SectionBlock title="Automatic snapshots">
        <SettingRow
          label="Auto backups"
          description="Schedule background snapshots for the local store."
        >
          <NodexSwitch
            ariaLabel="Auto backups"
            checked={scheduleValues.autoEnabled}
            onCheckedChange={(value) => scheduleForm.setFieldValue("autoEnabled", value)}
            disabled={Boolean(settings?.envOverrides.autoEnabled)}
          />
        </SettingRow>
        <SettingRow label="Frequency" description="Minimum is one hour.">
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-16"
              min={1}
              value={scheduleValues.intervalHours}
              disabled={Boolean(settings?.envOverrides.intervalHours)}
              onChange={(event) => scheduleForm.setFieldValue("intervalHours", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">hours</span>
          </div>
        </SettingRow>
        <SettingRow label="Retention" description="Snapshots kept before pruning.">
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-16"
              min={0}
              value={scheduleValues.retentionCount}
              disabled={Boolean(settings?.envOverrides.retentionCount)}
              onChange={(event) => scheduleForm.setFieldValue("retentionCount", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">max</span>
          </div>
        </SettingRow>
        <SettingRow
          label="Storage budget"
          description="Automatic snapshots share this limit; manual snapshots are never removed."
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-20"
              min={0}
              max={8192}
              value={scheduleValues.retentionGiB}
              disabled={Boolean(settings?.envOverrides.retentionGiB)}
              onChange={(event) => scheduleForm.setFieldValue("retentionGiB", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">GiB</span>
          </div>
        </SettingRow>
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-token-text-secondary">
            {hasBackupEnvOverrides ? "Some values locked by env vars." : null}
          </div>
          <div className="flex items-center gap-2">
            <NodexButton
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              disabled={isBackupBusy}
            >
              Refresh
            </NodexButton>
            <NodexButton
              variant="primary"
              size="sm"
              onClick={() => void scheduleForm.handleSubmit()}
              disabled={isBackupBusy}
            >
              Save schedule
            </NodexButton>
          </div>
        </div>
      </SectionBlock>

      <SectionBlock title="History retention">
        <SettingRow
          label="History retention"
          description="Newest deleted Block records kept per Project before safe collection. Use 0 to collect every unreferenced tombstone."
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-20"
              min={0}
              value={historyValues.retentionCount}
              disabled={Boolean(historySettings?.envOverrides.retentionCount)}
              onChange={(event) => historyForm.setFieldValue("retentionCount", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">records</span>
          </div>
        </SettingRow>
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-token-text-secondary">
            {hasHistoryEnvOverride
              ? "Value locked by env var."
              : "Applied by background maintenance."}
          </div>
          <NodexButton
            variant="primary"
            size="sm"
            onClick={() => void historyForm.handleSubmit()}
            disabled={isBackupBusy}
          >
            Apply
          </NodexButton>
        </div>
      </SectionBlock>

      <SectionBlock title="Snapshots">
        {storageOptimization ? (
          <div className="flex items-start justify-between gap-3 px-3 pt-3 text-xs text-token-text-secondary">
            <div>
              <div className="text-token-text-primary">
                {storageOptimization.optimizing
                  ? "Optimizing snapshot storage"
                  : "Snapshot storage is optimized"}
              </div>
              <div className="mt-0.5">
                {storageOptimization.optimizing
                  ? storageOptimization.pendingCommitMetadata +
                      storageOptimization.pendingReceiptMetadata >
                    0
                    ? `${(
                        storageOptimization.pendingCommitMetadata +
                        storageOptimization.pendingReceiptMetadata
                      ).toLocaleString()} historical records remain to be measured before safe trimming.`
                    : "Old delivery history is being trimmed in short background slices."
                  : "Operational history stays inside a bounded retention window."}
              </div>
            </div>
            <span className="shrink-0 tabular-nums">
              {formatBackupSize(
                storageOptimization.retainedDeliveryBytes +
                  storageOptimization.retainedReceiptBytes,
              )}
            </span>
          </div>
        ) : null}
        {backupCapacity ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-3 text-xs text-token-text-secondary">
            <span>{formatBackupSize(backupCapacity.totalReadyBytes)} stored</span>
            <span aria-hidden="true">·</span>
            <span>{formatBackupSize(backupCapacity.availableBytes)} available</span>
            <span aria-hidden="true">·</span>
            <span>Next snapshot ≈ {formatBackupSize(backupCapacity.estimatedNextBackupBytes)}</span>
            {!backupCapacity.canCreate ? (
              <span className="text-danger">More free space is required for a safe snapshot.</span>
            ) : null}
          </div>
        ) : null}
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={(event) => handleFormSubmit(event, snapshotForm.handleSubmit)}
        >
          <Input
            value={snapshotValues.label}
            placeholder="Optional snapshot label"
            onChange={(event) => snapshotForm.setFieldValue("label", event.target.value)}
            className="min-w-0 flex-1"
          />
          <NodexButton
            type="submit"
            variant="secondary"
            size="sm"
            disabled={
              isBackupBusy || backupJobPresentation?.active || backupCapacity?.canCreate === false
            }
          >
            {backupJobPresentation?.active ? "Creating…" : "Create snapshot"}
          </NodexButton>
        </form>
        {backupJob && backupJobPresentation?.active ? (
          <div
            className="semantic-text-secondary flex flex-col gap-1.5 px-3 pb-3 text-xs"
            aria-live="polite"
          >
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-text-info" aria-hidden="true" />
              <span className="text-info">{backupJobPresentation.phaseLabel}</span>
              <span aria-hidden="true">·</span>
              <span>The app remains available while the snapshot is verified.</span>
              <button
                type="button"
                className="ms-auto cursor-interaction text-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
                disabled={cancelPending || !backupJobPresentation.cancellable}
                onClick={() => void cancelBackupJob()}
              >
                {cancelPending ? "Cancelling…" : "Cancel"}
              </button>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-text/10"
              role="progressbar"
              aria-label="Snapshot progress"
              aria-valuemin={0}
              aria-valuemax={backupProgressTotal}
              aria-valuenow={backupProgressUnits}
            >
              <div
                className="h-full rounded-full bg-text-info transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, (backupProgressUnits / backupProgressTotal) * 100)}%`,
                }}
              />
            </div>
            {backupJob.progress.databaseTotalPages > 0 ? (
              <div>
                {backupJob.progress.databaseCopiedPages.toLocaleString()} of{" "}
                {backupJob.progress.databaseTotalPages.toLocaleString()} database pages copied
                {backupJob.progress.databaseBusyRetries > 0
                  ? ` · ${backupJob.progress.databaseBusyRetries.toLocaleString()} transient retries`
                  : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <SettingRow
          label="Safety backup"
          description="Create a fresh snapshot before restoring an older one."
        >
          <NodexSwitch
            ariaLabel="Safety backup"
            checked={createSafetyBackup}
            onCheckedChange={setCreateSafetyBackup}
          />
        </SettingRow>
        <div className="flex flex-col">
          {backups.length === 0 ? (
            <div className="px-3 py-3 text-sm text-token-text-secondary">No snapshots yet.</div>
          ) : (
            backups.map((backup) => (
              <div key={backup.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-token-text-primary">
                    {backup.label?.trim() || backup.id}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-token-text-secondary">
                    <span>{formatBackupTimestamp(backup.createdAt)}</span>
                    <span>{formatBackupSize(backup.totalBytes)}</span>
                    <span className="inline-flex items-center rounded-full bg-token-foreground/5 px-1.5 py-px text-xs text-token-text-secondary">
                      {BACKUP_TRIGGER_LABELS[backup.trigger]}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {confirmDeleteId === backup.id ? (
                    <>
                      <NodexButton
                        variant="destructive"
                        size="sm"
                        onClick={() => void handleDeleteBackup(backup.id)}
                        disabled={isBackupBusy}
                      >
                        Confirm delete
                      </NodexButton>
                      <NodexButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={isBackupBusy}
                      >
                        Cancel
                      </NodexButton>
                    </>
                  ) : (
                    <>
                      <NodexButton
                        variant={confirmRestoreId === backup.id ? "destructive" : "secondary"}
                        size="sm"
                        onClick={() => void handleRestoreBackup(backup.id)}
                        disabled={isBackupBusy}
                      >
                        {confirmRestoreId === backup.id ? "Confirm restore" : "Restore"}
                      </NodexButton>
                      <NodexTooltip tooltipContent="Delete snapshot">
                        <NodexButton
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void handleDeleteBackup(backup.id)}
                          disabled={isBackupBusy}
                          aria-label={`Delete snapshot ${backup.label?.trim() || backup.id}`}
                        >
                          <DeleteIcon className="size-3.5" />
                        </NodexButton>
                      </NodexTooltip>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </SectionBlock>

      {status ? <p className="text-sm text-token-text-secondary">{status}</p> : null}
      {error ? <p className="text-sm text-token-error-foreground">{error}</p> : null}
      {backupNotice ? (
        <p
          className={cn(
            "text-sm",
            backupNotice.tone === "error"
              ? "text-token-error-foreground"
              : "text-token-text-secondary",
          )}
        >
          {backupNotice.message}
        </p>
      ) : null}
    </div>
  );
}
