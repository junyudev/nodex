import { getIntl, type IntlShape } from "@/lib/i18n";

export type DatabaseListMoveDirection = "top" | "up" | "down" | "bottom";

export type DatabaseListCommandId = `move-${DatabaseListMoveDirection}`;

export interface DatabaseListCommand {
  readonly id: DatabaseListCommandId;
  readonly label: string;
  readonly disabled: boolean;
}

interface DatabaseListMoveCommandCapabilities {
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export const buildDatabaseListSelectionCommands = (
  { canMoveUp, canMoveDown }: DatabaseListMoveCommandCapabilities,
  intl: IntlShape = getIntl(),
): readonly DatabaseListCommand[] => [
  {
    id: "move-top",
    label: intl.formatMessage({
      id: "database.databaseListCommands.moveToTop",
      defaultMessage: "Move to top",
    }),
    disabled: !canMoveUp,
  },
  {
    id: "move-up",
    label: intl.formatMessage({
      id: "database.databaseListCommands.moveUp",
      defaultMessage: "Move up",
    }),
    disabled: !canMoveUp,
  },
  {
    id: "move-down",
    label: intl.formatMessage({
      id: "database.databaseListCommands.moveDown",
      defaultMessage: "Move down",
    }),
    disabled: !canMoveDown,
  },
  {
    id: "move-bottom",
    label: intl.formatMessage({
      id: "database.databaseListCommands.moveToBottom",
      defaultMessage: "Move to bottom",
    }),
    disabled: !canMoveDown,
  },
];

export function databaseListMoveDirection(
  commandId: DatabaseListCommandId,
): DatabaseListMoveDirection | null {
  const direction = commandId.slice("move-".length);
  if (direction === "top" || direction === "up" || direction === "down" || direction === "bottom")
    return direction;
  return null;
}
