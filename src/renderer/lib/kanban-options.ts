import type { Priority } from "./types";
import {
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_STATUS_LABELS,
  TOGGLE_LIST_STATUS_ORDER,
} from "./toggle-list/types";

export const ARCHIVED_CARD_OPTION_ID = "archived";
export const ARCHIVED_CARD_OPTION_NAME = "Archived";

export const KANBAN_STATUS_OPTIONS = [
  ...TOGGLE_LIST_STATUS_ORDER.map((id) => ({
    id,
    name: TOGGLE_LIST_STATUS_LABELS[id],
  })),
  { id: ARCHIVED_CARD_OPTION_ID, name: ARCHIVED_CARD_OPTION_NAME },
] as const;

export const KANBAN_STATUS_LABELS: Record<string, string> = KANBAN_STATUS_OPTIONS.reduce<Record<string, string>>(
  (labels, option) => {
    labels[option.id] = option.name;
    return labels;
  },
  {},
);

const PRIORITY_PRIMARY_LABELS: Record<Priority, string> = {
  "p0-critical": "P0 - Critical",
  "p1-high": "P1 - High",
  "p2-medium": "P2 - Medium",
  "p3-low": "P3 - Low",
  "p4-later": "P4 - Later",
};

const PRIORITY_CLASS_NAMES: Record<Priority, string> = {
  "p0-critical": "bg-[var(--priority-critical-bg)] text-[var(--priority-critical-text)]",
  "p1-high": "bg-[var(--priority-high-bg)] text-[var(--priority-high-text)]",
  "p2-medium": "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-text)]",
  "p3-low": "bg-[var(--priority-low-bg)] text-[var(--priority-low-text)]",
  "p4-later": "bg-[var(--priority-later-bg)] text-[var(--priority-later-text)]",
};

export type KanbanPriorityOption = {
  value: Priority;
  label: string;
  shortLabel: string;
  className: string;
};

export const KANBAN_PRIORITY_OPTIONS: KanbanPriorityOption[] = TOGGLE_LIST_PRIORITY_ORDER.map((value) => ({
  value,
  label: PRIORITY_PRIMARY_LABELS[value],
  shortLabel: PRIORITY_PRIMARY_LABELS[value],
  className: PRIORITY_CLASS_NAMES[value],
}));

export const KANBAN_PRIORITY_OPTIONS_BY_VALUE = KANBAN_PRIORITY_OPTIONS.reduce<Record<Priority, KanbanPriorityOption>>(
  (result, option) => {
    result[option.value] = option;
    return result;
  },
  {} as Record<Priority, KanbanPriorityOption>,
);

export function resolveKanbanPriorityOption(priority: Priority): KanbanPriorityOption {
  return KANBAN_PRIORITY_OPTIONS_BY_VALUE[priority];
}
