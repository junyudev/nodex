import {
  formatCodexScheduledAutomationNextRunLabel,
  formatCodexScheduledAutomationRruleSummary,
} from "@/lib/codex-scheduled-automation-display";
import type { CodexScheduledAutomation } from "@/lib/types";

export interface WorkbenchAutomationRowModel {
  automation: CodexScheduledAutomation;
  displayName: string;
  workspaceLabel: string | null;
  scheduleLabel: string;
  secondaryStatusLabel: string | null;
  hasUnreadRuns: boolean;
  isInProgress: boolean;
  isPaused: boolean;
}

export interface WorkbenchAutomationListModel {
  current: WorkbenchAutomationRowModel[];
  paused: WorkbenchAutomationRowModel[];
}

export function normalizeAutomationListSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function basename(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function formatWorkbenchAutomationWorkspaceLabel(
  automation: CodexScheduledAutomation,
): string | null {
  if (automation.cwds.length === 1) return basename(automation.cwds[0]) || automation.cwds[0];
  if (automation.cwds.length > 1) {
    const first = basename(automation.cwds[0]) || automation.cwds[0];
    return `${first} + ${automation.cwds.length - 1} more`;
  }
  if (automation.kind === "heartbeat" && automation.targetSessionId) return "Chat";
  return null;
}

export function buildWorkbenchAutomationRowModel({
  automation,
  runningAutomationIds,
  unreadAutomationIds,
  now,
}: {
  automation: CodexScheduledAutomation;
  runningAutomationIds: ReadonlySet<string>;
  unreadAutomationIds: ReadonlySet<string>;
  now?: Date;
}): WorkbenchAutomationRowModel {
  const isPaused = automation.status === "PAUSED";
  const isInProgress = runningAutomationIds.has(automation.id);
  const scheduleLabel =
    formatCodexScheduledAutomationRruleSummary(automation.rrule) ?? "Custom schedule";
  const secondaryStatusLabel = isInProgress
    ? "In progress"
    : !isPaused && automation.nextRunAt !== null
      ? `Next run ${formatCodexScheduledAutomationNextRunLabel(automation.nextRunAt, now)}`
      : null;

  return {
    automation,
    displayName: automation.name,
    workspaceLabel: formatWorkbenchAutomationWorkspaceLabel(automation),
    scheduleLabel,
    secondaryStatusLabel,
    hasUnreadRuns: unreadAutomationIds.has(automation.id),
    isInProgress,
    isPaused,
  };
}

export function workbenchAutomationRowMatchesSearch(
  row: WorkbenchAutomationRowModel,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  const searchable = [
    row.displayName,
    row.automation.prompt,
    row.workspaceLabel ?? "",
    row.scheduleLabel,
    row.automation.kind,
    row.automation.targetSessionId ?? "",
    row.automation.rrule ?? "",
    row.automation.cwds.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return searchable.includes(normalizedQuery);
}

export function buildWorkbenchAutomationListModel({
  automations,
  runningAutomationIds,
  unreadAutomationIds,
  searchQuery,
  now,
}: {
  automations: readonly CodexScheduledAutomation[];
  runningAutomationIds: ReadonlySet<string>;
  unreadAutomationIds: ReadonlySet<string>;
  searchQuery: string;
  now?: Date;
}): WorkbenchAutomationListModel {
  const normalizedQuery = normalizeAutomationListSearchText(searchQuery);
  const rows = automations
    .map((automation) =>
      buildWorkbenchAutomationRowModel({
        automation,
        runningAutomationIds,
        unreadAutomationIds,
        now,
      }),
    )
    .filter((row) => workbenchAutomationRowMatchesSearch(row, normalizedQuery));

  return {
    current: rows.filter((row) => !row.isPaused),
    paused: rows.filter((row) => row.isPaused),
  };
}
