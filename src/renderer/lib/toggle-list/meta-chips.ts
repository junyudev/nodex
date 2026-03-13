import type { Estimate, Priority } from "../../../shared/types";
import type { ToggleListStatusId } from "./types";

export type MetaChipPropertyType = "priority" | "estimate" | "status" | "tag";
export const EMPTY_DISPLAY_VALUE_TOKEN = "-";

const META_TOKEN_REGEX = /\[([^\]]+)\]/g;

const CHIP_BASE = "inline-flex items-center h-5 px-1.5 rounded-sm text-sm leading-5 font-normal whitespace-nowrap";

const PRIORITY_CHIP_CLASS_BY_TOKEN: Record<string, string> = {
  P0: `${CHIP_BASE} bg-[var(--priority-critical-bg)] text-[var(--priority-critical-text)]`,
  P1: `${CHIP_BASE} bg-[var(--priority-high-bg)] text-[var(--priority-high-text)]`,
  P2: `${CHIP_BASE} bg-[var(--priority-medium-bg)] text-[var(--priority-medium-text)]`,
  P3: `${CHIP_BASE} bg-[var(--priority-low-bg)] text-[var(--priority-low-text)]`,
  P4: `${CHIP_BASE} bg-[var(--priority-later-bg)] text-[var(--priority-later-text)]`,
};

const ESTIMATE_CHIP_CLASS_BY_TOKEN: Record<string, string> = {
  XS: `${CHIP_BASE} bg-[var(--blue-bg)] text-[var(--blue-text)]`,
  S: `${CHIP_BASE} bg-[var(--green-bg)] text-[var(--green-text)]`,
  M: `${CHIP_BASE} bg-[var(--yellow-bg)] text-[var(--yellow-text)]`,
  L: `${CHIP_BASE} bg-[var(--orange-bg)] text-[var(--orange-text)]`,
  XL: `${CHIP_BASE} bg-[var(--red-bg)] text-[var(--red-text)]`,
  [EMPTY_DISPLAY_VALUE_TOKEN]: `${CHIP_BASE} bg-[var(--gray-bg)] text-[var(--foreground-tertiary)]`,
};

/** Status chips get a dot element prepended in card-toggle-block.tsx — no ::before needed. */
const STATUS_CHIP_CLASS_BY_LABEL: Record<string, string> = {
  Draft: `${CHIP_BASE} rounded-lg px-2 pl-[calc(var(--spacing)*1.75)] gap-[calc(var(--spacing)*1.25)] bg-[var(--status-ideas-bg)] text-[var(--status-ideas-text)]`,
  Backlog: `${CHIP_BASE} rounded-lg px-2 pl-[calc(var(--spacing)*1.75)] gap-[calc(var(--spacing)*1.25)] bg-[var(--status-backlog-bg)] text-[var(--status-backlog-text)]`,
  "In Progress": `${CHIP_BASE} rounded-lg px-2 pl-[calc(var(--spacing)*1.75)] gap-[calc(var(--spacing)*1.25)] bg-[var(--status-in-progress-bg)] text-[var(--status-in-progress-text)]`,
  "In Review": `${CHIP_BASE} rounded-lg px-2 pl-[calc(var(--spacing)*1.75)] gap-[calc(var(--spacing)*1.25)] bg-[var(--status-review-bg)] text-[var(--status-review-text)]`,
  Done: `${CHIP_BASE} rounded-lg px-2 pl-[calc(var(--spacing)*1.75)] gap-[calc(var(--spacing)*1.25)] bg-[var(--status-done-bg)] text-[var(--status-done-text)]`,
};

/** CSS variable name for the status dot color, keyed by label. */
const STATUS_DOT_VAR_BY_LABEL: Record<string, string> = {
  Draft: "var(--status-ideas-dot)",
  Backlog: "var(--status-backlog-dot)",
  "In Progress": "var(--status-in-progress-dot)",
  "In Review": "var(--status-review-dot)",
  Done: "var(--status-done-dot)",
};

export function parseMetaTokens(meta: string): string[] {
  const tokens: string[] = [];
  for (const match of meta.matchAll(META_TOKEN_REGEX)) {
    const value = match[1]?.trim();
    if (value) {
      tokens.push(value);
    }
  }
  return tokens;
}

export function getMetaChipClassName(token: string): string {
  const priorityClass = PRIORITY_CHIP_CLASS_BY_TOKEN[token];
  if (priorityClass) return priorityClass;

  const estimateClass = ESTIMATE_CHIP_CLASS_BY_TOKEN[token.toUpperCase()];
  if (estimateClass) return estimateClass;

  const statusClass = STATUS_CHIP_CLASS_BY_LABEL[token];
  if (statusClass) return statusClass;

  return `${CHIP_BASE} bg-[var(--gray-bg)] text-[var(--foreground-secondary)]`;
}

/** Returns a CSS color value for the status dot, or undefined if not a status token. */
export function getStatusDotColor(token: string): string | undefined {
  return STATUS_DOT_VAR_BY_LABEL[token];
}

export function classifyMetaToken(token: string): MetaChipPropertyType {
  if (PRIORITY_CHIP_CLASS_BY_TOKEN[token]) return "priority";
  if (ESTIMATE_CHIP_CLASS_BY_TOKEN[token.toUpperCase()]) return "estimate";
  if (STATUS_CHIP_CLASS_BY_LABEL[token]) return "status";
  return "tag";
}

const TOKEN_TO_PRIORITY: Record<string, Priority> = {
  P0: "p0-critical",
  P1: "p1-high",
  P2: "p2-medium",
  P3: "p3-low",
  P4: "p4-later",
};

const TOKEN_TO_ESTIMATE: Record<string, Estimate> = {
  XS: "xs",
  S: "s",
  M: "m",
  L: "l",
  XL: "xl",
};

const LABEL_TO_STATUS_ID: Record<string, ToggleListStatusId> = {
  Draft: "draft",
  Backlog: "backlog",
  "In Progress": "in_progress",
  "In Review": "in_review",
  Done: "done",
};

export function tokenToPriorityValue(token: string): Priority | undefined {
  return TOKEN_TO_PRIORITY[token];
}

export function tokenToEstimateValue(token: string): Estimate | undefined {
  return TOKEN_TO_ESTIMATE[token.toUpperCase()];
}

export function tokenToStatusId(token: string): ToggleListStatusId | undefined {
  return LABEL_TO_STATUS_ID[token];
}
