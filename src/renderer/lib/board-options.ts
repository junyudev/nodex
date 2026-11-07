import { PRIORITY_VALUES, type Priority } from "../../shared/priority";
import {
  getPriorityClassName,
  getPriorityLabel,
  getPriorityShortLabel,
} from "./priority-presentation";

export const ARCHIVED_CARD_OPTION_ID = "archived";

export type BoardPriorityOption = {
  value: Priority;
  label: string;
  shortLabel: string;
  className: string;
};

export const BOARD_PRIORITY_OPTIONS: BoardPriorityOption[] = PRIORITY_VALUES.map((value) => ({
  value,
  label: getPriorityLabel(value),
  shortLabel: getPriorityShortLabel(value),
  className: getPriorityClassName(value),
}));

export const BOARD_PRIORITY_OPTIONS_BY_VALUE = BOARD_PRIORITY_OPTIONS.reduce<
  Record<Priority, BoardPriorityOption>
>(
  (result, option) => {
    result[option.value] = option;
    return result;
  },
  {} as Record<Priority, BoardPriorityOption>,
);

export function resolveBoardPriorityOption(
  priority: Priority | null | undefined,
): BoardPriorityOption | null {
  if (!priority) return null;
  return BOARD_PRIORITY_OPTIONS_BY_VALUE[priority] ?? null;
}
