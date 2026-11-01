import type { Estimate, Priority } from "../../../shared/types";
import { PRIORITY_VALUES } from "../../../shared/priority";
import {
  getPriorityClassName,
  getPriorityShortLabel,
  priorityFromShortLabel,
} from "../priority-presentation";
import { isWorkflowStatus } from "../../../shared/workflow-status";
import type { ToggleListStatusId } from "./types";

export type MetaChipPropertyType = "priority" | "estimate" | "status" | "tag";
export const EMPTY_DISPLAY_VALUE_TOKEN = "-";

const META_TOKEN_REGEX = /\[([^\]]+)\]/g;

const CHIP_BASE =
  "inline-flex items-center h-5 px-1.5 rounded-sm text-sm leading-5 font-normal whitespace-nowrap";
const STATUS_LABEL_BASE =
  "inline-flex h-5 items-center gap-1.5 text-sm leading-5 font-normal whitespace-nowrap text-[var(--foreground-secondary)]";

const PRIORITY_CHIP_CLASS_BY_TOKEN: Record<string, string> = Object.fromEntries(
  PRIORITY_VALUES.map((priority) => [
    getPriorityShortLabel(priority),
    `${CHIP_BASE} ${getPriorityClassName(priority)}`,
  ]),
);

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

  const statusId = isWorkflowStatus(token);
  if (statusId) return STATUS_LABEL_BASE;

  return `${CHIP_BASE} bg-[var(--gray-bg)] text-[var(--foreground-secondary)]`;
}

export function classifyMetaToken(token: string): MetaChipPropertyType {
  if (PRIORITY_CHIP_CLASS_BY_TOKEN[token]) return "priority";
  if (ESTIMATE_CHIP_CLASS_BY_TOKEN[token.toUpperCase()]) return "estimate";
  if (isWorkflowStatus(token)) return "status";
  return "tag";
}

const TOKEN_TO_ESTIMATE: Record<string, Estimate> = {
  XS: "xs",
  S: "s",
  M: "m",
  L: "l",
  XL: "xl",
};

export function tokenToPriorityValue(token: string): Priority | undefined {
  return priorityFromShortLabel(token);
}

export function tokenToEstimateValue(token: string): Estimate | undefined {
  return TOKEN_TO_ESTIMATE[token.toUpperCase()];
}

export function tokenToStatusId(token: string): ToggleListStatusId | undefined {
  return isWorkflowStatus(token) ? token : undefined;
}
