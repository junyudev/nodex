import { getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
export type NfmSideMenuActionKind = "action" | "submenu";
export type NfmSideMenuVisualGroup = "code" | "block-shape" | "block-move" | "table";

export type NfmSideMenuActionKey =
  | "copy-code"
  | "wrap-code"
  | "code-language"
  | "format-code"
  | "expand-diagram"
  | "download-diagram"
  | "turn-into"
  | "color"
  | "duplicate"
  | "send-to-thread"
  | "add-to-composer"
  | "move-to"
  | "delete"
  | "table-header-row"
  | "table-header-column"
  | "table-fit-page-width"
  | "table-fit-content";

export type NfmSideMenuSubmenuKey =
  | "language"
  | "turn-into"
  | "color"
  | "move-to"
  | "send-to-thread";

export interface NfmSideMenuAction {
  key: NfmSideMenuActionKey;
  label: string;
  kind: NfmSideMenuActionKind;
  section: "selection" | "nodex" | "table";
  visualGroup: NfmSideMenuVisualGroup;
  enabled: boolean;
  shortcut?: string;
  submenu?: NfmSideMenuSubmenuKey;
  /** Activating the row runs its own action; its submenu offers the alternatives on hover. */
  submenuIsSecondary?: boolean;
  checked?: boolean;
  keywords?: readonly string[];
}

export interface NfmSideMenuSection {
  key: "selection" | "nodex" | "table";
  label: string;
  rows: NfmSideMenuAction[];
}

export interface NfmSideMenuTargetBlockDescriptor {
  id: string | null;
  type: string | null;
  props?: Record<string, unknown>;
}

export interface NfmSideMenuModelInput {
  currentBlockId: string | null;
  currentBlockType: string | null;
  selectionTitle: string;
  selectedTopLevelBlockCount: number;
  isEditable: boolean;
  canUseColor: boolean;
  canSendBlocks: boolean;
  canSendToThread?: boolean;
  /** The Page is shown beside a chat, so Send needs no picker. */
  hasContextualSendTarget?: boolean;
  canAddToComposer?: boolean;
  sendToChatShortcut?: string;
  addToComposerShortcut?: string;
  isTableBlock: boolean;
  canUseTableHeaders: boolean;
  hasPinnedTableColumns?: boolean;
  codeBlock?: {
    wrapped: boolean;
    canFormat: boolean;
    isMermaid: boolean;
    hasValidDiagram: boolean;
  };
}

export interface NfmSideMenuFlatRow {
  sectionKey: NfmSideMenuSection["key"];
  row: NfmSideMenuAction;
}

const REFERENCE_ACTIONS: readonly (Omit<NfmSideMenuAction, "section" | "enabled" | "label"> & {
  label: MessageDescriptor;
})[] = [
  {
    key: "turn-into",
    label: {
      id: "editor.nfmSideMenuModel.turnInto",
      defaultMessage: "Turn into",
      description: "Convert the block to another type",
    },
    kind: "submenu",
    visualGroup: "block-shape",
    submenu: "turn-into",
    keywords: ["convert", "type", "block"],
  },
  {
    key: "color",
    label: { id: "editor.nfmSideMenuModel.color", defaultMessage: "Color" },
    kind: "submenu",
    visualGroup: "block-shape",
    submenu: "color",
    keywords: ["colour", "background", "text"],
  },
  {
    key: "duplicate",
    label: { id: "editor.nfmSideMenuModel.duplicate", defaultMessage: "Duplicate" },
    kind: "action",
    visualGroup: "block-move",
    shortcut: "⌘D",
    keywords: ["copy"],
  },
  {
    key: "send-to-thread",
    label: { id: "editor.nfmSideMenuModel.sendToChat", defaultMessage: "Send to chat" },
    kind: "submenu",
    submenu: "send-to-thread",
    visualGroup: "block-move",
    keywords: ["send", "chat", "thread", "agent"],
  },
  {
    key: "add-to-composer",
    label: { id: "editor.nfmSideMenuModel.addToComposer", defaultMessage: "Add to composer" },
    kind: "action",
    visualGroup: "block-move",
    keywords: ["chat", "draft", "prompt", "quote", "insert"],
  },
  {
    key: "move-to",
    label: { id: "editor.nfmSideMenuModel.moveTo", defaultMessage: "Move to" },
    kind: "submenu",
    visualGroup: "block-move",
    submenu: "move-to",
    shortcut: "⌘⇧P",
    keywords: ["relocate", "page", "page", "database", "db", "nodex"],
  },
  {
    key: "delete",
    label: { id: "editor.nfmSideMenuModel.delete", defaultMessage: "Delete" },
    kind: "action",
    visualGroup: "block-move",
    shortcut: "Del",
    keywords: ["remove", "trash"],
  },
] as const;

function toNumberProp(props: Record<string, unknown> | undefined, key: string) {
  const value = props?.[key];
  return typeof value === "number" ? value : null;
}

function toBooleanProp(props: Record<string, unknown> | undefined, key: string) {
  const value = props?.[key];
  return typeof value === "boolean" ? value : false;
}

function resolveSingleBlockScopeTitle(block: NfmSideMenuTargetBlockDescriptor, intl: IntlShape) {
  if (block.type === "paragraph")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.text", defaultMessage: "Text" });
  if (block.type === "codeBlock")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.code", defaultMessage: "Code" });
  if (block.type === "heading") {
    const level = toNumberProp(block.props, "level");
    const normalizedLevel = level === 1 || level === 2 || level === 3 ? level : 1;
    return toBooleanProp(block.props, "isToggleable")
      ? intl.formatMessage(
          { id: "editor.nfmSideMenuModel.toggleHeading", defaultMessage: "Toggle heading {level}" },
          { level: normalizedLevel },
        )
      : intl.formatMessage(
          { id: "editor.nfmSideMenuModel.heading", defaultMessage: "Heading {level}" },
          { level: normalizedLevel },
        );
  }
  if (block.type === "bulletListItem")
    return intl.formatMessage({
      id: "editor.nfmSideMenuModel.bulletedList",
      defaultMessage: "Bulleted list",
    });
  if (block.type === "numberedListItem")
    return intl.formatMessage({
      id: "editor.nfmSideMenuModel.numberedList",
      defaultMessage: "Numbered list",
    });
  if (block.type === "checkListItem")
    return intl.formatMessage({
      id: "editor.nfmSideMenuModel.todoList",
      defaultMessage: "To-do list",
    });
  if (block.type === "toggleListItem")
    return intl.formatMessage({
      id: "editor.nfmSideMenuModel.toggleList",
      defaultMessage: "Toggle list",
    });
  if (block.type === "quote")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.quote", defaultMessage: "Quote" });
  if (block.type === "divider")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.divider", defaultMessage: "Divider" });
  if (block.type === "image")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.image", defaultMessage: "Image" });
  if (block.type === "callout")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.callout", defaultMessage: "Callout" });
  if (block.type === "prompt")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.prompt", defaultMessage: "Prompt" });
  if (block.type === "table")
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.table", defaultMessage: "Table" });
  if (block.type === "pageRef")
    return intl.formatMessage({
      id: "editor.nfmSideMenuModel.pageReference",
      defaultMessage: "Page reference",
    });
  return intl.formatMessage({ id: "editor.nfmSideMenuModel.block", defaultMessage: "Block" });
}

export function resolveNfmSideMenuScopeTitle(
  blocks: readonly NfmSideMenuTargetBlockDescriptor[],
  intl = getIntl(),
) {
  if (blocks.length === 0)
    return intl.formatMessage({ id: "editor.nfmSideMenuModel.block", defaultMessage: "Block" });
  if (blocks.length > 1)
    return intl.formatMessage(
      { id: "editor.nfmSideMenuModel.blocks", defaultMessage: "{count} blocks" },
      { count: blocks.length },
    );
  return resolveSingleBlockScopeTitle(blocks[0]!, intl);
}

function enabledForReferenceAction(
  action: Pick<NfmSideMenuAction, "key">,
  input: NfmSideMenuModelInput,
) {
  if (!input.currentBlockId) return false;
  if (!input.isEditable) return false;

  if (action.key === "turn-into") return true;
  if (action.key === "color") return input.canUseColor;
  if (action.key === "duplicate") return true;
  if (action.key === "send-to-thread") return Boolean(input.canSendToThread);
  if (action.key === "add-to-composer") return Boolean(input.canAddToComposer);
  if (action.key === "move-to") return input.canSendBlocks;
  if (action.key === "delete") return true;

  return false;
}

function localizeAction(
  intl: IntlShape,
  label: MessageDescriptor,
  keywords: readonly string[] = [],
) {
  const text = intl.formatMessage(label);
  return {
    label: text,
    keywords:
      typeof label.defaultMessage === "string" && text !== label.defaultMessage
        ? [...keywords, label.defaultMessage]
        : keywords,
  };
}

export function buildNfmSideMenuSections(
  input: NfmSideMenuModelInput,
  intl = getIntl(),
): NfmSideMenuSection[] {
  const codeRows: NfmSideMenuAction[] =
    input.currentBlockId &&
    input.currentBlockType === "codeBlock" &&
    input.selectedTopLevelBlockCount === 1 &&
    input.codeBlock
      ? [
          {
            key: "copy-code",
            ...localizeAction(
              intl,
              { id: "editor.nfmSideMenuModel.copyCode", defaultMessage: "Copy code" },
              ["clipboard"],
            ),
            kind: "action",
            section: "selection",
            visualGroup: "code",
            enabled: true,
          },
          {
            key: "wrap-code",
            ...localizeAction(
              intl,
              { id: "editor.nfmSideMenuModel.wrapCode", defaultMessage: "Wrap code" },
              ["word wrap", "lines"],
            ),
            kind: "action",
            section: "selection",
            visualGroup: "code",
            enabled: true,
            checked: input.codeBlock.wrapped,
          },
          {
            key: "code-language",
            ...localizeAction(
              intl,
              { id: "editor.nfmSideMenuModel.language", defaultMessage: "Language" },
              ["syntax", "highlighting"],
            ),
            kind: "submenu",
            section: "selection",
            visualGroup: "code",
            enabled: input.isEditable,
            submenu: "language",
          },
          ...(input.codeBlock.canFormat
            ? ([
                {
                  key: "format-code",
                  ...localizeAction(
                    intl,
                    { id: "editor.nfmSideMenuModel.formatCode", defaultMessage: "Format code" },
                    ["prettier", "beautify"],
                  ),
                  kind: "action",
                  section: "selection",
                  visualGroup: "code",
                  enabled: input.isEditable,
                },
              ] satisfies NfmSideMenuAction[])
            : []),
          ...(input.codeBlock.isMermaid
            ? ([
                {
                  key: "expand-diagram",
                  ...localizeAction(
                    intl,
                    {
                      id: "editor.nfmSideMenuModel.expandDiagram",
                      defaultMessage: "Expand diagram",
                    },
                    ["fullscreen", "preview"],
                  ),
                  kind: "action",
                  section: "selection",
                  visualGroup: "code",
                  enabled: input.codeBlock.hasValidDiagram,
                },
                {
                  key: "download-diagram",
                  ...localizeAction(
                    intl,
                    {
                      id: "editor.nfmSideMenuModel.downloadDiagram",
                      defaultMessage: "Download diagram as JPEG",
                    },
                    ["export", "image", "jpeg"],
                  ),
                  kind: "action",
                  section: "selection",
                  visualGroup: "code",
                  enabled: input.codeBlock.hasValidDiagram,
                },
              ] satisfies NfmSideMenuAction[])
            : []),
        ]
      : [];
  const referenceRows = REFERENCE_ACTIONS.flatMap((action) => {
    if (action.key === "send-to-thread" && (!input.currentBlockId || !input.canSendToThread))
      return [];
    if (action.key === "add-to-composer" && (!input.currentBlockId || !input.canAddToComposer))
      return [];

    const contextualSend = action.key === "send-to-thread" && input.hasContextualSendTarget;
    return [
      {
        ...action,
        ...localizeAction(intl, action.label, action.keywords),
        section: "selection" as const,
        enabled: enabledForReferenceAction(action, input),
        ...(action.key === "send-to-thread" ? { shortcut: input.sendToChatShortcut } : {}),
        ...(action.key === "add-to-composer" ? { shortcut: input.addToComposerShortcut } : {}),
        ...(contextualSend ? { submenuIsSecondary: true } : {}),
      },
    ];
  });

  const tableRows = buildTableRows(input, intl);

  const sections: NfmSideMenuSection[] = [
    { key: "selection", label: input.selectionTitle, rows: [...codeRows, ...referenceRows] },
    {
      key: "table",
      label: intl.formatMessage({ id: "editor.nfmSideMenuModel.table", defaultMessage: "Table" }),
      rows: tableRows,
    },
  ];

  return sections.filter((section) => section.rows.length > 0);
}

function buildTableRows(input: NfmSideMenuModelInput, intl: IntlShape): NfmSideMenuAction[] {
  if (!input.currentBlockId || !input.isTableBlock || input.selectedTopLevelBlockCount !== 1) {
    return [];
  }

  const row = (
    key: NfmSideMenuActionKey,
    label: MessageDescriptor,
    enabled = input.isEditable,
    keywords: string[] = ["table"],
  ): NfmSideMenuAction => ({
    key,
    ...localizeAction(intl, label, keywords),
    kind: "action",
    section: "table",
    visualGroup: "table",
    enabled,
  });

  return [
    ...(input.canUseTableHeaders
      ? [
          row("table-header-row", {
            id: "editor.nfmSideMenuModel.headerRow",
            defaultMessage: "Header row",
          }),
          row("table-header-column", {
            id: "editor.nfmSideMenuModel.headerColumn",
            defaultMessage: "Header column",
          }),
        ]
      : []),
    row(
      "table-fit-page-width",
      {
        id: "editor.nfmSideMenuModel.fitPageWidth",
        defaultMessage: "Fit to page width",
      },
      input.isEditable,
      ["table", "column", "width"],
    ),
    row(
      "table-fit-content",
      {
        id: "editor.nfmSideMenuModel.fitColumnsToContent",
        defaultMessage: "Fit columns to content",
      },
      input.isEditable && input.hasPinnedTableColumns === true,
      ["table", "column", "width"],
    ),
  ];
}

function normalizeQueryPart(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function rowMatchesQuery(row: NfmSideMenuAction, query: string) {
  const normalizedQuery = normalizeQueryPart(query);
  if (!normalizedQuery) return true;

  const haystack = normalizeQueryPart(
    [row.label, row.shortcut ?? "", ...(row.keywords ?? [])].join(" "),
  );

  return haystack.includes(normalizedQuery);
}

export function filterNfmSideMenuSections(
  sections: readonly NfmSideMenuSection[],
  query: string,
): NfmSideMenuSection[] {
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => rowMatchesQuery(row, query)),
    }))
    .filter((section) => section.rows.length > 0);
}

