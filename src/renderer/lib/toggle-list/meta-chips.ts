import type { Estimate, Priority } from "../../../shared/types";
import {
  getStatusAccentColorByLabel,
  getStatusChipClassName,
  getStatusIdByLabel,
} from "../status-chip";
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

  const statusId = getStatusIdByLabel(token);
  if (statusId) return getStatusChipClassName(statusId);

  return `${CHIP_BASE} bg-[var(--gray-bg)] text-[var(--foreground-secondary)]`;
}

/** Returns a CSS color value for the status icon, or undefined if not a status token. */
export function getStatusDotColor(token: string): string | undefined {
  return getStatusAccentColorByLabel(token);
}

export function classifyMetaToken(token: string): MetaChipPropertyType {
  if (PRIORITY_CHIP_CLASS_BY_TOKEN[token]) return "priority";
  if (ESTIMATE_CHIP_CLASS_BY_TOKEN[token.toUpperCase()]) return "estimate";
  if (getStatusIdByLabel(token)) return "status";
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

export function tokenToPriorityValue(token: string): Priority | undefined {
  return TOKEN_TO_PRIORITY[token];
}

export function tokenToEstimateValue(token: string): Estimate | undefined {
  return TOKEN_TO_ESTIMATE[token.toUpperCase()];
}

export function tokenToStatusId(token: string): ToggleListStatusId | undefined {
  return getStatusIdByLabel(token);
}
