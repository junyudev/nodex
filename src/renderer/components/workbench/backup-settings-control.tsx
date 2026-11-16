import type { IntlShape } from "@/lib/i18n";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
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
import type { BackupRecord, BackupSettings, HistorySettings } from "../../lib/types";
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

const BACKUP_TRIGGER_LABELS: Record<BackupRecord["trigger"], MessageDescriptor> = {
  manual: settingsMessages.backupsManual,
  auto: settingsMessages.backupsAuto,
  "pre-restore": settingsMessages.backupsSafety,
};

function formatBackupSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatBackupTimestamp(value: string, intl: IntlShape = getIntl()): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return parsed.toLocaleString(intl.locale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BackupSettingsControl({ open }: { open: boolean }) {
  const intl = useIntl();
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
  >(open ? "refresh" : null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scheduleForm = useForm({
    defaultValues: BACKUP_SCHEDULE_FORM_DEFAULTS,
    validators: {
      onSubmit: BackupScheduleFormSchema,
    },
    onSubmitInvalid: ({ value }) => {
      const parsed = BackupScheduleFormSchema.safeParse(value);
      setError(
        resolveZodErrorMessage(parsed.error) ??
          intl.formatMessage({
            id: "settings.backups.couldNotSaveBackupSchedule",
            defaultMessage: "Could not save backup schedule.",
          }),
      );
      setStatus(null);
    },
    onSubmit: async ({ value }) => {
      if (!settings) return;
      const parsed = BackupScheduleFormSchema.parse(value);

      setBusyAction("save");
      setError(null);
      setStatus(null);

      return runWithCleanup(
        async () => {
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
          setStatus(
            intl.formatMessage({
              id: "settings.backups.backupScheduleSaved",
              defaultMessage: "Backup schedule saved.",
            }),
          );
        },
        {
          cleanup: () => setBusyAction(null),
          onError: (err) => {
            setError(
              resolveFormErrorMessage(err) ??
                intl.formatMessage({
                  id: "settings.backups.couldNotSaveBackupSchedule",
                  defaultMessage: "Could not save backup schedule.",
                }),
            );
          },
        },
      );
    },
  });
  const historyForm = useForm({
    defaultValues: HISTORY_RETENTION_FORM_DEFAULTS,
    validators: {
      onSubmit: HistoryRetentionFormSchema,
    },
    onSubmitInvalid: ({ value }) => {
      const parsed = HistoryRetentionFormSchema.safeParse(value);
      setError(
        resolveZodErrorMessage(parsed.error) ??
          intl.formatMessage({
            id: "settings.backups.couldNotSaveHistoryRetention",
            defaultMessage: "Could not save history retention.",
          }),
      );
      setStatus(null);
    },
    onSubmit: async ({ value }) => {
      if (!historySettings) return;
      const parsed = HistoryRetentionFormSchema.parse(value);

      setBusyAction("save");
      setError(null);
      setStatus(null);

      return runWithCleanup(
        async () => {
          const updated = await updateHistorySettings({
            retentionCount: historySettings.envOverrides.retentionCount
              ? historySettings.retentionCount
              : parsed.retentionCount,
          });
          setHistorySettings(updated);
          historyForm.reset({
            retentionCount: String(updated.retentionCount),
          });
          setStatus(
            intl.formatMessage({
              id: "settings.backups.historyRetentionSaved",
              defaultMessage: "History retention saved.",
            }),
          );
        },
        {
          cleanup: () => setBusyAction(null),
          onError: (err) => {
            setError(
              resolveFormErrorMessage(err) ??
                intl.formatMessage({
                  id: "settings.backups.couldNotSaveHistoryRetention",
                  defaultMessage: "Could not save history retention.",
                }),
            );
          },
        },
      );
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

      return runWithCleanup(
        async () => {
          const result = await startManualBackup(parsed.label || undefined);
          formApi.reset();
          setStatus(
            result.kind === "submitted"
              ? intl.formatMessage({
                  id: "settings.backups.snapshotStartedInTheBackground",
                  defaultMessage: "Snapshot started in the background.",
                })
              : intl.formatMessage({
                  id: "settings.backups.aSnapshotWasAlreadyRunningShowing",
                  defaultMessage: "A snapshot was already running. Showing its progress.",
                }),
          );
        },
        {
          cleanup: () => setBusyAction(null),
          onError: (err) => {
            setError(
              resolveFormErrorMessage(err) ??
                intl.formatMessage({
                  id: "settings.backups.couldNotCreateBackup",
                  defaultMessage: "Could not create backup.",
                }),
            );
          },
        },
      );
    },
  });
  const scheduleValues = useStore(scheduleForm.store, (state) => state.values);
  const historyValues = useStore(historyForm.store, (state) => state.values);
  const snapshotValues = useStore(snapshotForm.store, (state) => state.values);

  const loadBackupSettings = useCallback(
    async () =>
      readBackupSettings().then((data) => {
        setSettings(data);
        scheduleForm.reset({
          autoEnabled: data.autoEnabled,
          intervalHours: String(data.intervalHours),
          retentionCount: String(data.retentionCount),
          retentionGiB: String(data.retentionGiB),
        });
      }),
    [scheduleForm],
  );

  const loadHistorySettings = useCallback(
    async () =>
      readHistorySettings().then((data) => {
        setHistorySettings(data);
        historyForm.reset({
          retentionCount: String(data.retentionCount),
        });
      }),
    [historyForm],
  );

  const refresh = useCallback(
    () =>
      Promise.all([loadBackupSettings(), loadHistorySettings(), refreshBackupRuntime()])
        .then(() => {
          setConfirmRestoreId(null);
          setConfirmDeleteId(null);
        })
        .catch((error: unknown) => {
          setError(
            error instanceof Error
              ? error.message
              : getIntl().formatMessage({
                  id: "settings.backups.couldNotLoadBackups",
                  defaultMessage: "Could not load backups.",
                }),
          );
        })
        .finally(() => setBusyAction(null)),
    [loadBackupSettings, loadHistorySettings, refreshBackupRuntime],
  );

  const [refreshInput, setRefreshInput] = useState({ open, refresh });
  if (refreshInput.open !== open || refreshInput.refresh !== refresh) {
    setRefreshInput({ open, refresh });
    if (open) setBusyAction("refresh");
    setStatus(null);
    setError(null);
    if (!open) {
      setConfirmRestoreId(null);
      setConfirmDeleteId(null);
    }
  }
  const startRefresh = () => {
    clearBackupNotice();
    setBusyAction("refresh");
    setError(null);
    setStatus(null);
    return refresh();
  };
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (open) return;
    clearBackupNotice();
    snapshotForm.reset();
  }, [clearBackupNotice, open, snapshotForm]);

  const handleRestoreBackup = useCallback(
    async (backupId: string) => {
      if (confirmRestoreId !== backupId) {
        setConfirmDeleteId(null);
        setConfirmRestoreId(backupId);
        setStatus(null);
        return;
      }

      setBusyAction("restore");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      return runWithCleanup(
        async () => {
          await restoreBackup({
            backupId,
            confirm: true,
            createSafetyBackup,
          });
          await loadBackups();
          setConfirmRestoreId(null);
          setStatus(getIntl().formatMessage(settingsMessages.backupsBackupRestored));
        },
        {
          cleanup: () => setBusyAction(null),
          onError: (err) => {
            setError(
              resolveFormErrorMessage(err) ??
                getIntl().formatMessage({
                  id: "settings.backups.couldNotRestoreBackup",
                  defaultMessage: "Could not restore backup.",
                }),
            );
          },
        },
      );
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

      return runWithCleanup(
        async () => {
          await deleteBackup(backupId);
          await loadBackups();
          setConfirmDeleteId(null);
          setStatus(getIntl().formatMessage(settingsMessages.backupsSnapshotDeleted));
        },
        {
          cleanup: () => setBusyAction(null),
          onError: (err) => {
            setError(
              resolveFormErrorMessage(err) ??
                getIntl().formatMessage({
                  id: "settings.backups.couldNotDeleteBackup",
                  defaultMessage: "Could not delete backup.",
                }),
            );
          },
        },
      );
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
      <SectionBlock title={intl.formatMessage(settingsMessages.backupsAutomaticSnapshots)}>
        <SettingRow
          label={intl.formatMessage(settingsMessages.backupsAutoBackups)}
          description={intl.formatMessage(settingsMessages.backupsSnapshotPagesDatabasesAndFilesIn)}
        >
          <NodexSwitch
            ariaLabel={intl.formatMessage(settingsMessages.backupsAutoBackups)}
            checked={scheduleValues.autoEnabled}
            onCheckedChange={(value) => scheduleForm.setFieldValue("autoEnabled", value)}
            disabled={Boolean(settings?.envOverrides.autoEnabled)}
          />
        </SettingRow>
        <SettingRow
          label={intl.formatMessage(settingsMessages.backupsFrequency)}
          description={intl.formatMessage(settingsMessages.backupsMinimumIsOneHour)}
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-16"
              min={1}
              value={scheduleValues.intervalHours}
              disabled={Boolean(settings?.envOverrides.intervalHours)}
              onChange={(event) => scheduleForm.setFieldValue("intervalHours", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">
              {intl.formatMessage(settingsMessages.backupsHours)}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          label={intl.formatMessage(settingsMessages.backupsRetention)}
          description={intl.formatMessage(settingsMessages.backupsSnapshotsKeptBeforePruning)}
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-16"
              min={0}
              value={scheduleValues.retentionCount}
              disabled={Boolean(settings?.envOverrides.retentionCount)}
              onChange={(event) => scheduleForm.setFieldValue("retentionCount", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">
              {intl.formatMessage(settingsMessages.backupsMax)}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          label={intl.formatMessage(settingsMessages.backupsStorageBudget)}
          description={intl.formatMessage({
            id: "settings.backups.automaticSnapshotsShareThisLimitManual",
            defaultMessage:
              "Automatic snapshots share this limit; manual snapshots are never removed.",
          })}
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
            {hasBackupEnvOverrides
              ? intl.formatMessage(settingsMessages.backupsSomeValuesLockedByEnvVars)
              : null}
          </div>
          <div className="flex items-center gap-2">
            <NodexButton
              variant="secondary"
              size="sm"
              onClick={() => void startRefresh()}
              disabled={isBackupBusy}
            >
              {intl.formatMessage(settingsMessages.backupsRefresh)}
            </NodexButton>
            <NodexButton
              variant="primary"
              size="sm"
              onClick={() => void scheduleForm.handleSubmit()}
              disabled={isBackupBusy}
            >
              {intl.formatMessage(settingsMessages.backupsSaveSchedule)}
            </NodexButton>
          </div>
        </div>
      </SectionBlock>

      <SectionBlock title={intl.formatMessage(settingsMessages.backupsHistoryRetention)}>
        <SettingRow
          label={intl.formatMessage(settingsMessages.backupsHistoryRetention)}
          description={intl.formatMessage(settingsMessages.backupsNewestDeletedBlockRecordsKeptPer)}
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-20"
              min={0}
              value={historyValues.retentionCount}
              disabled={Boolean(historySettings?.envOverrides.retentionCount)}
              onChange={(event) => historyForm.setFieldValue("retentionCount", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">
              {intl.formatMessage(settingsMessages.backupsRecords)}
            </span>
          </div>
        </SettingRow>
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-token-text-secondary">
            {hasHistoryEnvOverride
              ? intl.formatMessage(settingsMessages.backupsValueLockedByEnvVar)
              : intl.formatMessage(settingsMessages.backupsAppliedByBackgroundMaintenance)}
          </div>
          <NodexButton
            variant="primary"
            size="sm"
            onClick={() => void historyForm.handleSubmit()}
            disabled={isBackupBusy}
          >
            {intl.formatMessage(settingsMessages.backupsApply)}
          </NodexButton>
        </div>
      </SectionBlock>

      <SectionBlock title={intl.formatMessage(settingsMessages.backupsSnapshots)}>
        {storageOptimization ? (
          <div className="flex items-start justify-between gap-3 px-3 pt-3 text-xs text-token-text-secondary">
            <div>
              <div className="text-token-text-primary">
                {storageOptimization.optimizing
                  ? intl.formatMessage({
                      id: "settings.backups.optimizingSnapshotStorage",
                      defaultMessage: "Optimizing snapshot storage",
                    })
                  : intl.formatMessage({
                      id: "settings.backups.snapshotStorageIsOptimized",
                      defaultMessage: "Snapshot storage is optimized",
                    })}
              </div>
              <div className="mt-0.5">
                {storageOptimization.optimizing
                  ? storageOptimization.pendingCommitMetadata +
                      storageOptimization.pendingReceiptMetadata >
                    0
                    ? intl.formatMessage(
                        {
                          id: "settings.backups.historicalRecordsRemainToBeMeasured",
                          defaultMessage:
                            "{value} historical records remain to be measured before safe trimming.",
                        },
                        {
                          value: (
                            storageOptimization.pendingCommitMetadata +
                            storageOptimization.pendingReceiptMetadata
                          ).toLocaleString(intl.locale),
                        },
                      )
                    : intl.formatMessage({
                        id: "settings.backups.oldDeliveryHistoryIsBeingTrimmed",
                        defaultMessage:
                          "Old delivery history is being trimmed in short background slices.",
                      })
                  : intl.formatMessage({
                      id: "settings.backups.operationalHistoryStaysInsideABounded",
                      defaultMessage:
                        "Operational history stays inside a bounded retention window.",
                    })}
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
            <span>
              {intl.formatMessage(
                { id: "settings.backups.storedSize", defaultMessage: "{size} stored" },
                { size: formatBackupSize(backupCapacity.totalReadyBytes) },
              )}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {intl.formatMessage(
                { id: "settings.backups.availableSize", defaultMessage: "{size} available" },
                { size: formatBackupSize(backupCapacity.availableBytes) },
              )}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {intl.formatMessage(
                {
                  id: "settings.backups.nextSnapshotSize",
                  defaultMessage: "Next snapshot ≈ {size}",
                },
                { size: formatBackupSize(backupCapacity.estimatedNextBackupBytes) },
              )}
            </span>
            {!backupCapacity.canCreate ? (
              <span className="text-danger">
                {intl.formatMessage({
                  id: "settings.backups.moreFreeSpaceIsRequiredFor",
                  defaultMessage: "More free space is required for a safe snapshot.",
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={(event) => handleFormSubmit(event, snapshotForm.handleSubmit)}
        >
          <Input
            value={snapshotValues.label}
            placeholder={intl.formatMessage(settingsMessages.backupsOptionalSnapshotLabel)}
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
            {backupJobPresentation?.active
              ? intl.formatMessage({ id: "settings.backups.creating", defaultMessage: "Creating…" })
              : intl.formatMessage(settingsMessages.backupsCreateSnapshot)}
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
              <span>
                {intl.formatMessage({
                  id: "settings.backups.theAppRemainsAvailableWhileThe",
                  defaultMessage: "The app remains available while the snapshot is verified.",
                })}
              </span>
              <button
                type="button"
                className="ms-auto cursor-interaction text-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
                disabled={cancelPending || !backupJobPresentation.cancellable}
                onClick={() => void cancelBackupJob()}
              >
                {cancelPending
                  ? intl.formatMessage({
                      id: "settings.backups.cancelling",
                      defaultMessage: "Cancelling…",
                    })
                  : intl.formatMessage(settingsMessages.backupsCancel)}
              </button>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-text/10"
              role="progressbar"
              aria-label={intl.formatMessage({
                id: "settings.backups.snapshotProgress",
                defaultMessage: "Snapshot progress",
              })}
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
                {intl.formatNumber(backupJob.progress.databaseCopiedPages)}
                {intl.formatMessage({ id: "settings.backups.of", defaultMessage: " of" })}{" "}
                {intl.formatNumber(backupJob.progress.databaseTotalPages)}
                {intl.formatMessage({
                  id: "settings.backups.databasePagesCopied",
                  defaultMessage: " database pages copied",
                })}
                {backupJob.progress.databaseBusyRetries > 0
                  ? intl.formatMessage(
                      {
                        id: "settings.backups.retryCount",
                        defaultMessage: " · {count, number} transient retries",
                      },
                      { count: backupJob.progress.databaseBusyRetries },
                    )
                  : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <SettingRow
          label={intl.formatMessage(settingsMessages.backupsSafetyBackup)}
          description={intl.formatMessage(
            settingsMessages.backupsCreateAFreshSnapshotBeforeRestoring,
          )}
        >
          <NodexSwitch
            ariaLabel={intl.formatMessage(settingsMessages.backupsSafetyBackup)}
            checked={createSafetyBackup}
            onCheckedChange={setCreateSafetyBackup}
          />
        </SettingRow>
        <div className="flex flex-col">
          {backups.length === 0 ? (
            <div className="px-3 py-3 text-sm text-token-text-secondary">
              {intl.formatMessage(settingsMessages.backupsNoSnapshotsYet)}
            </div>
          ) : (
            backups.map((backup) => (
              <div key={backup.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-token-text-primary">
                    {backup.label?.trim() || backup.id}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-token-text-secondary">
                    <span>{formatBackupTimestamp(backup.createdAt, intl)}</span>
                    <span>{formatBackupSize(backup.totalBytes)}</span>
                    <span className="inline-flex items-center rounded-full bg-token-foreground/5 px-1.5 py-px text-xs text-token-text-secondary">
                      {intl.formatMessage(BACKUP_TRIGGER_LABELS[backup.trigger])}
                    </span>
                  </div>
                  {confirmRestoreId === backup.id ? (
                    <p className="mt-1 text-xs text-token-text-secondary">
                      {intl.formatMessage({
                        id: "settings.backups.pagesDatabasesFilesAndProjectsReturn",
                        defaultMessage:
                          "Pages, Databases, Files and Projects return to this snapshot. Chats keep their latest messages; running replies stop and Nodex restarts.",
                      })}
                    </p>
                  ) : null}
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
                        {intl.formatMessage(settingsMessages.backupsConfirmDelete)}
                      </NodexButton>
                      <NodexButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={isBackupBusy}
                      >
                        {intl.formatMessage(settingsMessages.backupsCancel)}
                      </NodexButton>
                    </>
                  ) : confirmRestoreId === backup.id ? (
                    <>
                      <NodexButton
                        variant="destructive"
                        size="sm"
                        onClick={() => void handleRestoreBackup(backup.id)}
                        disabled={isBackupBusy}
                      >
                        {intl.formatMessage(settingsMessages.backupsConfirmRestore)}
                      </NodexButton>
                      <NodexButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmRestoreId(null)}
                        disabled={isBackupBusy}
                      >
                        {intl.formatMessage(settingsMessages.backupsCancel)}
                      </NodexButton>
                    </>
                  ) : (
                    <>
                      <NodexButton
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleRestoreBackup(backup.id)}
                        disabled={isBackupBusy}
                      >
                        {intl.formatMessage(settingsMessages.backupsRestore)}
                      </NodexButton>
                      <NodexTooltip
                        tooltipContent={intl.formatMessage(settingsMessages.backupsDeleteSnapshot)}
                      >
                        <NodexButton
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void handleDeleteBackup(backup.id)}
                          disabled={isBackupBusy}
                          aria-label={intl.formatMessage(
                            {
                              id: "settings.backups.deleteSnapshot2",
                              defaultMessage: "Delete snapshot {id}",
                            },
                            { id: backup.label?.trim() || backup.id },
                          )}
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