export function flattenNfmSideMenuRows(
  sections: readonly NfmSideMenuSection[],
): NfmSideMenuFlatRow[] {
  return sections.flatMap((section) =>
    section.rows.map((row) => ({
      sectionKey: section.key,
      row,
    })),
  );
}

export function shouldRenderNfmSideMenuSeparatorBefore(
  previousRow: NfmSideMenuFlatRow | undefined,
  currentRow: NfmSideMenuFlatRow,
) {
  return Boolean(previousRow && previousRow.row.visualGroup !== currentRow.row.visualGroup);
}

export function getNfmSideMenuSeparatorBeforeKeys(
  rows: readonly NfmSideMenuFlatRow[],
): NfmSideMenuActionKey[] {
  return rows
    .filter((row, index) => shouldRenderNfmSideMenuSeparatorBefore(rows[index - 1], row))
    .map(({ row }) => row.key);
}

export function getInitialNfmSideMenuFocusIndex(
  query: string,
  rows: readonly NfmSideMenuFlatRow[],
) {
  if (!normalizeQueryPart(query)) return -1;
  return rows.length > 0 ? 0 : -1;
}

export function moveNfmSideMenuFocus(
  currentIndex: number,
  direction: 1 | -1,
  rows: readonly NfmSideMenuFlatRow[],
) {
  if (rows.length === 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : rows.length - 1;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0) return rows.length - 1;
  if (nextIndex >= rows.length) return 0;
  return nextIndex;
}
