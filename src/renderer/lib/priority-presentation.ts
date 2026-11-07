import type { Priority } from "../../shared/priority";

interface PriorityPresentation {
  readonly label: string;
  readonly shortLabel: string;
  readonly className: string;
}

export const PRIORITY_PRESENTATION: Readonly<Record<Priority, PriorityPresentation>> = {
  "p0-critical": {
    label: "P0 - Critical",
    shortLabel: "P0",
    className: "bg-[var(--priority-critical-bg)] text-[var(--priority-critical-text)]",
  },
  "p1-high": {
    label: "P1 - High",
    shortLabel: "P1",
    className: "bg-[var(--priority-high-bg)] text-[var(--priority-high-text)]",
  },
  "p2-medium": {
    label: "P2 - Medium",
    shortLabel: "P2",
    className: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-text)]",
  },
  "p3-low": {
    label: "P3 - Low",
    shortLabel: "P3",
    className: "bg-[var(--priority-low-bg)] text-[var(--priority-low-text)]",
  },
};

export function getPriorityLabel(priority: Priority): string {
  return PRIORITY_PRESENTATION[priority].label;
}

export function getPriorityShortLabel(priority: Priority): string {
  return PRIORITY_PRESENTATION[priority].shortLabel;
}

export function getPriorityClassName(priority: Priority): string {
  return PRIORITY_PRESENTATION[priority].className;
}
