import { editorHasBlockWithType, isTableCellSelection } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import { canInsertInlineMath, insertInlineMath } from "@blocknote/math-block";
import { useBlockNoteEditor, useEditorState, useExtension } from "@blocknote/react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckmarkIcon,
  ChevronRightIcon,
  CodeIcon,
  NfmSideMenuBulletedListBlockIcon,
  NfmSideMenuCheckListBlockIcon,
  NfmSideMenuHeadingBlockIcon,
  NfmSideMenuNumberedListBlockIcon,
  NfmSideMenuQuoteBlockIcon,
  NfmSideMenuTextBlockIcon,
  NfmSideMenuToggleListBlockIcon,
  TextActionBoldIcon,
  TextActionClearFormatIcon,
  TextActionCommentIcon,
  TextActionCommentPencilIcon,
  TextActionEllipsisIcon,
  TextActionEquationIcon,
  TextActionItalicIcon,
  TextActionLinkIcon,
  TextActionPencilSmallIcon,
  TextActionReactionIcon,
  TextActionSlidersIcon,
  TextActionStrikeIcon,
  TextActionUnderlineIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverAnchor } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  readTextActionRecentColors,
  recordTextActionRecentColors,
  type TextActionRecentColor,
  type TextActionRecentColorKind,
} from "@/lib/text-action-color-recents";
import { cn } from "@/lib/utils";
import {
  applyTextActionBlockType,
  applyTextActionClearFormat,
  applyTextActionStringStyle,
  applyTextActionToggleStyle,
  textActionHasBooleanStyle,
  textActionHasStringStyle,
  type TextActionEditorAdapter,
  type TextActionBlockTypeUpdate,
} from "./nfm-text-action-menu-actions";
import { NfmCreateLinkButton, type NfmCreateLinkTriggerProps } from "./nfm-link-toolbar";
import { NfmEditorPopoverContent } from "./nfm-editor-popover-content";
import { NfmMoveToMenu } from "./nfm-move-to-menu";
import type { NfmMoveToDestination, NfmMoveToResultScope } from "./nfm-move-to-menu-model";
import { NfmSendToThreadMenu } from "./nfm-send-to-thread-menu";
import type {
  NfmSendToThreadPreferredTarget,
  NfmSendToThreadRequest,
} from "./nfm-send-to-thread-menu-model";
import { useNfmSideMenuOpenController } from "./nfm-side-menu";
import type { NfmSideMenuRect } from "./nfm-side-menu-anchor";
import {
  isBlockLevelSelection,
  resolveNodexTextActionRows,
  shouldUseTextActionMenu,
  TEXT_ACTION_BASIC_STYLES,
  TEXT_ACTION_NOTION_COLOR_ORDER,
  TEXT_ACTION_COLOR_VALUES,
  TEXT_ACTION_REFERENCE_SKILLS,
  type TextActionBasicStyle,
  type TextActionColorValue,
  type TextActionNodexRow,
} from "./nfm-text-action-menu-model";
import { useNfmTextActionMenuRuntime } from "./nfm-text-action-menu-runtime";
import {
  useNfmRetainedSelectionPresentation,
  type NfmRetainedSelectionPresentation,
} from "./nfm-retained-selection-presentation";

interface TextActionBlockTypeItem {
  key: string;
  label: string;
  type: string;
  props?: Record<string, boolean | number | string>;
  isSelected: boolean;
}

interface TextActionMenuSnapshot {
  eligible: boolean;
  currentBlockId: string | null;
  selectedBlockIds: readonly string[];
  currentBlockType: string | null;
  currentBlockTypeLabel: string;
  blockTypeItems: TextActionBlockTypeItem[];
  activeStyles: Partial<Record<TextActionBasicStyle, boolean>>;
  textColor: string;
  backgroundColor: string;
  canUseTextColor: boolean;
  canUseBackgroundColor: boolean;
  canClearFormat: boolean;
  canConvertToEquation: boolean;
}

type TextActionActionPopoverKey = "send-to-thread" | "move-to";

const noopTextAction = () => undefined;
type TextActionSelectionPresentationOwner =
  | "toolbar-focus"
  | "color"
  | "block-type"
  | "nodex-action";

const TEXT_ACTION_SELECTION_PRESENTATION_BY_OWNER = {
  "toolbar-focus": "inline",
  color: "inline",
  "block-type": "blocks",
  "nodex-action": "blocks",
} as const satisfies Record<
  TextActionSelectionPresentationOwner,
  Exclude<NfmRetainedSelectionPresentation, "none">
>;

const NFM_TEXT_ACTION_MENU_SELECTION_KEY = "nfmTextActionMenuActionPopover";

interface TextActionMoveToMenuRenderProps {
  sourceProjectId: string | null;
  sourcePageId: string | null;
  onAccept: (destination: NfmMoveToDestination) => Promise<void> | void;
  onClose: () => void;
  resultScope?: NfmMoveToResultScope;
  ariaLabel?: string;
  placeholder?: string;
}

interface TextActionSendToThreadMenuRenderProps {
  projectId: string | null;
  projectNameById?: Readonly<Record<string, string>>;
  preferredTarget?: NfmSendToThreadPreferredTarget | null;
  onAccept: (request: NfmSendToThreadRequest) => Promise<void> | void;
  onClose: () => void;
}

interface TextActionBlockSnapshot {
  id?: unknown;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
}

interface TextActionSnapshotEditor extends Pick<TextActionEditorAdapter, "schema"> {
  schema: TextActionEditorAdapter["schema"] & {
    inlineContentSchema: Record<string, unknown>;
  };
  prosemirrorState: {
    selection: {
      empty: boolean;
      from: number;
      to: number;
    };
    doc: {
      textBetween: (from: number, to: number) => string;
    };
  };
  isEditable: boolean;
  getSelection: () => { blocks: TextActionBlockSnapshot[] } | undefined;
  getTextCursorPosition: () => { block: TextActionBlockSnapshot };
  getActiveStyles: () => Record<string, unknown>;
}

export interface NfmTextActionMenuSurfaceProps {
  currentBlockTypeLabel: string;
  blockTypeItems: TextActionBlockTypeItem[];
  activeStyles: Partial<Record<TextActionBasicStyle, boolean>>;
  textColor: string;
  backgroundColor: string;
  canUseTextColor: boolean;
  canUseBackgroundColor: boolean;
  canClearFormat: boolean;
  canConvertToEquation?: boolean;
  linkControl?: ReactNode;
  nodexRows: TextActionNodexRow[];
  showReferenceMocks?: boolean;
  sourceProjectId?: string | null;
  sourcePageId?: string | null;
  sendToThreadProjectNameById?: Readonly<Record<string, string>>;
  sendToThreadPreferredTarget?: NfmSendToThreadPreferredTarget | null;
  onSelectBlockType: (item: TextActionBlockTypeItem) => void;
  onToggleStyle: (style: TextActionBasicStyle) => void;
  onSetTextColor: (color: TextActionColorValue) => void;
  onSetBackgroundColor: (color: TextActionColorValue) => void;
  onClearFormat: () => void;
  onConvertToEquation?: () => void;
  onOpenBlockActions: (fallbackAnchorRect?: NfmSideMenuRect) => void;
  onMoveBlocksToDestination?: (destination: NfmMoveToDestination) => Promise<void> | void;
  onSendBlocksToThread?: (request: NfmSendToThreadRequest) => Promise<void> | void;
  onSelectionPresentationChange?: (presentation: NfmRetainedSelectionPresentation) => void;
  renderMoveToMenu?: (props: TextActionMoveToMenuRenderProps) => ReactNode;
  renderSendToThreadMenu?: (props: TextActionSendToThreadMenuRenderProps) => ReactNode;
}

