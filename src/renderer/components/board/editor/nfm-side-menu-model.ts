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
  | "table-header-column";

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

const REFERENCE_ACTIONS: readonly Omit<NfmSideMenuAction, "section" | "enabled">[] = [
  {
    key: "turn-into",
    label: "Turn into",
    kind: "submenu",
    visualGroup: "block-shape",
    submenu: "turn-into",
    keywords: ["convert", "type", "block"],
  },
  {
    key: "color",
    label: "Color",
    kind: "submenu",
    visualGroup: "block-shape",
    submenu: "color",
    keywords: ["colour", "background", "text"],
  },
  {
    key: "duplicate",
    label: "Duplicate",
    kind: "action",
    visualGroup: "block-move",
    shortcut: "⌘D",
    keywords: ["copy"],
  },
  {
    key: "send-to-thread",
    label: "Send to chat",
    kind: "submenu",
    submenu: "send-to-thread",
    visualGroup: "block-move",
    keywords: ["send", "chat", "thread", "agent"],
  },
  {
    key: "add-to-composer",
    label: "Add to composer",
    kind: "action",
    visualGroup: "block-move",
    keywords: ["chat", "draft", "prompt", "quote", "insert"],
  },
  {
    key: "move-to",
    label: "Move to",
    kind: "submenu",
    visualGroup: "block-move",
    submenu: "move-to",
    shortcut: "⌘⇧P",
    keywords: ["relocate", "page", "page", "database", "db", "nodex"],
  },
  {
    key: "delete",
    label: "Delete",
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

function resolveSingleBlockScopeTitle(block: NfmSideMenuTargetBlockDescriptor) {
  if (block.type === "paragraph") return "Text";
  if (block.type === "codeBlock") return "Code";
  if (block.type === "heading") {
    const level = toNumberProp(block.props, "level");
    const normalizedLevel = level === 1 || level === 2 || level === 3 ? level : 1;
    return toBooleanProp(block.props, "isToggleable")
      ? `Toggle heading ${normalizedLevel}`
      : `Heading ${normalizedLevel}`;
  }
  if (block.type === "bulletListItem") return "Bulleted list";
  if (block.type === "numberedListItem") return "Numbered list";
  if (block.type === "checkListItem") return "To-do list";
  if (block.type === "toggleListItem") return "Toggle list";
  if (block.type === "quote") return "Quote";
  if (block.type === "divider") return "Divider";
  if (block.type === "image") return "Image";
  if (block.type === "callout") return "Callout";
  if (block.type === "prompt") return "Prompt";
  if (block.type === "table") return "Table";
  if (block.type === "pageRef") return "Page reference";
  return "Block";
}

export function resolveNfmSideMenuScopeTitle(blocks: readonly NfmSideMenuTargetBlockDescriptor[]) {
  if (blocks.length === 0) return "Block";
  if (blocks.length > 1) return `${blocks.length} blocks`;
  return resolveSingleBlockScopeTitle(blocks[0]!);
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

export function buildNfmSideMenuSections(input: NfmSideMenuModelInput): NfmSideMenuSection[] {
  const codeRows: NfmSideMenuAction[] =
    input.currentBlockId &&
    input.currentBlockType === "codeBlock" &&
    input.selectedTopLevelBlockCount === 1 &&
    input.codeBlock
      ? [
          {
            key: "copy-code",
            label: "Copy code",
            kind: "action",
            section: "selection",
            visualGroup: "code",
            enabled: true,
            keywords: ["clipboard"],
          },
          {
            key: "wrap-code",
            label: "Wrap code",
            kind: "action",
            section: "selection",
            visualGroup: "code",
            enabled: true,
            checked: input.codeBlock.wrapped,
            keywords: ["word wrap", "lines"],
          },
          {
            key: "code-language",
            label: "Language",
            kind: "submenu",
            section: "selection",
            visualGroup: "code",
            enabled: input.isEditable,
            submenu: "language",
            keywords: ["syntax", "highlighting"],
          },
          ...(input.codeBlock.canFormat
            ? ([
                {
                  key: "format-code",
                  label: "Format code",
                  kind: "action",
                  section: "selection",
                  visualGroup: "code",
                  enabled: input.isEditable,
                  keywords: ["prettier", "beautify"],
                },
              ] satisfies NfmSideMenuAction[])
            : []),
          ...(input.codeBlock.isMermaid
            ? ([
                {
                  key: "expand-diagram",
                  label: "Expand diagram",
                  kind: "action",
                  section: "selection",
                  visualGroup: "code",
                  enabled: input.codeBlock.hasValidDiagram,
                  keywords: ["fullscreen", "preview"],
                },
                {
                  key: "download-diagram",
                  label: "Download diagram as JPEG",
                  kind: "action",
                  section: "selection",
                  visualGroup: "code",
                  enabled: input.codeBlock.hasValidDiagram,
                  keywords: ["export", "image", "jpeg"],
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
        section: "selection" as const,
        enabled: enabledForReferenceAction(action, input),
        ...(action.key === "send-to-thread" ? { shortcut: input.sendToChatShortcut } : {}),
        ...(action.key === "add-to-composer" ? { shortcut: input.addToComposerShortcut } : {}),
        ...(contextualSend ? { submenuIsSecondary: true } : {}),
      },
    ];
  });

  const tableRows: NfmSideMenuAction[] =
    input.currentBlockId &&
    input.isTableBlock &&
    input.canUseTableHeaders &&
    input.selectedTopLevelBlockCount === 1
      ? [
          {
            key: "table-header-row",
            label: "Header row",
            kind: "action",
            section: "table",
            visualGroup: "table",
            enabled: input.isEditable,
            keywords: ["table"],
          },
          {
            key: "table-header-column",
            label: "Header column",
            kind: "action",
            section: "table",
            visualGroup: "table",
            enabled: input.isEditable,
            keywords: ["table"],
          },
        ]
      : [];

  const sections: NfmSideMenuSection[] = [
    { key: "selection", label: input.selectionTitle, rows: [...codeRows, ...referenceRows] },
    { key: "table", label: "Table", rows: tableRows },
  ];

  return sections.filter((section) => section.rows.length > 0);
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
