import {
  AddButton,
  DeleteButton,
  ExtendButton,
  SplitButton,
  TableCellButton,
  TableCellMenu,
  TableHandle,
  TableHandleMenu,
  TableHandlesController,
  TableHeaderColumnButton,
  TableHeaderRowButton,
  useBlockNoteEditor,
  useComponentsContext,
  useExtension,
  useExtensionState,
  type ExtendButtonProps,
  type TableCellButtonProps,
  type TableHandleMenuProps,
  type TableHandleProps,
} from "@blocknote/react";
import {
  isTableCell,
  mapTableCell,
  type DefaultBlockSchema,
  type DefaultInlineContentSchema,
  type DefaultStyleSchema,
} from "@blocknote/core";
import { TableHandlesExtension } from "@blocknote/core/extensions";
import { ArrowLeft, ArrowRight, CircleX, Scissors } from "@/components/shared/icons/generic-icons";
import type { ReactNode } from "react";
import {
  CheckmarkIcon,
  ChevronDownIcon,
  DragHandleDotsIcon,
  MoveDownIcon,
  MoveUpIcon,
  NfmSideMenuColorIcon,
  NfmSideMenuDeleteIcon,
  NfmSideMenuDuplicateIcon,
  NfmSideMenuTableHeaderIcon,
  PlusIcon,
} from "@/components/shared/icons";
import {
  clearNfmTableTarget,
  cloneNfmTableRows,
  duplicateNfmTableTarget,
  type NfmTableContent,
  type NfmTableRowOrColumnTarget,
  type NfmTableTarget,
} from "./nfm-table-operations";

type NfmTableColorValue =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

type NfmTableBlockSchema = {
  table: DefaultBlockSchema["table"];
};

const NFM_TABLE_COLOR_VALUES = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const satisfies readonly NfmTableColorValue[];

const NFM_TABLE_COLOR_LABELS = {
  default: "Default",
  gray: "Gray",
  brown: "Brown",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
} as const satisfies Record<NfmTableColorValue, string>;

const NFM_TABLE_TEXT_COLOR_STYLES = {
  default: "var(--color-token-foreground)",
  gray: "color-mix(in srgb, var(--color-token-foreground) 42%, transparent)",
  brown:
    "color-mix(in srgb, var(--color-token-charts-orange) 70%, var(--color-token-foreground) 18%)",
  orange: "var(--color-token-charts-orange)",
  yellow: "var(--color-token-charts-yellow)",
  green: "var(--color-token-charts-green)",
  blue: "var(--color-token-charts-blue)",
  purple: "var(--color-token-charts-purple)",
  pink: "color-mix(in srgb, var(--color-token-charts-purple) 56%, var(--color-token-charts-red) 44%)",
  red: "var(--color-token-charts-red)",
} as const satisfies Record<NfmTableColorValue, string>;

const NFM_TABLE_BACKGROUND_COLOR_STYLES = {
  default: "transparent",
  gray: "color-mix(in srgb, var(--color-token-foreground) 12%, transparent)",
  brown: "color-mix(in srgb, var(--color-token-charts-orange) 24%, transparent)",
  orange: "color-mix(in srgb, var(--color-token-charts-orange) 24%, transparent)",
  yellow: "color-mix(in srgb, var(--color-token-charts-yellow) 30%, transparent)",
  green: "color-mix(in srgb, var(--color-token-charts-green) 24%, transparent)",
  blue: "color-mix(in srgb, var(--color-token-charts-blue) 22%, transparent)",
  purple: "color-mix(in srgb, var(--color-token-charts-purple) 24%, transparent)",
  pink: "color-mix(in srgb, var(--color-token-charts-purple) 18%, var(--color-token-charts-red) 14%)",
  red: "color-mix(in srgb, var(--color-token-charts-red) 24%, transparent)",
} as const satisfies Record<NfmTableColorValue, string>;