const TEXT_ACTION_BLOCK_TYPE_DEFINITIONS = [
  { key: "paragraph", label: "Normal Text", type: "paragraph" },
  {
    key: "heading-1",
    label: "Heading 1",
    type: "heading",
    props: { level: 1, isToggleable: false },
  },
  {
    key: "heading-2",
    label: "Heading 2",
    type: "heading",
    props: { level: 2, isToggleable: false },
  },
  {
    key: "heading-3",
    label: "Heading 3",
    type: "heading",
    props: { level: 3, isToggleable: false },
  },
  {
    key: "toggle-heading-1",
    label: "Toggle Heading 1",
    type: "heading",
    props: { level: 1, isToggleable: true },
  },
  { key: "quote", label: "Quote", type: "quote" },
  { key: "bullet-list", label: "Bulleted List", type: "bulletListItem" },
  { key: "numbered-list", label: "Numbered List", type: "numberedListItem" },
  { key: "todo-list", label: "To-do List", type: "checkListItem" },
  { key: "toggle-list", label: "Toggle List", type: "toggleListItem" },
  { key: "code", label: "Code", type: "codeBlock" },
] as const;

const TEXT_ACTION_STYLE_LABELS = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strike: "Strikethrough",
  code: "Code",
} as const satisfies Record<TextActionBasicStyle, string>;

const TEXT_ACTION_COLOR_LABELS = {
  default: "Default",
  gray: "Gray",
  brown: "Brown",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
} as const satisfies Record<TextActionColorValue, string>;

const TEXT_ACTION_COLOR_STYLES = {
  default: "transparent",
  gray: "color-mix(in srgb, var(--color-token-foreground) 42%, transparent)",
  brown:
    "color-mix(in srgb, var(--color-token-charts-orange) 70%, var(--color-token-foreground) 18%)",
  orange: "var(--color-token-charts-orange)",
  yellow: "var(--color-token-charts-yellow)",
  green: "var(--color-token-charts-green)",
  blue: "var(--blue-300)",
  purple: "var(--color-token-charts-purple)",
  pink: "color-mix(in srgb, var(--color-token-charts-purple) 56%, var(--color-token-charts-red) 44%)",
  red: "var(--color-token-charts-red)",
} as const satisfies Record<TextActionColorValue, string>;

const TEXT_ACTION_BACKGROUND_COLOR_STYLES = {
  default: "transparent",
  gray: "color-mix(in srgb, var(--color-token-foreground) 12%, transparent)",
  brown: "color-mix(in srgb, var(--color-token-charts-orange) 24%, transparent)",
  orange: "color-mix(in srgb, var(--color-token-charts-orange) 24%, transparent)",
  yellow: "color-mix(in srgb, var(--color-token-charts-yellow) 30%, transparent)",
  green: "color-mix(in srgb, var(--color-token-charts-green) 24%, transparent)",
  blue: "color-mix(in srgb, var(--blue-300) 22%, transparent)",
  purple: "color-mix(in srgb, var(--color-token-charts-purple) 24%, transparent)",
  pink: "color-mix(in srgb, var(--color-token-charts-purple) 18%, var(--color-token-charts-red) 14%)",
  red: "color-mix(in srgb, var(--color-token-charts-red) 24%, transparent)",
} as const satisfies Record<TextActionColorValue, string>;

const TEXT_ACTION_COLOR_BORDER_STYLES = {
  default: "var(--color-token-border)",
  gray: "color-mix(in srgb, var(--color-token-foreground) 26%, transparent)",
  brown: "color-mix(in srgb, var(--color-token-charts-orange) 40%, transparent)",
  orange: "color-mix(in srgb, var(--color-token-charts-orange) 44%, transparent)",
  yellow: "color-mix(in srgb, var(--color-token-charts-yellow) 48%, transparent)",
  green: "color-mix(in srgb, var(--color-token-charts-green) 42%, transparent)",
  blue: "color-mix(in srgb, var(--blue-300) 40%, transparent)",
  purple: "color-mix(in srgb, var(--color-token-charts-purple) 42%, transparent)",
  pink: "color-mix(in srgb, var(--color-token-charts-purple) 30%, var(--color-token-charts-red) 28%)",
  red: "color-mix(in srgb, var(--color-token-charts-red) 44%, transparent)",
} as const satisfies Record<TextActionColorValue, string>;

function keepEditorSelection(event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) {
  if ("button" in event && event.button !== 0) return;
  event.preventDefault();
}

