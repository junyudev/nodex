export type DatabaseViewPageReorderDirection = "top" | "up" | "down" | "bottom";

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

export function buildDatabaseViewPageMenuEntries({
  hasPageKey,
  canMoveUp,
  canMoveDown,
  showReorder,
  canCopyMarkdown,
  canOpenInNewChat,
  canSendToChat,
  canDelete,
}: DatabaseViewPageMenuCapabilities): readonly DatabaseViewPageMenuEntry[] {
  const copyChildren = [
    ...(hasPageKey ? [entry("copy-id", "Copy ID", ["page", "key", "identifier"])] : []),
    entry("copy-deeplink", "Copy deeplink", ["link", "url", "reference"]),
    entry("copy-title", "Copy title", ["name", "heading"]),
    entry("copy-markdown", "Copy content as Markdown", ["body", "document", "nfm", "text"], {
      disabled: !canCopyMarkdown,
    }),
  ];

  return [
    entry("open-in", "Open in", ["session", "chat"], {
      children: [
        entry("open-in-new-chat", "Open in new chat", ["session", "thread"], {
          disabled: !canOpenInNewChat,
        }),
        entry("send-to-chat", "Send to chat…", ["thread", "agent", "attach"], {
          disabled: !canSendToChat,
        }),
      ],
    }),
    entry("copy", "Copy", ["clipboard"], { children: copyChildren }),
    entry("move-to", "Move to", [
      "relocate",
      "parent",
      "database",
      "page",
      "project",
      "destination",
    ]),
    ...(showReorder
      ? [
          entry("reorder", "Reorder", ["position", "rank", "order"], {
            children: [
              entry("reorder-top", "Reorder to top", ["first"], { disabled: !canMoveUp }),
              entry("reorder-up", "Reorder up", ["previous"], { disabled: !canMoveUp }),
              entry("reorder-down", "Reorder down", ["next"], { disabled: !canMoveDown }),
              entry("reorder-bottom", "Reorder to bottom", ["last"], {
                disabled: !canMoveDown,
              }),
            ],
          }),
        ]
      : []),
    entry("delete", "Delete", ["remove", "trash"], { disabled: !canDelete }),
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
