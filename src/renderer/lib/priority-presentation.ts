import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type { Priority } from "../../shared/priority";

interface PriorityPresentation {
  readonly label: string;
  readonly shortLabel: string;
  readonly className: string;
}

const PRIORITY_LABEL_MESSAGES = defineMessages({
  "p0-critical": {
    id: "lib.priorityPresentation.critical",
    defaultMessage: "P0 - Critical",
  },
  "p1-high": {
    id: "lib.priorityPresentation.high",
    defaultMessage: "P1 - High",
  },
  "p2-medium": {
    id: "lib.priorityPresentation.medium",
    defaultMessage: "P2 - Medium",
  },
  "p3-low": {
    id: "lib.priorityPresentation.low",
    defaultMessage: "P3 - Low",
  },
});

export const PRIORITY_PRESENTATION: Readonly<Record<Priority, PriorityPresentation>> = {
  "p0-critical": {
    get label() {
      return getPriorityLabel("p0-critical");
    },
    shortLabel: "P0",
    className: "bg-[var(--priority-critical-bg)] text-[var(--priority-critical-text)]",
  },
  "p1-high": {
    get label() {
      return getPriorityLabel("p1-high");
    },
    shortLabel: "P1",
    className: "bg-[var(--priority-high-bg)] text-[var(--priority-high-text)]",
  },
  "p2-medium": {
    get label() {
      return getPriorityLabel("p2-medium");
    },
    shortLabel: "P2",
    className: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-text)]",
  },
  "p3-low": {
    get label() {
      return getPriorityLabel("p3-low");
    },
    shortLabel: "P3",
    className: "bg-[var(--priority-low-bg)] text-[var(--priority-low-text)]",
  },
};

export function getPriorityLabel(priority: Priority, intl: IntlShape = getIntl()): string {
  return intl.formatMessage(PRIORITY_LABEL_MESSAGES[priority]);
}

export function getPriorityShortLabel(priority: Priority): string {
  return PRIORITY_PRESENTATION[priority].shortLabel;
}

export function getPriorityClassName(priority: Priority): string {
  return PRIORITY_PRESENTATION[priority].className;
}
