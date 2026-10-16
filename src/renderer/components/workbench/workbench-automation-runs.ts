import type { CodexAutomationInboxItem } from "@/lib/types";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";

export interface WorkbenchAutomationPreviousRunRowModel {
  item: CodexAutomationInboxItem;
  runId: string;
  sessionId: string | null;
  title: string;
  sourceLabel: string | null;
  relativeTimeLabel: string;
  isUnread: boolean;
  isArchived: boolean;
  isInProgress: boolean;
  canArchive: boolean;
  canUnarchive: boolean;
  canOpen: boolean;
}

function basename(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function formatWorkbenchAutomationRunSourceLabel(sourceCwd: string | null): string | null {
  if (!sourceCwd) return null;
  return basename(sourceCwd) || sourceCwd;
}

export function buildWorkbenchAutomationPreviousRunRowModel({
  item,
  now,
}: {
  item: CodexAutomationInboxItem;
  now?: number;
}): WorkbenchAutomationPreviousRunRowModel {
  const isArchived = item.status === "ARCHIVED";
  const isInProgress = item.status === "IN_PROGRESS";
  const hasRun = item.runId.trim().length > 0;
  const sessionId = item.sessionId?.trim() || null;

  return {
    item,
    runId: item.runId,
    sessionId,
    title: item.title ?? item.automationName ?? "Untitled",
    sourceLabel: formatWorkbenchAutomationRunSourceLabel(item.sourceCwd),
    relativeTimeLabel: formatCompactRelativeTime(item.createdAt, now),
    isUnread: item.readAt === null,
    isArchived,
    isInProgress,
    canArchive: hasRun && !isArchived && !isInProgress,
    canUnarchive: hasRun && isArchived,
    canOpen: sessionId !== null && !isArchived,
  };
}

export function buildWorkbenchAutomationPreviousRunRows({
  items,
  automationId,
  now,
}: {
  items: readonly CodexAutomationInboxItem[];
  automationId: string;
  now?: number;
}): WorkbenchAutomationPreviousRunRowModel[] {
  return items
    .filter((item) => item.automationId === automationId)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((item) => buildWorkbenchAutomationPreviousRunRowModel({ item, now }));
}