function normalizeTableColorValue(value: unknown): NfmTableColorValue {
  return NFM_TABLE_COLOR_VALUES.includes(value as NfmTableColorValue)
    ? (value as NfmTableColorValue)
    : "default";
}

function NfmTableMenuRowContent({
  children,
  icon,
  rightSlot,
}: {
  children: ReactNode;
  icon: ReactNode;
  rightSlot?: ReactNode;
}) {
  return (
    <>
      <span className="bn-table-menu-item-icon">{icon}</span>
      <span className="bn-table-menu-item-label">{children}</span>
      {rightSlot ? <span className="bn-table-menu-item-right">{rightSlot}</span> : null}
    </>
  );
}

function NfmTableActionMenuItem({
  children,
  disabled = false,
  icon,
  onClick,
  shortcut,
}: {
  children: ReactNode;
  disabled?: boolean;
  icon: ReactNode;
  onClick?: () => void;
  shortcut?: string;
}) {
  const Components = useComponentsContext()!;

  return (
    <Components.Generic.Menu.Item disabled={disabled} onClick={onClick}>
      <NfmTableMenuRowContent
        icon={icon}
        rightSlot={shortcut ? <span>{shortcut}</span> : undefined}
      >
        {children}
      </NfmTableMenuRowContent>
    </Components.Generic.Menu.Item>
  );
}