function activateOnKeyboard(event: KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function hasLinkInSchema(editor: { schema: { inlineContentSchema: Record<string, unknown> } }) {
  return (
    "link" in editor.schema.inlineContentSchema && editor.schema.inlineContentSchema.link === "link"
  );
}

function blockPropsMatch(
  blockProps: Record<string, unknown>,
  expectedProps?: Record<string, boolean | number | string>,
) {
  if (!expectedProps) return true;
  return Object.entries(expectedProps).every(([key, value]) => blockProps[key] === value);
}

function propsToSchemaShape(props?: Record<string, boolean | number | string>) {
  return Object.fromEntries(
    Object.entries(props ?? {}).map(([key, value]) => [key, typeof value]),
  ) as Record<string, "boolean" | "number" | "string">;
}

function buildBlockTypeItems(
  editor: TextActionSnapshotEditor,
  firstSelectedBlock: TextActionBlockSnapshot,
): TextActionBlockTypeItem[] {
  return TEXT_ACTION_BLOCK_TYPE_DEFINITIONS.filter((item) => {
    const props = "props" in item ? item.props : undefined;
    return editorHasBlockWithType(
      editor as Parameters<typeof editorHasBlockWithType>[0],
      item.type,
      propsToSchemaShape(props),
    );
  }).map((item) => {
    const props = "props" in item ? item.props : undefined;
    return {
      key: item.key,
      label: item.label,
      type: item.type,
      props,
      isSelected:
        firstSelectedBlock.type === item.type &&
        blockPropsMatch(firstSelectedBlock.props ?? {}, props),
    };
  });
}

function resolveBlockTypeLabel(items: TextActionBlockTypeItem[]) {
  return items.find((item) => item.isSelected)?.label ?? "Normal Text";
}

function createTextActionMenuSnapshot(editor: TextActionSnapshotEditor): TextActionMenuSnapshot {
  const selection = editor.prosemirrorState.selection;
  const selectedBlocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  const firstSelectedBlock = selectedBlocks[0];
  const hasInlineContent = selectedBlocks.some(
    (block: { content?: unknown }) => block.content !== undefined,
  );
  const selectedTextLength = selection.empty
    ? 0
    : editor.prosemirrorState.doc.textBetween(selection.from, selection.to).length;
  const blockTypeItems = buildBlockTypeItems(editor, firstSelectedBlock);
  const activeStyles = editor.getActiveStyles() as Record<string, unknown>;
  const canUseTextColor = textActionHasStringStyle(editor, "textColor");
  const canUseBackgroundColor = textActionHasStringStyle(editor, "backgroundColor");

  return {
    eligible: shouldUseTextActionMenu({
      isEditable: editor.isEditable,
      isTableCellSelection: isTableCellSelection(
        selection as Parameters<typeof isTableCellSelection>[0],
      ),
      isBlockSelection: isBlockLevelSelection(selection),
      hasInlineContent,
      selectedTextLength,
      selectionFrom: selection.from,
      selectionTo: selection.to,
    }),
    currentBlockId: typeof firstSelectedBlock?.id === "string" ? firstSelectedBlock.id : null,
    selectedBlockIds: selectedBlocks
      .map((block) => block.id)
      .filter((blockId): blockId is string => typeof blockId === "string"),
    currentBlockType: typeof firstSelectedBlock?.type === "string" ? firstSelectedBlock.type : null,
    currentBlockTypeLabel: resolveBlockTypeLabel(blockTypeItems),
    blockTypeItems,
    activeStyles: {
      bold: activeStyles.bold === true,
      italic: activeStyles.italic === true,
      underline: activeStyles.underline === true,
      strike: activeStyles.strike === true,
      code: activeStyles.code === true,
    },
    textColor: typeof activeStyles.textColor === "string" ? activeStyles.textColor : "default",
    backgroundColor:
      typeof activeStyles.backgroundColor === "string" ? activeStyles.backgroundColor : "default",
    canUseTextColor,
    canUseBackgroundColor,
    canClearFormat:
      TEXT_ACTION_BASIC_STYLES.some((style) => textActionHasBooleanStyle(editor, style)) ||
      canUseTextColor ||
      canUseBackgroundColor ||
      hasLinkInSchema(editor),
    canConvertToEquation: canInsertInlineMath(
      editor as unknown as Parameters<typeof canInsertInlineMath>[0],
    ),
  };
}

function selectCurrentBlocks(editor: TextActionSnapshotEditor) {
  return editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
}

function TextActionDivider({ compact = false }: { compact?: boolean }) {
  return <div className={cn("mx-2 h-px bg-token-menu-border", compact ? "my-0" : "my-1")} />;
}

interface TextActionButtonProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "className" | "onMouseDown"
> {
  children: ReactNode;
  className?: string;
  label?: string;
  selected?: boolean;
  disabled?: boolean;
  hasPopup?: "dialog" | "menu";
  expanded?: boolean;
  dataPopupOrigin?: boolean;
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
  onActivate?: () => void;
}

const TextActionButton = forwardRef<HTMLDivElement, TextActionButtonProps>(
  function TextActionButton(
    {
      children,
      className,
      label,
      selected,
      disabled = false,
      hasPopup,
      expanded,
      dataPopupOrigin = true,
      onMouseDown = keepEditorSelection,
      onActivate,
      onClick,
      onKeyDown,
      ...props
    },
    ref,
  ) {
    return (
      <div
        {...props}
        ref={ref}
        role="button"
        tabIndex={props.tabIndex ?? 0}
        aria-label={label}
        aria-pressed={selected === undefined ? undefined : selected}
        aria-disabled={disabled || undefined}
        aria-haspopup={hasPopup}
        aria-expanded={hasPopup ? Boolean(expanded) : undefined}
        data-popup-origin={dataPopupOrigin ? "true" : undefined}
        contentEditable={false}
        className={cn(
          "inline-flex h-7 w-8 shrink-0 select-none items-center justify-center rounded-[6px] p-1.5 text-token-foreground outline-hidden",
          "focus-visible:ring-1 focus-visible:ring-token-focus-border",
          !disabled &&
            "cursor-interaction hover:bg-token-list-hover-background focus:bg-token-list-hover-background",
          selected === true && "bg-token-foreground/10",
          disabled && "cursor-default opacity-40",
          className,
        )}
        onMouseDown={onMouseDown}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          if (onActivate) {
            onActivate();
            return;
          }
          onClick?.(event);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (onActivate) {
            activateOnKeyboard(event, onActivate);
            return;
          }
          onKeyDown?.(event);
        }}
      >
        {children}
      </div>
    );
  },
);

function TextActionButtonTooltip({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <NodexTooltip tooltipContent={label} side="top" delay={0}>
      {children}
    </NodexTooltip>
  );
}

function isTextActionLabelOverflowing(element: HTMLElement | null): boolean {
  if (!element) return false;
  return element.scrollWidth - element.clientWidth > 1;
}

function TextActionMenuContent({
  children,
  className,
  side = "right",
  align = "start",
}: {
  children: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <NodexDropdownPortal>
      <NodexDropdownContent
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={8}
        finalFocus={false}
        className={cn(
          "w-[192px] bg-token-dropdown-background px-1 py-1 text-sm backdrop-blur-xl",
          className,
        )}
      >
        {children}
      </NodexDropdownContent>
    </NodexDropdownPortal>
  );
}

function BlockTypeIcon({ item }: { item: TextActionBlockTypeItem | null }) {
  if (!item) return <NfmSideMenuTextBlockIcon />;

  if (item.key === "paragraph") return <NfmSideMenuTextBlockIcon />;
  if (item.key === "heading-1" || item.key === "toggle-heading-1") {
    return <NfmSideMenuHeadingBlockIcon level={1} />;
  }
  if (item.key === "heading-2") return <NfmSideMenuHeadingBlockIcon level={2} />;
  if (item.key === "heading-3") return <NfmSideMenuHeadingBlockIcon level={3} />;
  if (item.key === "quote") return <NfmSideMenuQuoteBlockIcon />;
  if (item.key === "bullet-list") return <NfmSideMenuBulletedListBlockIcon />;
  if (item.key === "numbered-list") return <NfmSideMenuNumberedListBlockIcon />;
  if (item.key === "todo-list") return <NfmSideMenuCheckListBlockIcon />;
  if (item.key === "toggle-list") return <NfmSideMenuToggleListBlockIcon />;
  if (item.key === "code") return <CodeIcon />;

  return <NfmSideMenuTextBlockIcon />;
}

function normalizeTextActionColor(color: string): TextActionColorValue {
  return TEXT_ACTION_COLOR_VALUES.includes(color as TextActionColorValue)
    ? (color as TextActionColorValue)
    : "default";
}

function TextActionColorGlyph({
  color,
  kind,
  size,
  selected = false,
  textColor,
}: {
  color: TextActionColorValue;
  kind: TextActionRecentColorKind;
  size: "trigger" | "menu";
  selected?: boolean;
  textColor?: TextActionColorValue;
}) {
  const isBackground = kind === "background";
  const isDefault = color === "default";
  const shouldShowTextGlyph = kind === "text" || textColor !== undefined;
  const glyphColor = textColor ?? color;
  const borderWidth = selected || isDefault ? 2 : 1;
  const selectedBorderColor = isDefault ? "var(--border-strong)" : TEXT_ACTION_COLOR_STYLES[color];
  const swatchStyle: CSSProperties = {
    backgroundColor: isBackground ? TEXT_ACTION_BACKGROUND_COLOR_STYLES[color] : "transparent",
    color:
      glyphColor === "default"
        ? "var(--color-token-foreground)"
        : TEXT_ACTION_COLOR_STYLES[glyphColor],
    boxShadow: `inset 0 0 0 ${borderWidth}px ${selected ? selectedBorderColor : TEXT_ACTION_COLOR_BORDER_STYLES[color]}`,
  };

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-[6px] text-center leading-none font-medium",
        size === "trigger" ? "size-5 text-[12px]" : "size-[26px] text-[16px]",
      )}
      style={swatchStyle}
    >
      {shouldShowTextGlyph ? "A" : null}
    </span>
  );
}

function TextActionColorTriggerGlyph({
  textColor,
  backgroundColor,
}: {
  textColor: string;
  backgroundColor: string;
}) {
  const normalizedTextColor = normalizeTextActionColor(textColor);
  const normalizedBackgroundColor = normalizeTextActionColor(backgroundColor);

  if (normalizedBackgroundColor !== "default") {
    return (
      <TextActionColorGlyph
        kind="background"
        color={normalizedBackgroundColor}
        size="trigger"
        textColor={normalizedTextColor}
      />
    );
  }

  return <TextActionColorGlyph kind="text" color={normalizedTextColor} size="trigger" />;
}

