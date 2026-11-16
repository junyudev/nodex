import { getIntl, type MessageDescriptor } from "@/lib/i18n";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { z } from "zod";

export interface BackupScheduleFormInput {
  autoEnabled: boolean;
  intervalHours: string;
  retentionCount: string;
  retentionGiB: string;
}

export interface HistoryRetentionFormInput {
  retentionCount: string;
}

export interface ManualSnapshotFormInput {
  label: string;
}

function integerTextField(label: MessageDescriptor, minimum: number) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const parsed = Number.parseInt(value, 10);
      const isCanonicalInteger = /^-?\d+$/.test(value);
      if (isCanonicalInteger && Number.isInteger(parsed) && parsed >= minimum) {
        return;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: getIntl().formatMessage(
          {
            id: "settings.backups.mustBeAnInteger",
            defaultMessage: "{label} must be an integer >= {minimum}.",
          },
          { label: getIntl().formatMessage(label), minimum },
        ),
      });
    });
}

export const BACKUP_SCHEDULE_FORM_DEFAULTS: BackupScheduleFormInput = {
  autoEnabled: false,
  intervalHours: "6",
  retentionCount: "28",
  retentionGiB: "32",
};

export const BackupScheduleFormSchema = z
  .object({
    autoEnabled: z.boolean(),
    intervalHours: integerTextField(settingsMessages.backupsFrequency, 1),
    retentionCount: integerTextField(settingsMessages.backupsRetention, 0),
    retentionGiB: integerTextField(settingsMessages.backupsStorageBudget, 0),
  })
  .transform((value) => ({
    autoEnabled: value.autoEnabled,
    intervalHours: Number.parseInt(value.intervalHours.trim(), 10),
    retentionCount: Number.parseInt(value.retentionCount.trim(), 10),
    retentionGiB: Number.parseInt(value.retentionGiB.trim(), 10),
  }));

export const HISTORY_RETENTION_FORM_DEFAULTS: HistoryRetentionFormInput = {
  retentionCount: "1000",
};

export const HistoryRetentionFormSchema = z
  .object({
    retentionCount: integerTextField(settingsMessages.backupsHistoryRetention, 0),
  })
  .transform((value) => ({
    retentionCount: Number.parseInt(value.retentionCount.trim(), 10),
  }));

export const MANUAL_SNAPSHOT_FORM_DEFAULTS: ManualSnapshotFormInput = {
  label: "",
};

export const ManualSnapshotFormSchema = z
  .object({
    label: z.string(),
  })
  .transform((value) => ({
    label: value.label.trim(),
  }));
