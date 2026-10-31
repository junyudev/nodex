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
  ActivitySpinnerIcon,
  TextActionBoldIcon,
  TextActionClearFormatIcon,
  TextActionEllipsisIcon,
  TextActionEquationIcon,
  TextActionItalicIcon,
  TextActionLinkIcon,
  TextActionStrikeIcon,
  TextActionUnderlineIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import { CornerDownRight, MessageCirclePlusIcon } from "@/components/shared/icons/generic-icons";
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
import { reportNfmChatSendFailure } from "./nfm-chat-send-feedback";
import { NfmSendToThreadMenu } from "./nfm-send-to-thread-menu";
import {
  describeNfmSendToThreadPreferredTarget,
  resolveNfmSendToThreadPreferredDestination,
  type NfmSendToThreadPreferredTarget,
  type NfmSendToThreadRequest,
} from "./nfm-send-to-thread-menu-model";
import { useNfmSideMenuOpenController } from "./nfm-side-menu";
import type { NfmSideMenuRect } from "./nfm-side-menu-anchor";
import {
  NFM_ADD_TO_COMPOSER_SHORTCUT_LABEL,
  NFM_SEND_TO_CHAT_SHORTCUT_LABEL,
} from "./nfm-chat-send-shortcuts";
import {
  isBlockLevelSelection,
  shouldUseTextActionMenu,
  TEXT_ACTION_BASIC_STYLES,
  TEXT_ACTION_NOTION_COLOR_ORDER,
  TEXT_ACTION_COLOR_VALUES,
  type TextActionBasicStyle,
  type TextActionColorValue,
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

/** Chat actions for the selection: send it, or add it to the beside chat's composer. */
export interface TextActionChat {
  readonly projectId: string | null;
  readonly sourcePageId?: string | null;
  readonly projectNameById?: Readonly<Record<string, string>>;
  /** The chat this Page is shown beside. Send goes there without a picker. */
  readonly contextualTarget: NfmSendToThreadPreferredTarget | null;
  readonly onSend: (request: NfmSendToThreadRequest) => Promise<void> | void;
  readonly onAddToComposer?: () => Promise<void> | void;
}

interface TextActionSendToThreadMenuRenderProps {
  projectId: string | null;
  sourcePageId?: string | null;
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
  chat?: TextActionChat | null;
  onSelectBlockType: (item: TextActionBlockTypeItem) => void;
  onToggleStyle: (style: TextActionBasicStyle) => void;
  onSetTextColor: (color: TextActionColorValue) => void;
  onSetBackgroundColor: (color: TextActionColorValue) => void;
  onClearFormat: () => void;
  onConvertToEquation?: () => void;
  onOpenBlockActions: (fallbackAnchorRect?: NfmSideMenuRect) => void;
  onSelectionPresentationChange?: (presentation: NfmRetainedSelectionPresentation) => void;
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
  { key: "prompt", label: "Prompt", type: "prompt" },
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
  if (item.key === "prompt") return <CornerDownRight className="size-5" />;

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
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <NodexTooltip tooltipContent={`${label} is not supported in Nodex yet.`} side="top" delay={0}>
      <TextActionButton label={label} disabled className={className}>
        {children}
      </TextActionButton>
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

function TextActionChatRow({
  icon,
  label,
  shortcut,
  tooltip = label,
  pending = false,
  hasPopup,
  expanded,
  trailing,
  onActivate,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  tooltip?: ReactNode;
  pending?: boolean;
  hasPopup?: "dialog";
  expanded?: boolean;
  trailing?: ReactNode;
  onActivate: () => void;
}) {
  const row = (
    <TextActionButton
      label={label}
      hasPopup={hasPopup}
      expanded={expanded}
      aria-busy={pending || undefined}
      className="w-auto min-w-0 flex-1 justify-start gap-2 px-1.5"
      onActivate={onActivate}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </TextActionButton>
  );
  // The toolbar is too narrow for shortcut hints beside labels, so tooltips carry them.
  return (
    <NodexTooltip tooltipContent={tooltip} shortcutLabel={shortcut} side="top" delay={0}>
      {row}
    </NodexTooltip>
  );
}

/** The send glyph shared with the chat composer: an up arrow on the composer's primary fill. */
function TextActionSendGlyph({ pending }: { pending: boolean }) {
  return (
    <span className="flex size-[18px] items-center justify-center rounded-full bg-composer-primary text-composer-primary">
      {pending ? <ActivitySpinnerIcon className="size-3" /> : <UpArrowIcon className="size-3" />}
    </span>
  );
}

function TextActionChatSection({
  chat,
  renderSendToThreadMenu,
  onPickerOpenChange,
}: {
  chat: TextActionChat;
  renderSendToThreadMenu?: (props: TextActionSendToThreadMenuRenderProps) => ReactNode;
  onPickerOpenChange: (open: boolean) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const contextualTarget = chat.contextualTarget;
  const onPickerOpenChangeRef = useRef(onPickerOpenChange);
  useLayoutEffect(() => {
    onPickerOpenChangeRef.current = onPickerOpenChange;
  }, [onPickerOpenChange]);
  // Only the section's own unmount closes its picker; parent rerenders replace the callback.
  useEffect(
    () => () => {
      onPickerOpenChangeRef.current(false);
    },
    [],
  );

  const setPicker = (open: boolean) => {
    setPickerOpen(open);
    onPickerOpenChange(open);
  };

  const run = async (kind: "send" | "add-to-composer", action: () => Promise<void> | void) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } catch (error) {
      reportNfmChatSendFailure(kind, error);
    } finally {
      setPending(false);
    }
  };

  const sendToContextualChat = () => {
    if (!contextualTarget) {
      setPicker(true);
      return;
    }
    void run("send", () =>
      chat.onSend({ target: resolveNfmSendToThreadPreferredDestination(contextualTarget) }),
    );
  };

  const menuProps: TextActionSendToThreadMenuRenderProps = {
    projectId: chat.projectId,
    sourcePageId: chat.sourcePageId ?? null,
    projectNameById: chat.projectNameById,
    preferredTarget: contextualTarget,
    onAccept: async (request) => {
      await chat.onSend(request);
      setPicker(false);
    },
    onClose: () => {
      setPicker(false);
      requestAnimationFrame(() => anchorRef.current?.focus());
    },
  };

  return (
    <div className="flex flex-col gap-px">
      <NodexPopover open={pickerOpen} onOpenChange={setPicker}>
        <NodexPopoverAnchor>
          <div ref={anchorRef} className="flex items-center gap-0.5" data-nfm-text-action-send>
            <TextActionChatRow
              icon={<TextActionSendGlyph pending={pending} />}
              label="Send to chat"
              shortcut={NFM_SEND_TO_CHAT_SHORTCUT_LABEL}
              pending={pending}
              tooltip={
                contextualTarget
                  ? `Send to ${describeNfmSendToThreadPreferredTarget(contextualTarget)}`
                  : undefined
              }
              hasPopup={contextualTarget ? undefined : "dialog"}
              expanded={contextualTarget ? undefined : pickerOpen}
              onActivate={sendToContextualChat}
            />
            {contextualTarget ? (
              <TextActionButtonTooltip label="Send to another chat">
                <TextActionButton
                  label="Send to another chat"
                  hasPopup="dialog"
                  expanded={pickerOpen}
                  className="w-6 px-0.5 text-token-text-secondary"
                  onActivate={() => setPicker(!pickerOpen)}
                >
                  <ChevronRightIcon className="size-4 shrink-0" />
                </TextActionButton>
              </TextActionButtonTooltip>
            ) : null}
          </div>
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
      {chat.onAddToComposer ? (
        <TextActionChatRow
          icon={<MessageCirclePlusIcon className="size-4 text-token-text-secondary" />}
          label="Add to composer"
          shortcut={NFM_ADD_TO_COMPOSER_SHORTCUT_LABEL}
          onActivate={() => {
            const addToComposer = chat.onAddToComposer;
            if (addToComposer) void run("add-to-composer", addToComposer);
          }}
        />
      ) : null}
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
  chat = null,
  onSelectBlockType,
  onToggleStyle,
  onSetTextColor,
  onSetBackgroundColor,
  onClearFormat,
  onConvertToEquation = noopTextAction,
  onOpenBlockActions,
  onSelectionPresentationChange,
  renderSendToThreadMenu,
}: NfmTextActionMenuSurfaceProps) {
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
        {chat ? (
          <>
            <TextActionChatSection
              chat={chat}
              renderSendToThreadMenu={renderSendToThreadMenu}
              onPickerOpenChange={handleNodexActionPopoverOpenChange}
            />
            <TextActionDivider />
          </>
        ) : null}
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

  const runtimeChat = snapshot.currentBlockId ? runtime.chat : null;
  const chat: TextActionChat | null = runtimeChat
    ? {
        projectId: runtimeChat.projectId,
        sourcePageId: runtimeChat.sourcePageId ?? null,
        projectNameById: runtimeChat.projectNameById,
        contextualTarget: runtimeChat.contextualTarget,
        onSend: async (request) => {
          if (commandBlockIds.length === 0) return;
          await runtimeChat.send(request, commandBlockIds);
        },
        ...(runtimeChat.addToComposer
          ? {
              onAddToComposer: async () => {
                if (commandBlockIds.length === 0) return;
                await runtimeChat.addToComposer?.(commandBlockIds);
              },
            }
          : {}),
      }
    : null;

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
      chat={chat}
      onSelectBlockType={selectBlockType}
      onToggleStyle={toggleStyle}
      onSetTextColor={setTextColor}
      onSetBackgroundColor={setBackgroundColor}
      onClearFormat={clearFormat}
      onConvertToEquation={convertToEquation}
      onOpenBlockActions={openBlockActions}
      onSelectionPresentationChange={handleSelectionPresentationChange}
    />
  );
}