function TextActionColorSection({
  label,
  children,
  padBottom = false,
}: {
  label: string;
  children: ReactNode;
  padBottom?: boolean;
}) {
  return (
    <div className="block">
      <div className="flex h-7 items-center px-2 text-xs text-token-text-secondary">
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
      <div className={cn("grid grid-cols-5 gap-1 px-2", padBottom && "pb-2")}>{children}</div>
    </div>
  );
}

function TextActionColorSwatchItem({
  kind,
  color,
  ariaLabel,
  selected,
  disabled = false,
  onSelect,
}: {
  kind: TextActionRecentColorKind;
  color: TextActionColorValue;
  ariaLabel: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <div data-popup-origin="true">
      <div className="inline-block w-[30px] p-0 leading-none">
        <div
          role="menuitem"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-current={selected ? "true" : undefined}
          aria-disabled={disabled || undefined}
          contentEditable={false}
          className={cn(
            "inline-block size-full rounded-[6px] p-0.5 outline-hidden",
            disabled
              ? "cursor-default opacity-45"
              : "cursor-interaction hover:bg-token-list-hover-background focus:bg-token-list-hover-background",
          )}
          onMouseDown={keepEditorSelection}
          onClick={(event) => {
            event.stopPropagation();
            if (disabled) return;
            onSelect();
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            activateOnKeyboard(event, onSelect);
          }}
        >
          <span className="flex min-h-[26px] items-center justify-center">
            <TextActionColorGlyph kind={kind} color={color} size="menu" selected={selected} />
          </span>
        </div>
      </div>
    </div>
  );
}

function TextActionColorMenu({
  canUseTextColor,
  canUseBackgroundColor,
  textColor,
  backgroundColor,
  onSetTextColor,
  onSetBackgroundColor,
  onOpenChange,
}: Pick<
  NfmTextActionMenuSurfaceProps,
  | "canUseTextColor"
  | "canUseBackgroundColor"
  | "textColor"
  | "backgroundColor"
  | "onSetTextColor"
  | "onSetBackgroundColor"
> & {
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recentColors, setRecentColors] = useState<TextActionRecentColor[]>(() =>
    readTextActionRecentColors(),
  );
  const normalizedTextColor = normalizeTextActionColor(textColor);
  const normalizedBackgroundColor = normalizeTextActionColor(backgroundColor);
  const canUseAnyColor = canUseTextColor || canUseBackgroundColor;

  const applyColor = (kind: TextActionRecentColorKind, color: TextActionColorValue) => {
    const currentColor = kind === "text" ? normalizedTextColor : normalizedBackgroundColor;
    const nextColor: TextActionColorValue = currentColor === color ? "default" : color;

    if (kind === "text") {
      if (!canUseTextColor) return;
      onSetTextColor(nextColor);
    } else {
      if (!canUseBackgroundColor) return;
      onSetBackgroundColor(nextColor);
    }

    const nextRecentColors = recordTextActionRecentColors(kind, nextColor);
    if (nextRecentColors) {
      setRecentColors(nextRecentColors);
    }
  };

  if (!canUseAnyColor) {
    return (
      <TextActionButtonTooltip label="Color">
        <TextActionButton label="Color" disabled hasPopup="dialog">
          <TextActionColorTriggerGlyph textColor={textColor} backgroundColor={backgroundColor} />
        </TextActionButton>
      </TextActionButtonTooltip>
    );
  }

  return (
    <NodexDropdownRoot
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange(nextOpen);
      }}
    >
      <TextActionButtonTooltip label="Color">
        <NodexDropdownTrigger>
          <TextActionButton label="Color" hasPopup="dialog" expanded={open}>
            <TextActionColorTriggerGlyph textColor={textColor} backgroundColor={backgroundColor} />
          </TextActionButton>
        </NodexDropdownTrigger>
      </TextActionButtonTooltip>
      <NodexDropdownPortal>
        <NodexDropdownContent
          role="dialog"
          aria-modal="true"
          aria-label="Color"
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          finalFocus={false}
          style={{
            width: "190px",
            minWidth: "180px",
            maxWidth: "calc(100vw - 24px)",
            maxHeight: "70vh",
            transformOrigin: "0% bottom",
          }}
          className="!overflow-hidden !rounded-[14px] !bg-token-dropdown-background !p-0 text-sm !shadow-xl-spread !backdrop-blur-xl"
        >
          <div className="notion-scroller vertical max-h-[70vh] overflow-y-auto">
            <div role="menu" tabIndex={0} aria-label="Color options">
              <TextActionColorSection label="Recently used">
                {recentColors.map((recentColor) => {
                  const recentLabel = TEXT_ACTION_COLOR_LABELS[recentColor.color];
                  const recentAriaLabel = `Recently used: ${recentLabel} ${recentColor.kind === "background" ? "background" : "text"}`;
                  const canUseRecentColor =
                    recentColor.kind === "text" ? canUseTextColor : canUseBackgroundColor;
                  const recentSelected =
                    recentColor.kind === "text"
                      ? normalizedTextColor === recentColor.color
                      : normalizedBackgroundColor === recentColor.color;

                  return (
                    <TextActionColorSwatchItem
                      key={`recent-${recentColor.kind}-${recentColor.color}`}
                      kind={recentColor.kind}
                      color={recentColor.color}
                      ariaLabel={recentAriaLabel}
                      selected={recentSelected}
                      disabled={!canUseRecentColor}
                      onSelect={() => applyColor(recentColor.kind, recentColor.color)}
                    />
                  );
                })}
              </TextActionColorSection>

              {canUseTextColor ? (
                <TextActionColorSection label="Text color">
                  {TEXT_ACTION_NOTION_COLOR_ORDER.map((color) => (
                    <TextActionColorSwatchItem
                      key={`text-${color}`}
                      kind="text"
                      color={color}
                      ariaLabel={`Text color: ${TEXT_ACTION_COLOR_LABELS[color]}`}
                      selected={normalizedTextColor === color}
                      onSelect={() => applyColor("text", color)}
                    />
                  ))}
                </TextActionColorSection>
              ) : null}

              {canUseBackgroundColor ? (
                <TextActionColorSection label="Background color" padBottom>
                  {TEXT_ACTION_NOTION_COLOR_ORDER.map((color) => (
                    <TextActionColorSwatchItem
                      key={`background-${color}`}
                      kind="background"
                      color={color}
                      ariaLabel={`Background color: ${TEXT_ACTION_COLOR_LABELS[color]}`}
                      selected={normalizedBackgroundColor === color}
                      onSelect={() => applyColor("background", color)}
                    />
                  ))}
                </TextActionColorSection>
              ) : null}
            </div>
          </div>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}

function TextActionBlockTypeMenu({
  currentBlockTypeLabel,
  blockTypeItems,
  onSelectBlockType,
  onOpenChange,
}: Pick<
  NfmTextActionMenuSurfaceProps,
  "currentBlockTypeLabel" | "blockTypeItems" | "onSelectBlockType"
> & {
  onOpenChange: (open: boolean) => void;
}) {
  const currentBlockTypeItem =
    blockTypeItems.find((item) => item.isSelected) ??
    blockTypeItems.find((item) => item.label === currentBlockTypeLabel) ??
    null;

  return (
    <NodexDropdownRoot onOpenChange={onOpenChange}>
      <TextActionButtonTooltip label="Change block type">
        <NodexDropdownTrigger>
          <div
            role="button"
            tabIndex={0}
            data-popup-origin="true"
            contentEditable={false}
            className="flex h-7 select-none items-center gap-2 rounded-[6px] px-1.5 text-token-foreground outline-hidden hover:bg-token-list-hover-background focus:bg-token-list-hover-background focus-visible:ring-1 focus-visible:ring-token-focus-border"
            onMouseDown={keepEditorSelection}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-token-text-secondary">
              <BlockTypeIcon item={currentBlockTypeItem} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{currentBlockTypeLabel}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-token-text-secondary" />
          </div>
        </NodexDropdownTrigger>
      </TextActionButtonTooltip>
      <TextActionMenuContent>
        {blockTypeItems.map((item) => (
          <NodexDropdownItem
            key={item.key}
            leftSlot={
              <span className="text-token-description-foreground">
                <BlockTypeIcon item={item} />
              </span>
            }
            rightSlot={item.isSelected ? <CheckmarkIcon className="size-4" /> : null}
            onPointerDownCapture={keepEditorSelection}
            onSelect={() => onSelectBlockType(item)}
          >
            {item.label}
          </NodexDropdownItem>
        ))}
      </TextActionMenuContent>
    </NodexDropdownRoot>
  );
}

