import { getIntl, type IntlShape } from "@/lib/i18n";
import { listPageCopyActions } from "@/lib/page-copy-model";
import {
  buildDatabaseListSelectionCommands,
  type DatabaseListCommandId,
  type DatabaseListMoveDirection,
} from "./database-list/database-list-commands";

export type DatabaseViewPageReorderDirection = DatabaseListMoveDirection;

const reorderActions = {
  "move-top": { id: "reorder-top", keyword: "first" },
  "move-up": { id: "reorder-up", keyword: "previous" },
  "move-down": { id: "reorder-down", keyword: "next" },
  "move-bottom": { id: "reorder-bottom", keyword: "last" },
} as const satisfies Record<
  DatabaseListCommandId,
  { id: `reorder-${DatabaseViewPageReorderDirection}`; keyword: string }
>;

export type DatabaseViewPageMenuActionId =
  | "move-to"
  | "reorder"
  | `reorder-${DatabaseViewPageReorderDirection}`
  | "copy"
  | "copy-id"
  | "copy-deeplink"
  | "copy-title"
  | "copy-markdown"
  | "open-in"
  | "open-in-new-chat"
  | "send-to-chat"
  | "delete";

export interface DatabaseViewPageMenuEntry {
  readonly id: DatabaseViewPageMenuActionId;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly disabled: boolean;
  readonly children?: readonly DatabaseViewPageMenuEntry[];
}

export interface DatabaseViewPageMenuCapabilities {
  readonly hasPageKey: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly showReorder: boolean;
  readonly canCopyMarkdown: boolean;
  readonly canOpenInNewChat: boolean;
  readonly canSendToChat: boolean;
  readonly canDelete: boolean;
}

const entry = (
  id: DatabaseViewPageMenuActionId,
  label: string,
  keywords: readonly string[],
  options: {
    readonly disabled?: boolean;
    readonly children?: readonly DatabaseViewPageMenuEntry[];
  } = {},
): DatabaseViewPageMenuEntry => ({
  id,
  label,
  keywords,
  disabled: options.disabled ?? false,
  ...(options.children ? { children: options.children } : {}),
});

export function buildDatabaseViewPageMenuEntries(
  {
    hasPageKey,
    canMoveUp,
    canMoveDown,
    showReorder,
    canCopyMarkdown,
    canOpenInNewChat,
    canSendToChat,
    canDelete,
  }: DatabaseViewPageMenuCapabilities,
  intl: IntlShape = getIntl(),
): readonly DatabaseViewPageMenuEntry[] {
  const copyChildren = listPageCopyActions({ hasPageKey, canCopyMarkdown }, intl).map((action) =>
    entry(action.id, action.label, action.keywords, { disabled: action.disabled }),
  );

  return [
    entry(
      "open-in",
      intl.formatMessage({
        id: "database.databaseViewPageMenuModel.openIn",
        defaultMessage: "Open in",
      }),
      ["session", "chat"],
      {
        children: [
          entry(
            "open-in-new-chat",
            intl.formatMessage({
              id: "database.databaseViewPageMenuModel.openInNewChat",
              defaultMessage: "Open in new chat",
            }),
            ["session", "thread"],
            {
              disabled: !canOpenInNewChat,
            },
          ),
          entry(
            "send-to-chat",
            intl.formatMessage({
              id: "database.databaseViewPageMenuModel.sendToChat",
              defaultMessage: "Send to chat",
            }),
            ["thread", "agent", "attach"],
            {
              disabled: !canSendToChat,
            },
          ),
        ],
      },
    ),
    entry(
      "copy",
      intl.formatMessage({ id: "database.databaseViewPageMenuModel.copy", defaultMessage: "Copy" }),
      ["clipboard"],
      { children: copyChildren },
    ),
    entry(
      "move-to",
      intl.formatMessage({
        id: "database.databaseViewPageMenuModel.moveTo",
        defaultMessage: "Move to",
      }),
      ["relocate", "parent", "database", "page", "project", "destination"],
    ),
    ...(showReorder
      ? [
          entry(
            "reorder",
            intl.formatMessage({
              id: "database.databaseViewPageMenuModel.reorder",
              defaultMessage: "Reorder",
            }),
            ["position", "rank", "order"],
            {
              children: buildDatabaseListSelectionCommands({ canMoveUp, canMoveDown }, intl).map(
                ({ id, label, disabled }) => {
                  const { id: actionId, keyword } = reorderActions[id];
                  return entry(actionId, label, [keyword], { disabled });
                },
              ),
            },
          ),
        ]
      : []),
    entry(
      "delete",
      intl.formatMessage({
        id: "database.databaseViewPageMenuModel.delete",
        defaultMessage: "Delete",
      }),
      ["remove", "trash"],
      { disabled: !canDelete },
    ),
  ];
}

const normalizedSearchValue = (value: string): string => value.trim().toLocaleLowerCase();

const matchesQuery = (item: DatabaseViewPageMenuEntry, query: string): boolean =>
  item.label.toLocaleLowerCase().includes(query) ||
  item.keywords.some((keyword) => keyword.toLocaleLowerCase().startsWith(query));

/** Keeps a submenu trigger whenever its label or at least one descendant matches. */
export function filterDatabaseViewPageMenuEntries(
  items: readonly DatabaseViewPageMenuEntry[],
  query: string,
): readonly DatabaseViewPageMenuEntry[] {
  const normalizedQuery = normalizedSearchValue(query);
  if (!normalizedQuery) return items;

  return items.flatMap((item) => {
    if (!item.children) return matchesQuery(item, normalizedQuery) ? [item] : [];
    if (matchesQuery(item, normalizedQuery)) return [item];
    const children = filterDatabaseViewPageMenuEntries(item.children, normalizedQuery);
    return children.length > 0 ? [{ ...item, children }] : [];
  });
}

export function databaseViewPageReorderDirection(
  actionId: DatabaseViewPageMenuActionId,
): DatabaseViewPageReorderDirection | null {
  if (!actionId.startsWith("reorder-")) return null;
  const direction = actionId.slice("reorder-".length);
  if (direction === "top" || direction === "up" || direction === "down" || direction === "bottom")
    return direction;
  return null;
}
