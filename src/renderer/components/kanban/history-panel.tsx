import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TAB_BAR_HEIGHT } from "@/lib/layout";
import { KANBAN_STATUS_LABELS } from "@/lib/kanban-options";
import { cn } from "@/lib/utils";
import { invoke } from "@/lib/api";
import type { HistoryEntry } from "../../../shared/ipc-api";

type HistoryOperationFilter = "all" | HistoryEntry["operation"];

const OPERATION_FILTERS: Array<{ value: HistoryOperationFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "update", label: "Updates" },
  { value: "move", label: "Moves" },
  { value: "create", label: "Creates" },
  { value: "delete", label: "Deletes" },
];

const COLUMN_LABELS: Record<string, string> = KANBAN_STATUS_LABELS;

const FIELD_LABELS: Record<string, string> = {
  id: "Card ID",
  title: "Title",
  description: "Description",
  priority: "Priority",
  estimate: "Estimate",
  tags: "Tags",
  dueDate: "Due date",
  scheduledStart: "Scheduled start",
  scheduledEnd: "Scheduled end",
  isAllDay: "All-day",
  assignee: "Assignee",
  agentBlocked: "Blocked",
  agentStatus: "Agent status",
  created: "Created",
  order: "Order",
};

const FIELD_ORDER = [
  "title",
  "description",
  "priority",
  "estimate",
  "tags",
  "dueDate",
  "scheduledStart",
  "scheduledEnd",
  "isAllDay",
  "assignee",
  "agentBlocked",
  "agentStatus",
  "order",
  "created",
  "id",
];

// Resize constants
const PANEL_MIN_WIDTH = 640;
const PANEL_MAX_WIDTH = 1400;
const PANEL_DEFAULT_WIDTH = 960;
const PANEL_STORAGE_KEY = "history-panel-width";

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return PANEL_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return PANEL_DEFAULT_WIDTH;
    return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, n));
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

interface HistoryPanelProps {
  projectId: string;
  cardId: string | null;
  open: boolean;
  onClose: () => void;
  onCardMutated?: () => void;
  mode?: "overlay" | "embedded";
  className?: string;
}