function TextActionDisabledButton({
  children,
  label,
  className,
  mock = false,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  mock?: boolean;
}) {
  const tooltipContent = mock
    ? `${label} is mock UI only. Not available in Nodex yet.`
    : `${label} is not supported in Nodex yet.`;
  const ariaLabel = mock ? `${label} Mock` : label;

  return (
    <NodexTooltip tooltipContent={tooltipContent} side="top" delay={0}>
      <TextActionButton label={ariaLabel} disabled className={className}>
        {children}
      </TextActionButton>
    </NodexTooltip>
  );
}

function TextActionMockBadge({ reason }: { reason?: string }) {
  return (
    <NodexTooltip tooltipContent={reason}>
      <span className="shrink-0 rounded-[4px] bg-token-foreground/5 px-1 text-[10px] font-medium uppercase leading-4 text-token-description-foreground">
        Mock
      </span>
    </NodexTooltip>
  );
}

function renderCreateLinkTrigger(props: NfmCreateLinkTriggerProps) {
  return (
    <TextActionButton
      label={props.ariaLabel}
      hasPopup="dialog"
      expanded={props.open}
      onMouseDown={props.onMouseDown}
      onActivate={props.onClick}
    >
      <TextActionLinkIcon />
    </TextActionButton>
  );
}

function rectToSideMenuRect(rect: DOMRect): NfmSideMenuRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function TextActionMoreButton({
  onOpenBlockActions,
}: Pick<NfmTextActionMenuSurfaceProps, "onOpenBlockActions">) {
  const buttonRef = useRef<HTMLDivElement>(null);

  const openBlockActions = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    onOpenBlockActions(rect ? rectToSideMenuRect(rect) : undefined);
  };

  return (
    <TextActionButtonTooltip label="More">
      <TextActionButton
        ref={buttonRef}
        label="More"
        hasPopup="dialog"
        className="notion-block-action-menu"
        onActivate={openBlockActions}
      >
        <TextActionEllipsisIcon />
      </TextActionButton>
    </TextActionButtonTooltip>
  );
}

type TextActionSkillRowProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "className" | "onClick" | "onMouseDown"
> & {
  label: string;
  disabled?: boolean;
  mockReason?: string;
  rightSlot?: ReactNode;
  hasPopup?: "dialog" | "menu";
  expanded?: boolean;
  onClick?: () => void;
};

const TextActionSkillRow = forwardRef<HTMLDivElement, TextActionSkillRowProps>(
  function TextActionSkillRow(
    {
      label,
      disabled = true,
      mockReason,
      rightSlot,
      hasPopup,
      expanded,
      onClick,
      onPointerEnter,
      onPointerLeave,
      onFocus,
      onBlur,
      onKeyDown,
      ...props
    },
    forwardedRef,
  ) {
    const labelRef = useRef<HTMLSpanElement>(null);
    const [tooltipOpen, setTooltipOpen] = useState(false);
    const [labelOverflowing, setLabelOverflowing] = useState(false);

    const openTooltipIfOverflowing = () => {
      const nextLabelOverflowing = isTextActionLabelOverflowing(labelRef.current);
      setLabelOverflowing(nextLabelOverflowing);
      setTooltipOpen(nextLabelOverflowing);
    };

    const closeTooltip = () => {
      setTooltipOpen(false);
    };

    const row = (
      <div
        {...props}
        ref={forwardedRef}
        role="button"
        tabIndex={props.tabIndex ?? 0}
        aria-disabled={disabled || undefined}
        aria-haspopup={hasPopup}
        aria-expanded={hasPopup ? Boolean(expanded) : undefined}
        contentEditable={false}
        className={cn(
          "group flex h-7 select-none items-center justify-start gap-1.5 rounded-[6px] px-2 whitespace-nowrap outline-hidden",
          disabled
            ? "cursor-default text-token-text-secondary opacity-55"
            : "cursor-interaction text-token-foreground hover:bg-token-list-hover-background focus:bg-token-list-hover-background",
        )}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          openTooltipIfOverflowing();
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          closeTooltip();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          openTooltipIfOverflowing();
        }}
        onBlur={(event) => {
          onBlur?.(event);
          closeTooltip();
        }}
        onMouseDown={keepEditorSelection}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          onClick?.();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (disabled || !onClick) return;
          activateOnKeyboard(event, onClick);
        }}
      >
        <span ref={labelRef} className="min-w-0 flex-1 truncate">
          {label}
        </span>
        {mockReason ? <TextActionMockBadge reason={mockReason} /> : null}
        {rightSlot ??
          (disabled ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Edit skill"
              aria-disabled="true"
              className="ml-auto shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-40 group-focus:opacity-40"
            >
              <TextActionPencilSmallIcon className="size-4 text-token-text-secondary" />
            </span>
          ) : null)}
      </div>
    );

    return (
      <NodexTooltip
        tooltipContent={label}
        side="top"
        delay={0}
        open={tooltipOpen && labelOverflowing}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeTooltip();
            return;
          }

          openTooltipIfOverflowing();
        }}
      >
        {row}
      </NodexTooltip>
    );
  },
);

function TextActionMoveToRow({
  row,
  sourceProjectId,
  sourcePageId,
  onMoveBlocksToDestination,
  renderMoveToMenu,
  open,
  onOpenChange,
}: {
  row: TextActionNodexRow;
  sourceProjectId: string | null;
  sourcePageId: string | null;
  onMoveBlocksToDestination?: (destination: NfmMoveToDestination) => Promise<void> | void;
  renderMoveToMenu?: (props: TextActionMoveToMenuRenderProps) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const enabled = row.enabled && Boolean(onMoveBlocksToDestination);

  const closeAndRestoreFocus = () => {
    onOpenChange(false);
    requestAnimationFrame(() => {
      rowRef.current?.focus();
    });
  };

  const menuProps: TextActionMoveToMenuRenderProps = {
    sourceProjectId,
    sourcePageId,
    onAccept: async (destination) => {
      if (!onMoveBlocksToDestination) return;
      await onMoveBlocksToDestination(destination);
      onOpenChange(false);
    },
    onClose: closeAndRestoreFocus,
  };

  return (
    <NodexPopover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && !enabled) return;
        onOpenChange(nextOpen);
      }}
    >
      <NodexPopoverAnchor>
        <TextActionSkillRow
          ref={rowRef}
          label={row.label}
          disabled={!enabled}
          hasPopup="dialog"
          expanded={open}
          rightSlot={
            enabled ? (
              <ChevronRightIcon className="size-4 shrink-0 text-token-text-secondary" />
            ) : undefined
          }
          onClick={() => {
            if (enabled) onOpenChange(true);
          }}
        />
      </NodexPopoverAnchor>
      <NfmEditorPopoverContent
        side="right"
        align="start"
        sideOffset={6}
        alignOffset={-4}
        aria-label="Move to"
        className="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0 text-sm leading-[1.2] shadow-xl-spread backdrop-blur-xl"
        style={{ width: 330 }}
      >
        {renderMoveToMenu?.(menuProps) ?? <NfmMoveToMenu {...menuProps} />}
      </NfmEditorPopoverContent>
    </NodexPopover>
  );
}

