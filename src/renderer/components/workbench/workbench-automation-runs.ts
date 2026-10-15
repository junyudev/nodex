import type { CodexAutomationInboxItem } from "@/lib/types";

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

export function formatWorkbenchAutomationRunRelativeTime(
  createdAt: number,
  now = Date.now(),
): string {
  if (!Number.isFinite(createdAt)) return "";

  const elapsedMs = Math.max(0, now - createdAt);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) return "now";
  if (elapsedMs < hourMs) return `${Math.max(1, Math.floor(elapsedMs / minuteMs))}m`;
  if (elapsedMs < dayMs) return `${Math.max(1, Math.floor(elapsedMs / hourMs))}h`;
  if (elapsedMs < 30 * dayMs) return `${Math.max(1, Math.floor(elapsedMs / dayMs))}d`;

  return new Date(createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
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
    relativeTimeLabel: formatWorkbenchAutomationRunRelativeTime(item.createdAt, now),
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