export function HistoryPanel({
  projectId,
  cardId,
  open,
  onClose,
  onCardMutated,
  mode = "overlay",
  className,
}: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);
  const [operationFilter, setOperationFilter] = useState<HistoryOperationFilter>("all");
  const [loading, setLoading] = useState(false);

  // Action state
  const [actionInFlight, setActionInFlight] = useState<"revert" | "restore" | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<{
    type: "revert" | "restore";
    entryId: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Resize state
  const [panelWidth, setPanelWidth] = useState(readStoredWidth);
  const panelRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  const fetchHistory = useCallback(async (targetCardId: string) => {
    setLoading(true);
    try {
      const data = (await invoke(
        "history:card",
        projectId,
        targetCardId
      )) as { entries: HistoryEntry[] };
      const nextEntries = data.entries || [];
      setEntries(nextEntries);
      setSelectedEntryId((current) => {
        if (!nextEntries.length) return null;
        if (current !== null && nextEntries.some((entry) => entry.id === current)) {
          return current;
        }
        return nextEntries[0].id;
      });
    } catch (err) {
      console.error("Failed to fetch history:", err);
      setEntries([]);
      setSelectedEntryId(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open && cardId) {
      fetchHistory(cardId);
    }
  }, [open, cardId, fetchHistory]);

  useEffect(() => {
    if (open) return;
    setOperationFilter("all");
    setConfirmingAction(null);
    setActionError(null);
  }, [open]);

  // Clear confirmation when selected entry changes
  useEffect(() => {
    setConfirmingAction(null);
    setActionError(null);
  }, [selectedEntryId]);

  const filteredEntries = useMemo(() => {
    if (operationFilter === "all") return entries;
    return entries.filter((entry) => entry.operation === operationFilter);
  }, [entries, operationFilter]);

  useEffect(() => {
    if (filteredEntries.length === 0) {
      setSelectedEntryId(null);
      return;
    }
    if (selectedEntryId !== null && filteredEntries.some((entry) => entry.id === selectedEntryId)) {
      return;
    }
    setSelectedEntryId(filteredEntries[0].id);
  }, [filteredEntries, selectedEntryId]);

  const selectedIndex = useMemo(
    () => filteredEntries.findIndex((entry) => entry.id === selectedEntryId),
    [filteredEntries, selectedEntryId]
  );

  const selectedEntry = selectedIndex >= 0 ? filteredEntries[selectedIndex] : null;

  const navigateSelectedEntry = useCallback((direction: -1 | 1) => {
    if (filteredEntries.length === 0) return;

    const currentIndex = filteredEntries.findIndex((entry) => entry.id === selectedEntryId);
    if (currentIndex === -1) {
      setSelectedEntryId(filteredEntries[0].id);
      return;
    }

    const nextIndex = Math.min(
      filteredEntries.length - 1,
      Math.max(0, currentIndex + direction)
    );
    setSelectedEntryId(filteredEntries[nextIndex].id);
  }, [filteredEntries, selectedEntryId]);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navigateSelectedEntry(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      navigateSelectedEntry(-1);
    }
  }, [navigateSelectedEntry]);

  // Action handlers
  const handleRevert = useCallback(async (entryId: number, operation: string) => {
    setActionInFlight("revert");
    setActionError(null);
    try {
      const result = await invoke("history:revert", projectId, entryId) as { success: boolean; error?: string };
      if (!result.success) {
        setActionError(result.error ?? "Revert failed");
        return;
      }
      setConfirmingAction(null);
      onCardMutated?.();
      // If reverting a create (card deleted), close the panel
      if (operation === "create") {
        onClose();
        return;
      }
      if (cardId) await fetchHistory(cardId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Revert failed");
    } finally {
      setActionInFlight(null);
    }
  }, [projectId, cardId, fetchHistory, onCardMutated, onClose]);

  const handleRestore = useCallback(async (entryId: number) => {
    if (!cardId) return;
    setActionInFlight("restore");
    setActionError(null);
    try {
      const result = await invoke("history:restore", projectId, cardId, entryId) as { success: boolean; error?: string };
      if (!result.success) {
        setActionError(result.error ?? "Restore failed");
        return;
      }
      setConfirmingAction(null);
      onCardMutated?.();
      await fetchHistory(cardId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setActionInFlight(null);
    }
  }, [projectId, cardId, fetchHistory, onCardMutated]);

  // Resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const panel = panelRef.current;
    if (panel) panel.style.transition = "none";

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + (startX - ev.clientX))
      );
      if (panel) panel.style.width = `${newWidth}px`;
    };

    const onMouseUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      isResizingRef.current = false;

      if (panel) panel.style.transition = "";

      const finalWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(PANEL_MIN_WIDTH, startWidth + (startX - ev.clientX))
      );
      setPanelWidth(finalWidth);
      try { localStorage.setItem(PANEL_STORAGE_KEY, String(finalWidth)); } catch { /* ignore */ }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [panelWidth]);

  if (!open) {
    return null;
  }

  const panel = (
    <div
      ref={panelRef}
      className={cn(
        "relative h-full",
        "bg-(--background-primary)",
        "border-l border-(--border-primary)",
        "shadow-lg",
        "flex flex-col",
        mode === "overlay" && "animate-in duration-200 slide-in-from-right",
        className,
      )}
      style={{ width: panelWidth }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className={cn(
          "absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize",
          "transition-colors duration-150 hover:bg-(--accent-blue)",
          "active:bg-(--accent-blue)"
        )}
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-(--border-primary) px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-(--foreground-primary)">
            Edit History
          </h3>
          <p className="mt-0.5 text-xs text-(--foreground-tertiary)">
            {filteredEntries.length} of {entries.length} entries
          </p>
        </div>
        <button
          onClick={onClose}
          className={cn(
            "flex h-7 w-7 items-center justify-center",
            "text-(--foreground-tertiary)",
            "hover:bg-(--background-secondary) hover:text-(--foreground-secondary)",
            "rounded-md transition-colors"
          )}
          aria-label="Close history panel"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M4 4l8 8m0-8l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="py-8 text-center text-sm text-(--foreground-tertiary)">
            Loading history...
          </div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-sm text-(--foreground-tertiary)">
            No history for this card
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-row">
            <aside
              className={cn(
                "min-h-0 w-80 border-r border-(--border-primary)",
                "flex flex-col"
              )}
            >
              <div className="border-b border-(--border-primary) p-3">
                <div className="flex flex-wrap gap-1.5">
                  {OPERATION_FILTERS.map((filter) => (
                    <button
                      key={filter.value}
                      onClick={() => setOperationFilter(filter.value)}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs transition-colors",
                        operationFilter === filter.value
                          ? "bg-(--accent-blue) text-white"
                          : "bg-(--background-secondary) text-(--foreground-secondary) hover:bg-(--background-tertiary)"
                      )}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className="flex-1 space-y-2 overflow-y-auto p-3"
                onKeyDown={handleListKeyDown}
              >
                {filteredEntries.length === 0 ? (
                  <div className="px-1 py-3 text-xs text-(--foreground-tertiary)">
                    No entries for this filter.
                  </div>
                ) : (
                  filteredEntries.map((entry) => (
                    <HistoryEntryListItem
                      key={entry.id}
                      entry={entry}
                      selected={entry.id === selectedEntry?.id}
                      onSelect={() => setSelectedEntryId(entry.id)}
                    />
                  ))
                )}
              </div>
            </aside>

            <section className="min-h-0 flex-1 overflow-y-auto p-4">
              {selectedEntry ? (
                <HistoryEntryDetails
                  entry={selectedEntry}
                  selectedIndex={selectedIndex}
                  totalCount={filteredEntries.length}
                  onNavigate={navigateSelectedEntry}
                  onRevert={handleRevert}
                  onRestore={handleRestore}
                  actionInFlight={actionInFlight}
                  confirmingAction={confirmingAction}
                  onRequestConfirm={setConfirmingAction}
                  onCancelConfirm={() => { setConfirmingAction(null); setActionError(null); }}
                  actionError={actionError}
                />
              ) : (
                <div className="py-8 text-center text-sm text-(--foreground-tertiary)">
                  Select an entry to view details.
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );

  if (mode === "embedded") {
    return panel;
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50",
        "flex items-center justify-end",
        "bg-black/20 backdrop-blur-sm"
      )}
      style={{ top: TAB_BAR_HEIGHT }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {panel}
    </div>
  );
}

function HistoryEntryListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: HistoryEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const summary = getEntrySummary(entry);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-(--accent-blue) bg-[color-mix(in_srgb,var(--accent-blue)_12%,transparent)]"
          : "border-(--border-primary) bg-(--background-secondary) hover:bg-(--background-tertiary)",
        entry.isUndone && "opacity-60"
      )}
      aria-current={selected ? "true" : undefined}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full",
            "bg-(--background-tertiary)",
            "text-(--foreground-secondary)"
          )}
        >
          {getOperationIcon(entry.operation)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-(--foreground-primary)">
              {getOperationLabel(entry.operation)}
            </span>
            {entry.isUndone && (
              <span className="rounded-sm bg-(--background-tertiary) px-1.5 py-0.5 text-xs text-(--foreground-tertiary)">
                Undone
              </span>
            )}
          </div>
          {summary && (
            <div className="mt-0.5 text-xs text-(--foreground-tertiary)">
              {summary}
            </div>
          )}
          <div className="mt-1 text-xs text-(--foreground-tertiary)">
            {formatRelativeTimestamp(entry.timestamp)}
          </div>
        </div>
      </div>
    </button>
  );
}