function TextActionSendToThreadRow({
  row,
  projectId,
  projectNameById,
  preferredTarget,
  onSendBlocksToThread,
  renderSendToThreadMenu,
  open,
  onOpenChange,
}: {
  row: TextActionNodexRow;
  projectId: string | null;
  projectNameById?: Readonly<Record<string, string>>;
  preferredTarget?: NfmSendToThreadPreferredTarget | null;
  onSendBlocksToThread?: (request: NfmSendToThreadRequest) => Promise<void> | void;
  renderSendToThreadMenu?: (props: TextActionSendToThreadMenuRenderProps) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const enabled = row.enabled && Boolean(projectId) && Boolean(onSendBlocksToThread);

  const closeAndRestoreFocus = () => {
    onOpenChange(false);
    requestAnimationFrame(() => {
      rowRef.current?.focus();
    });
  };

  const menuProps: TextActionSendToThreadMenuRenderProps = {
    projectId,
    projectNameById,
    preferredTarget,
    onAccept: async (request) => {
      if (!onSendBlocksToThread) return;
      await onSendBlocksToThread(request);
      onOpenChange(false);
    },
    onClose: closeAndRestoreFocus,
  };

  return (
    <NodexPopover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && !enabled) return;
        onOpenChange(nextOpen);
      }}
    >
      <NodexPopoverAnchor>
        <TextActionSkillRow
          ref={rowRef}
          label={row.label}
          disabled={!enabled}
          hasPopup="dialog"
          expanded={open}
          rightSlot={
            enabled ? (
              <ChevronRightIcon className="size-4 shrink-0 text-token-text-secondary" />
            ) : undefined
          }
          onClick={() => {
            if (enabled) onOpenChange(true);
          }}
        />
      </NodexPopoverAnchor>
      <NfmEditorPopoverContent
        side="right"
        align="start"
        sideOffset={6}
        alignOffset={-4}
        aria-label="Send to chat"
        className="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0 text-sm leading-[1.2] shadow-xl-spread backdrop-blur-xl"
        style={{ width: 330 }}
      >
        {renderSendToThreadMenu?.(menuProps) ?? <NfmSendToThreadMenu {...menuProps} />}
      </NfmEditorPopoverContent>
    </NodexPopover>
  );
}

function TextActionAiPane({
  nodexRows,
  showReferenceMocks = false,
  sourceProjectId,
  sourcePageId,
  sendToThreadProjectNameById,
  sendToThreadPreferredTarget,
  onMoveBlocksToDestination,
  onSendBlocksToThread,
  onActionPopoverOpenChange,
  renderMoveToMenu,
  renderSendToThreadMenu,
}: Pick<
  NfmTextActionMenuSurfaceProps,
  | "nodexRows"
  | "showReferenceMocks"
  | "sourceProjectId"
  | "sourcePageId"
  | "sendToThreadProjectNameById"
  | "sendToThreadPreferredTarget"
  | "onMoveBlocksToDestination"
  | "onSendBlocksToThread"
  | "renderMoveToMenu"
  | "renderSendToThreadMenu"
> & {
  onActionPopoverOpenChange?: (open: boolean) => void;
}) {
  const [activePopover, setActivePopover] = useState<TextActionActionPopoverKey | null>(null);
  const activePopoverRef = useRef<TextActionActionPopoverKey | null>(null);
  const onActionPopoverOpenChangeRef = useRef(onActionPopoverOpenChange);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [hasContentBelow, setHasContentBelow] = useState(false);

  useLayoutEffect(() => {
    onActionPopoverOpenChangeRef.current = onActionPopoverOpenChange;
  }, [onActionPopoverOpenChange]);

  const syncContentBelow = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const remainingScroll = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    setHasContentBelow(remainingScroll > 1);
  }, []);

  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return undefined;

    syncContentBelow();

    if (typeof ResizeObserver === "undefined") return undefined;

    const resizeObserver = new ResizeObserver(syncContentBelow);
    resizeObserver.observe(viewport);
    Array.from(viewport.children).forEach((child) => resizeObserver.observe(child));
    return () => resizeObserver.disconnect();
  }, [nodexRows, showReferenceMocks, syncContentBelow]);

  // Selection presentation updates rerender the parent and may replace its
  // callback. Only the pane's actual unmount closes its active popover.
  useEffect(
    () => () => {
      onActionPopoverOpenChangeRef.current?.(false);
    },
    [],
  );

  const setActionPopoverOpen = (popover: TextActionActionPopoverKey, nextOpen: boolean) => {
    const currentPopover = activePopoverRef.current;
    const nextPopover = nextOpen ? popover : currentPopover === popover ? null : currentPopover;
    if (nextPopover === currentPopover) return;

    activePopoverRef.current = nextPopover;
    onActionPopoverOpenChange?.(nextPopover !== null);
    setActivePopover(nextPopover);
  };

  return (
    <div className="relative">
      <div
        ref={scrollViewportRef}
        className="max-h-[134px] overflow-y-auto py-1"
        data-testid="nfm-text-action-ai-scroll"
        onScroll={syncContentBelow}
      >
        {nodexRows.length > 0 ? (
          <>
            <div className="flex h-7 items-center px-2 text-xs text-token-text-secondary">
              Actions
            </div>
            {nodexRows.map((row) => {
              if (row.key === "send-to-thread") {
                return (
                  <TextActionSendToThreadRow
                    key={row.key}
                    row={row}
                    projectId={sourceProjectId ?? null}
                    projectNameById={sendToThreadProjectNameById}
                    preferredTarget={sendToThreadPreferredTarget ?? null}
                    onSendBlocksToThread={onSendBlocksToThread}
                    renderSendToThreadMenu={renderSendToThreadMenu}
                    open={activePopover === "send-to-thread"}
                    onOpenChange={(nextOpen) => setActionPopoverOpen("send-to-thread", nextOpen)}
                  />
                );
              }

              if (row.key === "move-to") {
                return (
                  <TextActionMoveToRow
                    key={row.key}
                    row={row}
                    sourceProjectId={sourceProjectId ?? null}
                    sourcePageId={sourcePageId ?? null}
                    onMoveBlocksToDestination={onMoveBlocksToDestination}
                    renderMoveToMenu={renderMoveToMenu}
                    open={activePopover === "move-to"}
                    onOpenChange={(nextOpen) => setActionPopoverOpen("move-to", nextOpen)}
                  />
                );
              }

              return null;
            })}
          </>
        ) : null}
        {showReferenceMocks ? (
          <>
            <div className="flex h-7 items-center px-2 text-xs text-token-text-secondary">
              <span className="min-w-0 flex-1 truncate">Skills</span>
              <TextActionDisabledButton
                label="Skills"
                className="size-7 text-token-text-secondary"
                mock
              >
                <TextActionSlidersIcon />
              </TextActionDisabledButton>
            </div>
            {TEXT_ACTION_REFERENCE_SKILLS.map((skill) => (
              <TextActionSkillRow
                key={skill.key}
                label={skill.label}
                disabled
                mockReason="Mock UI only. Not available in Nodex yet."
              />
            ))}
          </>
        ) : null}
      </div>
      {hasContentBelow ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-token-dropdown-background"
          data-testid="nfm-text-action-ai-scroll-mask"
        />
      ) : null}
    </div>
  );
}