function NfmTableColorDot({
  color,
  kind,
  selected,
}: {
  color: NfmTableColorValue;
  kind: "text" | "background";
  selected: boolean;
}) {
  const colorValue = NFM_TABLE_TEXT_COLOR_STYLES[color];
  const backgroundColor =
    kind === "background" ? NFM_TABLE_BACKGROUND_COLOR_STYLES[color] : "transparent";
  const foregroundColor = kind === "text" ? colorValue : "var(--color-token-foreground)";
  const borderColor = color === "default" ? "var(--color-token-border)" : colorValue;

  return (
    <span
      className="bn-table-color-dot"
      aria-hidden="true"
      data-nfm-table-color-kind={kind}
      data-nfm-table-color-selected={selected ? "true" : undefined}
      style={{
        backgroundColor,
        boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${borderColor}`,
        color: foregroundColor,
      }}
    >
      {kind === "text" ? "A" : null}
    </span>
  );
}

function NfmTableColorSection({
  currentColor,
  kind,
  label,
  onSelect,
}: {
  currentColor: string;
  kind: "text" | "background";
  label: string;
  onSelect: (color: NfmTableColorValue) => void;
}) {
  const Components = useComponentsContext()!;
  const normalizedCurrentColor = normalizeTableColorValue(currentColor);

  return (
    <>
      <Components.Generic.Menu.Label className="bn-table-color-picker-label">
        {label}
      </Components.Generic.Menu.Label>
      {NFM_TABLE_COLOR_VALUES.map((color) => (
        <Components.Generic.Menu.Item key={`${kind}-${color}`} onClick={() => onSelect(color)}>
          <NfmTableMenuRowContent
            icon={
              <NfmTableColorDot
                color={color}
                kind={kind}
                selected={normalizedCurrentColor === color}
              />
            }
            rightSlot={
              normalizedCurrentColor === color ? (
                <CheckmarkIcon className="size-4 shrink-0" />
              ) : undefined
            }
          >
            {NFM_TABLE_COLOR_LABELS[color]}
          </NfmTableMenuRowContent>
        </Components.Generic.Menu.Item>
      ))}
    </>
  );
}

function NfmTableColorSubmenu({
  background,
  text,
}: {
  background?: {
    color: string;
    setColor: (color: NfmTableColorValue) => void;
  };
  text?: {
    color: string;
    setColor: (color: NfmTableColorValue) => void;
  };
}) {
  const Components = useComponentsContext()!;

  if (!background && !text) return null;

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          <NfmTableMenuRowContent icon={<NfmSideMenuColorIcon />}>Color</NfmTableMenuRowContent>
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown
        sub
        className="bn-menu-dropdown bn-color-picker-dropdown bn-table-color-picker-dropdown"
      >
        {text ? (
          <NfmTableColorSection
            currentColor={text.color}
            kind="text"
            label="Text color"
            onSelect={text.setColor}
          />
        ) : null}
        {text && background ? <Components.Generic.Menu.Divider /> : null}
        {background ? (
          <NfmTableColorSection
            currentColor={background.color}
            kind="background"
            label="Background color"
            onSelect={background.setColor}
          />
        ) : null}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

function NfmTableHandleColorPickerButton(props: { orientation: "row" | "column" }) {
  const editor = useBlockNoteEditor<NfmTableBlockSchema>();
  const tableHandles = useExtension(TableHandlesExtension);
  const { block, index } = useExtensionState(TableHandlesExtension, {
    selector: (state) => ({
      block: state?.block,
      index: props.orientation === "column" ? state?.colIndex : state?.rowIndex,
    }),
  });

  const currentCells = (() => {
    if (!tableHandles || !block || index === undefined) return [];
    if (props.orientation === "row") {
      return tableHandles.getCellsAtRowHandle(block, index);
    }
    return tableHandles.getCellsAtColumnHandle(block, index);
  })();

  if (
    !tableHandles ||
    !currentCells[0] ||
    (editor.settings.tables.cellTextColor === false &&
      editor.settings.tables.cellBackgroundColor === false)
  ) {
    return null;
  }

  const updateColor = (color: NfmTableColorValue, type: "text" | "background") => {
    if (!block) return;

    const tableContent = block.content as NfmTableContent;
    const rows = cloneNfmTableRows(tableContent.rows);

    currentCells.forEach(({ row, col }) => {
      if (type === "text") {
        rows[row].cells[col].props.textColor = color;
        return;
      }
      rows[row].cells[col].props.backgroundColor = color;
    });

    editor.updateBlock(block, {
      type: "table",
      content: {
        ...tableContent,
        rows,
      },
    });
    editor.setTextCursorPosition(block);
  };

  const firstCell = mapTableCell<DefaultInlineContentSchema, DefaultStyleSchema>(
    currentCells[0].cell,
  );
  const hasSameTextColor = currentCells.every(
    ({ cell }) => isTableCell(cell) && cell.props.textColor === firstCell.props.textColor,
  );
  const hasSameBackgroundColor = currentCells.every(
    ({ cell }) =>
      isTableCell(cell) && cell.props.backgroundColor === firstCell.props.backgroundColor,
  );

  return (
    <NfmTableColorSubmenu
      text={
        editor.settings.tables.cellTextColor
          ? {
              color: hasSameTextColor ? firstCell.props.textColor : "default",
              setColor: (color) => updateColor(color, "text"),
            }
          : undefined
      }
      background={
        editor.settings.tables.cellBackgroundColor
          ? {
              color: hasSameBackgroundColor ? firstCell.props.backgroundColor : "default",
              setColor: (color) => updateColor(color, "background"),
            }
          : undefined
      }
    />
  );
}

function NfmTableCellColorPickerButton() {
  const editor = useBlockNoteEditor<NfmTableBlockSchema>();
  const { block, colIndex, rowIndex } = useExtensionState(TableHandlesExtension, {
    selector: (state) => ({
      block: state?.block,
      colIndex: state?.colIndex,
      rowIndex: state?.rowIndex,
    }),
  });

  if (!block || colIndex === undefined || rowIndex === undefined) return null;

  const tableContent = block.content as NfmTableContent;
  const currentCell = tableContent.rows[rowIndex]?.cells?.[colIndex];
  if (
    !currentCell ||
    (editor.settings.tables.cellTextColor === false &&
      editor.settings.tables.cellBackgroundColor === false)
  ) {
    return null;
  }

  const updateColor = (color: NfmTableColorValue, type: "text" | "background") => {
    const rows = cloneNfmTableRows(tableContent.rows);

    if (type === "text") {
      rows[rowIndex].cells[colIndex].props.textColor = color;
    } else {
      rows[rowIndex].cells[colIndex].props.backgroundColor = color;
    }

    editor.updateBlock(block, {
      type: "table",
      content: {
        ...tableContent,
        rows,
      },
    });
    editor.setTextCursorPosition(block);
  };

  const mappedCell = mapTableCell<DefaultInlineContentSchema, DefaultStyleSchema>(currentCell);

  return (
    <NfmTableColorSubmenu
      text={
        editor.settings.tables.cellTextColor
          ? {
              color: mappedCell.props.textColor,
              setColor: (color) => updateColor(color, "text"),
            }
          : undefined
      }
      background={
        editor.settings.tables.cellBackgroundColor
          ? {
              color: mappedCell.props.backgroundColor,
              setColor: (color) => updateColor(color, "background"),
            }
          : undefined
      }
    />
  );
}

function getInsertLabel(
  props: TableHandleMenuProps & { side: "above" | "below" | "left" | "right" },
) {
  if (props.side === "left") return "Insert left";
  if (props.side === "right") return "Insert right";
  if (props.side === "above") return "Insert above";
  return "Insert below";
}

function getInsertIcon(side: "above" | "below" | "left" | "right") {
  if (side === "left") return <ArrowLeft className="size-5" aria-hidden="true" />;
  if (side === "right") return <ArrowRight className="size-5" aria-hidden="true" />;
  if (side === "above") return <MoveUpIcon className="size-5" aria-hidden="true" />;
  return <MoveDownIcon className="size-5" aria-hidden="true" />;
}

function NfmTableInsertButton(
  props:
    | { orientation: "row"; side: "above" | "below" }
    | { orientation: "column"; side: "left" | "right" },
) {
  return (
    <AddButton {...props}>
      <NfmTableMenuRowContent icon={getInsertIcon(props.side)}>
        {getInsertLabel(props)}
      </NfmTableMenuRowContent>
    </AddButton>
  );
}

function NfmTableHandleMutationButton({
  action,
  children,
  icon,
  orientation,
  shortcut,
}: {
  action: "clear" | "duplicate";
  children: ReactNode;
  icon: ReactNode;
  orientation: "row" | "column";
  shortcut?: string;
}) {
  const editor = useBlockNoteEditor<NfmTableBlockSchema>();
  const { block, index } = useExtensionState(TableHandlesExtension, {
    selector: (state) => ({
      block: state?.block,
      index: orientation === "column" ? state?.colIndex : state?.rowIndex,
    }),
  });

  if (!block || index === undefined) return null;

  const mutateTable = () => {
    const tableContent = block.content as NfmTableContent;
    const target = {
      kind: orientation,
      index,
    } satisfies NfmTableRowOrColumnTarget;
    const nextContent =
      action === "duplicate"
        ? duplicateNfmTableTarget(tableContent, target)
        : clearNfmTableTarget(tableContent, target);
    if (nextContent === tableContent) return;

    editor.updateBlock(block, {
      type: "table",
      content: nextContent,
    });
    editor.setTextCursorPosition(block);
  };

  return (
    <NfmTableActionMenuItem icon={icon} onClick={mutateTable} shortcut={shortcut}>
      {children}
    </NfmTableActionMenuItem>
  );
}

function NfmTableCellClearButton() {
  const editor = useBlockNoteEditor<NfmTableBlockSchema>();
  const { block, colIndex, rowIndex } = useExtensionState(TableHandlesExtension, {
    selector: (state) => ({
      block: state?.block,
      colIndex: state?.colIndex,
      rowIndex: state?.rowIndex,
    }),
  });

  if (!block || colIndex === undefined || rowIndex === undefined) return null;

  const clearCell = () => {
    const target = {
      kind: "cell",
      rowIndex,
      colIndex,
    } satisfies NfmTableTarget;
    const tableContent = block.content as NfmTableContent;
    const nextContent = clearNfmTableTarget(tableContent, target);
    if (nextContent === tableContent) return;

    editor.updateBlock(block, {
      type: "table",
      content: nextContent,
    });
    editor.setTextCursorPosition(block);
  };

  return (
    <NfmTableActionMenuItem
      icon={<CircleX className="size-5" aria-hidden="true" />}
      onClick={clearCell}
    >
      Clear contents
    </NfmTableActionMenuItem>
  );
}

function NfmTableHandleMenu(props: TableHandleMenuProps) {
  const insertButtons =
    props.orientation === "row" ? (
      <>
        <NfmTableInsertButton orientation="row" side="above" />
        <NfmTableInsertButton orientation="row" side="below" />
      </>
    ) : (
      <>
        <NfmTableInsertButton orientation="column" side="left" />
        <NfmTableInsertButton orientation="column" side="right" />
      </>
    );

  return (
    <TableHandleMenu {...props}>
      <NfmTableHandleColorPickerButton orientation={props.orientation} />
      {insertButtons}
      <NfmTableHandleMutationButton
        action="duplicate"
        icon={<NfmSideMenuDuplicateIcon />}
        orientation={props.orientation}
        shortcut="⌘D"
      >
        Duplicate
      </NfmTableHandleMutationButton>
      <NfmTableHandleMutationButton
        action="clear"
        icon={<CircleX className="size-5" aria-hidden="true" />}
        orientation={props.orientation}
      >
        Clear contents
      </NfmTableHandleMutationButton>
      <DeleteButton orientation={props.orientation}>
        <NfmTableMenuRowContent icon={<NfmSideMenuDeleteIcon />}>Delete</NfmTableMenuRowContent>
      </DeleteButton>
      <TableHeaderRowButton orientation={props.orientation}>
        <NfmTableMenuRowContent icon={<NfmSideMenuTableHeaderIcon />}>
          Header row
        </NfmTableMenuRowContent>
      </TableHeaderRowButton>
      <TableHeaderColumnButton orientation={props.orientation}>
        <NfmTableMenuRowContent icon={<NfmSideMenuTableHeaderIcon />}>
          Header column
        </NfmTableMenuRowContent>
      </TableHeaderColumnButton>
    </TableHandleMenu>
  );
}

function NfmTableCellMenu() {
  return (
    <TableCellMenu>
      <NfmTableCellColorPickerButton />
      <SplitButton>
        <NfmTableMenuRowContent icon={<Scissors className="size-5" aria-hidden="true" />}>
          Split cell
        </NfmTableMenuRowContent>
      </SplitButton>
      <NfmTableCellClearButton />
    </TableCellMenu>
  );
}

function NfmTableHandle(props: TableHandleProps) {
  return (
    <TableHandle {...props} tableHandleMenu={NfmTableHandleMenu}>
      <span
        className="nfm-table-handle-glyph"
        data-nfm-table-handle-orientation={props.orientation}
        aria-hidden="true"
      >
        <DragHandleDotsIcon className="icon-xs" />
      </span>
    </TableHandle>
  );
}

function NfmTableCellHandle(props: TableCellButtonProps) {
  return (
    <TableCellButton {...props} tableCellMenu={NfmTableCellMenu}>
      <ChevronDownIcon className="size-3" aria-hidden="true" />
    </TableCellButton>
  );
}

function NfmTableExtendButton(props: ExtendButtonProps) {
  return (
    <ExtendButton {...props}>
      <PlusIcon className="size-3.5" aria-hidden="true" />
    </ExtendButton>
  );
}

export function NfmTableHandlesController() {
  return (
    <TableHandlesController
      tableHandle={NfmTableHandle}
      tableCellHandle={NfmTableCellHandle}
      extendButton={NfmTableExtendButton}
    />
  );
}