function HistoryEntryDetails({
  entry,
  selectedIndex,
  totalCount,
  onNavigate,
  onRevert,
  onRestore,
  actionInFlight,
  confirmingAction,
  onRequestConfirm,
  onCancelConfirm,
  actionError,
}: {
  entry: HistoryEntry;
  selectedIndex: number;
  totalCount: number;
  onNavigate: (direction: -1 | 1) => void;
  onRevert: (entryId: number, operation: string) => void;
  onRestore: (entryId: number) => void;
  actionInFlight: "revert" | "restore" | null;
  confirmingAction: { type: "revert" | "restore"; entryId: number } | null;
  onRequestConfirm: (action: { type: "revert" | "restore"; entryId: number }) => void;
  onCancelConfirm: () => void;
  actionError: string | null;
}) {
  const canGoPrev = selectedIndex > 0;
  const canGoNext = selectedIndex < totalCount - 1;
  const isActionable = !entry.isUndone && entry.undoOf === null;
  const isConfirmingThis = confirmingAction?.entryId === entry.id;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-(--background-secondary) text-(--foreground-secondary)">
              {getOperationIcon(entry.operation)}
            </span>
            <h4 className="text-base font-medium text-(--foreground-primary)">
              {getOperationLabel(entry.operation)}
            </h4>
            {entry.isUndone && (
              <span className="rounded-sm bg-(--background-tertiary) px-1.5 py-0.5 text-xs text-(--foreground-tertiary)">
                Undone
              </span>
            )}
          </div>
          <div className="mt-2 text-xs text-(--foreground-tertiary)">
            <span>{formatRelativeTimestamp(entry.timestamp)}</span>
            <span className="mx-1.5">&bull;</span>
            <span>{formatAbsoluteTimestamp(entry.timestamp)}</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onNavigate(-1)}
            disabled={!canGoPrev}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
              canGoPrev
                ? "border-(--border-primary) text-(--foreground-secondary) hover:bg-(--background-secondary)"
                : "cursor-not-allowed border-(--border-primary) text-(--foreground-disabled)"
            )}
            aria-label="Previous history entry"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onNavigate(1)}
            disabled={!canGoNext}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
              canGoNext
                ? "border-(--border-primary) text-(--foreground-secondary) hover:bg-(--background-secondary)"
                : "cursor-not-allowed border-(--border-primary) text-(--foreground-disabled)"
            )}
            aria-label="Next history entry"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 11l4-4-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Action bar */}
      {isActionable && (
        <div className="rounded-lg border border-(--border-primary) bg-(--background-secondary) p-3">
          {isConfirmingThis ? (
            <div className="space-y-2">
              <p className="text-xs text-(--foreground-secondary)">
                {confirmingAction.type === "revert"
                  ? getRevertConfirmMessage(entry)
                  : `Restore card to the state at ${formatAbsoluteTimestamp(entry.timestamp)}?`}
              </p>
              {actionError && (
                <p className="text-xs text-(--priority-critical-text)">{actionError}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={actionInFlight !== null}
                  onClick={() => {
                    if (confirmingAction.type === "revert") {
                      onRevert(entry.id, entry.operation);
                    } else {
                      onRestore(entry.id);
                    }
                  }}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    entry.operation === "create" && confirmingAction.type === "revert"
                      ? "bg-(--priority-critical-bg) text-(--priority-critical-text) hover:opacity-90"
                      : "bg-(--accent-blue) text-white hover:opacity-90",
                    actionInFlight !== null && "cursor-not-allowed opacity-50"
                  )}
                >
                  {actionInFlight !== null ? "Working..." : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={onCancelConfirm}
                  disabled={actionInFlight !== null}
                  className="rounded-md px-3 py-1.5 text-xs text-(--foreground-secondary) transition-colors hover:bg-(--background-tertiary)"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onRequestConfirm({ type: "revert", entryId: entry.id })}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  "border border-(--border-primary)",
                  "text-(--foreground-secondary) hover:bg-(--background-tertiary)"
                )}
              >
                {getRevertLabel(entry.operation)}
              </button>
              <button
                type="button"
                onClick={() => onRequestConfirm({ type: "restore", entryId: entry.id })}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  "border border-(--border-primary)",
                  "text-(--foreground-secondary) hover:bg-(--background-tertiary)"
                )}
              >
                Restore to this point
              </button>
            </div>
          )}
        </div>
      )}

      {entry.operation === "update" && <UpdateDetails entry={entry} />}
      {entry.operation === "move" && <MoveDetails entry={entry} />}
      {(entry.operation === "create" || entry.operation === "delete") && <SnapshotDetails entry={entry} />}

      <details className="rounded-lg border border-(--border-primary) bg-(--background-secondary)">
        <summary className="cursor-pointer px-3 py-2 text-xs text-(--foreground-secondary) select-none">
          Raw history payload
        </summary>
        <pre className="overflow-x-auto border-t border-(--border-primary) p-3 text-xs wrap-break-word whitespace-pre-wrap text-(--foreground-secondary)">
          {JSON.stringify(entry, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function UpdateDetails({ entry }: { entry: HistoryEntry }) {
  const changedFields = getChangedFieldKeys(entry);

  if (changedFields.length === 0) {
    return (
      <div className="rounded-lg border border-(--border-primary) bg-(--background-secondary) p-3 text-sm text-(--foreground-tertiary)">
        No field-level diff was recorded for this update.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {changedFields.map((field) => (
        <article
          key={field}
          className="overflow-hidden rounded-lg border border-(--border-primary) bg-(--background-secondary)"
        >
          <header className="border-b border-(--border-primary) px-3 py-2">
            <h5 className="text-xs font-medium tracking-wide text-(--foreground-secondary) uppercase">
              {formatFieldLabel(field)}
            </h5>
          </header>
          <div className="grid grid-cols-2">
            <div className="border-r border-(--border-primary) p-3">
              <div className="mb-2 text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
                Before
              </div>
              <HistoryValue value={entry.previousValues?.[field]} emptyText="Not set" />
            </div>
            <div className="p-3">
              <div className="mb-2 text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
                After
              </div>
              <HistoryValue value={entry.newValues?.[field]} emptyText="Cleared" />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function MoveDetails({ entry }: { entry: HistoryEntry }) {
  const fromColumn = getColumnLabel(entry.fromColumnId);
  const toColumn = getColumnLabel(entry.toColumnId);

  return (
    <div className="rounded-lg border border-(--border-primary) bg-(--background-secondary)">
      <div className="grid grid-cols-2">
        <div className="border-r border-(--border-primary) p-3">
          <div className="mb-2 text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
            From
          </div>
          <div className="text-sm text-(--foreground-primary)">{fromColumn}</div>
          <div className="mt-1 text-xs text-(--foreground-tertiary)">
            Position: {formatOrder(entry.fromOrder)}
          </div>
        </div>
        <div className="p-3">
          <div className="mb-2 text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
            To
          </div>
          <div className="text-sm text-(--foreground-primary)">{toColumn}</div>
          <div className="mt-1 text-xs text-(--foreground-tertiary)">
            Position: {formatOrder(entry.toOrder)}
          </div>
        </div>
      </div>
    </div>
  );
}

function SnapshotDetails({ entry }: { entry: HistoryEntry }) {
  const snapshot = entry.cardSnapshot as Record<string, unknown> | null;

  if (!snapshot) {
    return (
      <div className="rounded-lg border border-(--border-primary) bg-(--background-secondary) p-3 text-sm text-(--foreground-tertiary)">
        Snapshot data is unavailable for this entry.
      </div>
    );
  }

  const snapshotFields = FIELD_ORDER.filter((field) =>
    Object.prototype.hasOwnProperty.call(snapshot, field)
  );
  const extraSnapshotFields = Object.keys(snapshot)
    .filter((field) => !snapshotFields.includes(field))
    .sort();
  const orderedSnapshotFields = [...snapshotFields, ...extraSnapshotFields];

  return (
    <div className="divide-y divide-(--border-primary) rounded-lg border border-(--border-primary) bg-(--background-secondary)">
      {orderedSnapshotFields.map((field) => (
        <div key={field} className="px-3 py-2">
          <div className="mb-1 text-xs font-medium tracking-wide text-(--foreground-tertiary) uppercase">
            {formatFieldLabel(field)}
          </div>
          <HistoryValue value={snapshot[field]} emptyText="Not set" />
        </div>
      ))}
    </div>
  );
}

function HistoryValue({ value, emptyText }: { value: unknown; emptyText: string }) {
  const normalized = normalizeHistoryValue(value);

  if (!normalized) {
    return <span className="text-sm text-(--foreground-tertiary)">{emptyText}</span>;
  }

  if (normalized.multiline) {
    return (
      <pre className="text-xs/5 wrap-break-word whitespace-pre-wrap text-(--foreground-secondary)">
        {normalized.text}
      </pre>
    );
  }

  return (
    <span className="text-sm wrap-break-word text-(--foreground-primary)">
      {normalized.text}
    </span>
  );
}

// --- Action helpers ---

function getRevertLabel(op: string): string {
  switch (op) {
    case "update": return "Revert update";
    case "move": return "Revert move";
    case "create": return "Delete this card";
    case "delete": return "Restore card";
    default: return "Revert";
  }
}

function getRevertConfirmMessage(entry: HistoryEntry): string {
  switch (entry.operation) {
    case "update": return "Revert this update? The changed fields will be restored to their previous values.";
    case "move": return `Revert this move? The card will be moved back to ${getColumnLabel(entry.fromColumnId)}.`;
    case "create": return "This will delete the card. This action creates a history entry and can be reversed.";
    case "delete": return "Restore this deleted card? It will be re-created from the saved snapshot.";
    default: return "Are you sure?";
  }
}

// --- Formatting helpers ---

function getOperationLabel(op: string): string {
  switch (op) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    case "move":
      return "Moved";
    case "update":
      return "Updated";
    default:
      return op;
  }
}

function getOperationIcon(op: string) {
  switch (op) {
    case "create":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      );
    case "delete":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      );
    case "move":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      );
    case "update":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      );
    default:
      return null;
  }
}

function getEntrySummary(entry: HistoryEntry): string | null {
  if (entry.operation === "update") {
    const fields = getChangedFieldKeys(entry);
    if (fields.length === 0) return "Updated card";
    if (fields.length === 1) return `Changed ${formatFieldLabel(fields[0]).toLowerCase()}`;
    return `Changed ${fields.length} fields`;
  }

  if (entry.operation === "move") {
    return `${getColumnLabel(entry.fromColumnId)} \u2192 ${getColumnLabel(entry.toColumnId)}`;
  }

  if (entry.operation === "create") {
    return "Card created";
  }

  if (entry.operation === "delete") {
    return "Card deleted";
  }

  return null;
}

function getChangedFieldKeys(entry: HistoryEntry): string[] {
  const previousKeys = Object.keys(entry.previousValues ?? {});
  const newKeys = Object.keys(entry.newValues ?? {});
  const merged = new Set([...previousKeys, ...newKeys]);

  return [...merged].sort((a, b) => {
    const aIndex = FIELD_ORDER.indexOf(a);
    const bIndex = FIELD_ORDER.indexOf(b);
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });
}

function formatFieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  return field.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function getColumnLabel(columnId: string | null): string {
  if (!columnId) return "Unknown column";
  return COLUMN_LABELS[columnId] ?? columnId;
}

function formatOrder(order: number | null): string {
  if (order === null || order < 0) return "Unknown";
  return String(order + 1);
}

function formatRelativeTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;

  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60_000) return "Just now";

  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000);
    return `${mins} min${mins > 1 ? "s" : ""} ago`;
  }

  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAbsoluteTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeHistoryValue(
  value: unknown
): { text: string; multiline: boolean } | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "boolean") {
    return { text: value ? "Yes" : "No", multiline: false };
  }

  if (typeof value === "number") {
    return { text: String(value), multiline: false };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return { text: value.map((item) => String(item)).join(", "), multiline: false };
  }

  if (typeof value === "string") {
    const formattedDate = formatMaybeDate(value);
    const text = formattedDate ?? value;
    return { text, multiline: text.includes("\n") || text.length > 120 };
  }

  if (typeof value === "object") {
    const text = JSON.stringify(value, null, 2);
    return { text, multiline: true };
  }

  return { text: String(value), multiline: false };
}

function formatMaybeDate(value: string): string | null {
  const isDateLike = /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value);
  if (!isDateLike) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