function TextActionAiFooter() {
  return (
    <div
      className="flex min-h-8 items-center gap-1.5 rounded-[6px] border border-token-border px-2 py-1.5 text-sm leading-[1.4] text-token-text-secondary"
      contentEditable={false}
    >
      <div
        role="textbox"
        aria-multiline="true"
        aria-disabled="true"
        contentEditable={false}
        spellCheck={true}
        data-content-editable-leaf="true"
        className="min-h-[1em] min-w-0 flex-1 truncate text-token-description-foreground"
      >
        Edit with AI
      </div>
      <TextActionMockBadge reason="Mock UI only. Not available in Nodex yet." />
      <span className="shrink-0 text-xs leading-4 text-token-description-foreground">⌘⌃E</span>
    </div>
  );
}

export function NfmTextActionMenuSurface({
  currentBlockTypeLabel,
  blockTypeItems,
  activeStyles,
  textColor,
  backgroundColor,
  canUseTextColor,
  canUseBackgroundColor,
  canClearFormat,
  canConvertToEquation = false,
  linkControl,
  nodexRows,
  showReferenceMocks = false,
  sourceProjectId = null,
  sourcePageId = null,
  sendToThreadProjectNameById,
  sendToThreadPreferredTarget = null,
  onSelectBlockType,
  onToggleStyle,
  onSetTextColor,
  onSetBackgroundColor,
  onClearFormat,
  onConvertToEquation = noopTextAction,
  onOpenBlockActions,
  onMoveBlocksToDestination,
  onSendBlocksToThread,
  onSelectionPresentationChange,
  renderMoveToMenu,
  renderSendToThreadMenu,
}: NfmTextActionMenuSurfaceProps) {
  const showAiPane = showReferenceMocks || nodexRows.length > 0;
  const selectionPresentationOwnersRef = useRef(new Set<TextActionSelectionPresentationOwner>());
  const nodexActionCloseLeaseRef = useRef(0);
  const surfaceMountedRef = useRef(true);
  const selectionPresentationChangeRef = useRef(onSelectionPresentationChange);
  useLayoutEffect(() => {
    selectionPresentationChangeRef.current = onSelectionPresentationChange;
  }, [onSelectionPresentationChange]);
  const reportSelectionPresentation = useCallback(
    (presentation: NfmRetainedSelectionPresentation) => {
      selectionPresentationChangeRef.current?.(presentation);
    },
    [],
  );

  useLayoutEffect(() => {
    surfaceMountedRef.current = true;
    return () => {
      surfaceMountedRef.current = false;
      reportSelectionPresentation("none");
    };
  }, [reportSelectionPresentation]);

  const handleSelectionPresentationOwnerChange = useCallback(
    (owner: TextActionSelectionPresentationOwner, active: boolean) => {
      if (!surfaceMountedRef.current) return;

      if (active) {
        selectionPresentationOwnersRef.current.add(owner);
      } else {
        selectionPresentationOwnersRef.current.delete(owner);
      }
      const activePresentations = Array.from(selectionPresentationOwnersRef.current).map(
        (activeOwner) => TEXT_ACTION_SELECTION_PRESENTATION_BY_OWNER[activeOwner],
      );
      reportSelectionPresentation(
        activePresentations.includes("blocks")
          ? "blocks"
          : activePresentations.includes("inline")
            ? "inline"
            : "none",
      );
    },
    [reportSelectionPresentation],
  );

  const handleToolbarFocusCapture = () => {
    handleSelectionPresentationOwnerChange("toolbar-focus", true);
  };

  const handleToolbarBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    handleSelectionPresentationOwnerChange("toolbar-focus", false);
  };

  const handleBlockTypeOpenChange = useCallback(
    (open: boolean) => handleSelectionPresentationOwnerChange("block-type", open),
    [handleSelectionPresentationOwnerChange],
  );
  const handleColorOpenChange = useCallback(
    (open: boolean) => handleSelectionPresentationOwnerChange("color", open),
    [handleSelectionPresentationOwnerChange],
  );
  const handleNodexActionPopoverOpenChange = useCallback(
    (open: boolean) => {
      const lease = ++nodexActionCloseLeaseRef.current;
      if (open) {
        handleSelectionPresentationOwnerChange("nodex-action", true);
        return;
      }

      // Moving between sibling action popovers closes the old surface before
      // opening the new one. Defer release for one microtask so the editor's
      // retained selection does not visibly disappear during that handoff.
      queueMicrotask(() => {
        if (nodexActionCloseLeaseRef.current !== lease) return;
        handleSelectionPresentationOwnerChange("nodex-action", false);
      });
    },
    [handleSelectionPresentationOwnerChange],
  );

  return (
    <div className="pointer-events-none p-4" contentEditable={false}>
      <div
        className="pointer-events-auto flex w-[192px] flex-col items-stretch overflow-hidden rounded-[14px] bg-token-dropdown-background p-2 text-sm leading-[1.2] text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
        role="toolbar"
        aria-label="Text actions"
        onFocusCapture={handleToolbarFocusCapture}
        onBlurCapture={handleToolbarBlurCapture}
      >
        <TextActionBlockTypeMenu
          currentBlockTypeLabel={currentBlockTypeLabel}
          blockTypeItems={blockTypeItems}
          onSelectBlockType={onSelectBlockType}
          onOpenChange={handleBlockTypeOpenChange}
        />
        <TextActionDivider />

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <TextActionColorMenu
              canUseTextColor={canUseTextColor}
              canUseBackgroundColor={canUseBackgroundColor}
              textColor={textColor}
              backgroundColor={backgroundColor}
              onSetTextColor={onSetTextColor}
              onSetBackgroundColor={onSetBackgroundColor}
              onOpenChange={handleColorOpenChange}
            />
            <TextActionButtonTooltip label={TEXT_ACTION_STYLE_LABELS.bold}>
              <TextActionButton
                label={TEXT_ACTION_STYLE_LABELS.bold}
                selected={activeStyles.bold}
                onActivate={() => onToggleStyle("bold")}
              >
                <TextActionBoldIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
            <TextActionButtonTooltip label={TEXT_ACTION_STYLE_LABELS.italic}>
              <TextActionButton
                label={TEXT_ACTION_STYLE_LABELS.italic}
                selected={activeStyles.italic}
                onActivate={() => onToggleStyle("italic")}
              >
                <TextActionItalicIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
            <TextActionButtonTooltip label={TEXT_ACTION_STYLE_LABELS.underline}>
              <TextActionButton
                label={TEXT_ACTION_STYLE_LABELS.underline}
                selected={activeStyles.underline}
                onActivate={() => onToggleStyle("underline")}
              >
                <TextActionUnderlineIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
            <TextActionButtonTooltip label="Clear format">
              <TextActionButton
                label="Clear format"
                className="w-7"
                disabled={!canClearFormat}
                onActivate={onClearFormat}
              >
                <TextActionClearFormatIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
          </div>
          <div className="flex items-center gap-1">
            {linkControl ?? (
              <TextActionDisabledButton label="Link">
                <TextActionLinkIcon />
              </TextActionDisabledButton>
            )}
            <TextActionButtonTooltip label={TEXT_ACTION_STYLE_LABELS.strike}>
              <TextActionButton
                label={TEXT_ACTION_STYLE_LABELS.strike}
                selected={activeStyles.strike}
                onActivate={() => onToggleStyle("strike")}
              >
                <TextActionStrikeIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
            <TextActionButtonTooltip label={TEXT_ACTION_STYLE_LABELS.code}>
              <TextActionButton
                label={TEXT_ACTION_STYLE_LABELS.code}
                selected={activeStyles.code}
                onActivate={() => onToggleStyle("code")}
              >
                <CodeIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
            <TextActionButtonTooltip label="Equation">
              <TextActionButton
                label="Equation"
                disabled={!canConvertToEquation}
                onActivate={onConvertToEquation}
              >
                <TextActionEquationIcon />
              </TextActionButton>
            </TextActionButtonTooltip>
            <TextActionMoreButton onOpenBlockActions={onOpenBlockActions} />
          </div>
        </div>

        {showReferenceMocks ? (
          <>
            <TextActionDivider />
            <div className="flex items-center">
              <TextActionDisabledButton
                label="Write a comment"
                className="min-w-0 flex-1 justify-start gap-2 px-1.5"
                mock
              >
                <TextActionCommentIcon />
                <span className="truncate">Comment</span>
                <TextActionMockBadge reason="Mock UI only. Not available in Nodex yet." />
              </TextActionDisabledButton>
              <TextActionDisabledButton label="Reaction" mock>
                <TextActionReactionIcon />
              </TextActionDisabledButton>
              <TextActionDisabledButton label="Comment pencil" mock>
                <TextActionCommentPencilIcon />
              </TextActionDisabledButton>
            </div>
            <TextActionDivider compact />
          </>
        ) : showAiPane ? (
          <TextActionDivider />
        ) : null}

        {showAiPane ? (
          <TextActionAiPane
            nodexRows={nodexRows}
            showReferenceMocks={showReferenceMocks}
            sourceProjectId={sourceProjectId}
            sourcePageId={sourcePageId}
            sendToThreadProjectNameById={sendToThreadProjectNameById}
            sendToThreadPreferredTarget={sendToThreadPreferredTarget}
            onMoveBlocksToDestination={onMoveBlocksToDestination}
            onSendBlocksToThread={onSendBlocksToThread}
            onActionPopoverOpenChange={handleNodexActionPopoverOpenChange}
            renderMoveToMenu={renderMoveToMenu}
            renderSendToThreadMenu={renderSendToThreadMenu}
          />
        ) : null}
        {showReferenceMocks ? <TextActionAiFooter /> : null}
      </div>
    </div>
  );
}

export function NfmTextActionMenu() {
  const editor = useBlockNoteEditor();
  const formattingToolbar = useExtension(FormattingToolbarExtension, {
    editor,
  });
  const runtime = useNfmTextActionMenuRuntime();
  const sideMenuOpenController = useNfmSideMenuOpenController();
  const [selectionPresentationState, setSelectionPresentationState] = useState<{
    presentation: NfmRetainedSelectionPresentation;
    retainedBlockIds: readonly string[];
  }>({ presentation: "none", retainedBlockIds: [] });
  const snapshot = useEditorState({
    editor,
    selector: ({ editor }) =>
      createTextActionMenuSnapshot(editor as unknown as TextActionSnapshotEditor),
  });
  const selectionPresentation = selectionPresentationState.presentation;
  const commandBlockIds =
    selectionPresentation === "blocks"
      ? selectionPresentationState.retainedBlockIds
      : snapshot.selectedBlockIds;
  useNfmRetainedSelectionPresentation(
    snapshot.eligible ? selectionPresentation : "none",
    NFM_TEXT_ACTION_MENU_SELECTION_KEY,
    commandBlockIds,
  );

  const nodexRows = useMemo(
    () =>
      resolveNodexTextActionRows({
        currentBlockId: snapshot.currentBlockId,
        canSendBlocks: runtime.canSendBlocks && Boolean(runtime.onMoveBlocksToDestination),
        canSendToThread: runtime.canSendBlocks && Boolean(runtime.onSendBlocksToThread),
      }),
    [
      runtime.canSendBlocks,
      runtime.onMoveBlocksToDestination,
      runtime.onSendBlocksToThread,
      snapshot.currentBlockId,
    ],
  );

  if (!snapshot.eligible) {
    return null;
  }

  const selectBlockType = (item: TextActionBlockTypeItem) => {
    const selectedBlocks = selectCurrentBlocks(editor as unknown as TextActionSnapshotEditor);

    applyTextActionBlockType(
      editor as TextActionEditorAdapter,
      selectedBlocks,
      item as TextActionBlockTypeUpdate,
    );
  };

  const toggleStyle = (style: TextActionBasicStyle) => {
    applyTextActionToggleStyle(editor as TextActionEditorAdapter, style);
  };

  const setTextColor = (color: TextActionColorValue) => {
    applyTextActionStringStyle(
      editor as TextActionEditorAdapter,
      "textColor",
      color,
      snapshot.canUseTextColor,
      () => undefined,
    );
  };

  const setBackgroundColor = (color: TextActionColorValue) => {
    applyTextActionStringStyle(
      editor as TextActionEditorAdapter,
      "backgroundColor",
      color,
      snapshot.canUseBackgroundColor,
      () => undefined,
    );
  };

  const clearFormat = () => {
    applyTextActionClearFormat(editor as TextActionEditorAdapter, TEXT_ACTION_BASIC_STYLES, {
      canUseTextColor: snapshot.canUseTextColor,
      canUseBackgroundColor: snapshot.canUseBackgroundColor,
    });
  };

  const convertToEquation = () => {
    if (!insertInlineMath(editor)) return;
    formattingToolbar.store.setState(false);
  };

  const openBlockActions = (fallbackAnchorRect?: NfmSideMenuRect) => {
    const opened = sideMenuOpenController.openForCurrentSelection({
      anchorRect: fallbackAnchorRect,
      returnFocusElement: editor.prosemirrorView?.dom ?? null,
    });
    if (!opened) return;

    formattingToolbar.store.setState(false);
  };

  const handleMoveBlocksToDestination = async (destination: NfmMoveToDestination) => {
    if (commandBlockIds.length === 0) return;
    await runtime.onMoveBlocksToDestination?.(destination, commandBlockIds);
  };

  const handleSendBlocksToThread = async (request: NfmSendToThreadRequest) => {
    if (commandBlockIds.length === 0) return;
    await runtime.onSendBlocksToThread?.(request, commandBlockIds);
  };

  const handleSelectionPresentationChange = (presentation: NfmRetainedSelectionPresentation) => {
    setSelectionPresentationState((current) => {
      if (current.presentation === presentation) return current;
      return {
        presentation,
        retainedBlockIds:
          presentation === "blocks" ? snapshot.selectedBlockIds : current.retainedBlockIds,
      };
    });
  };

  return (
    <NfmTextActionMenuSurface
      currentBlockTypeLabel={snapshot.currentBlockTypeLabel}
      blockTypeItems={snapshot.blockTypeItems}
      activeStyles={snapshot.activeStyles}
      textColor={snapshot.textColor}
      backgroundColor={snapshot.backgroundColor}
      canUseTextColor={snapshot.canUseTextColor}
      canUseBackgroundColor={snapshot.canUseBackgroundColor}
      canClearFormat={snapshot.canClearFormat}
      canConvertToEquation={snapshot.canConvertToEquation}
      linkControl={<NfmCreateLinkButton renderTrigger={renderCreateLinkTrigger} />}
      nodexRows={nodexRows}
      showReferenceMocks={import.meta.env.DEV}
      sourceProjectId={runtime.sourceProjectId ?? null}
      sourcePageId={runtime.sourcePageId ?? null}
      sendToThreadProjectNameById={runtime.sendToThreadProjectNameById}
      sendToThreadPreferredTarget={runtime.sendToThreadPreferredTarget ?? null}
      onSelectBlockType={selectBlockType}
      onToggleStyle={toggleStyle}
      onSetTextColor={setTextColor}
      onSetBackgroundColor={setBackgroundColor}
      onClearFormat={clearFormat}
      onConvertToEquation={convertToEquation}
      onOpenBlockActions={openBlockActions}
      onMoveBlocksToDestination={handleMoveBlocksToDestination}
      onSendBlocksToThread={handleSendBlocksToThread}
      onSelectionPresentationChange={handleSelectionPresentationChange}
    />
  );
}
