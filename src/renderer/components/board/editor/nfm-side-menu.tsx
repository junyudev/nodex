import { blockHasType, editorHasBlockWithType } from "@blocknote/core";
import {
  FormattingToolbarExtension,
  SideMenuExtension,
  SuggestionMenu,
} from "@blocknote/core/extensions";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState,
  useExtension,
  useExtensionState,
  type FloatingUIOptions,
} from "@blocknote/react";
import { offset, shift, size } from "@floating-ui/react";

import {
  Fragment,
  createContext,
  forwardRef,
  useContext,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CheckmarkIcon,
  CopyIcon,
  CodeIcon,
  DownloadIcon,
  DragHandleDotsIcon,
  ExpandPanelIcon,
  NfmSideMenuAiFaceIcon,
  NfmSideMenuChevronRightIcon,
  NfmSideMenuColorIcon,
  NfmSideMenuCommentIcon,
  NfmSideMenuCopyLinkIcon,
  NfmSideMenuDeleteIcon,
  NfmSideMenuDuplicateIcon,
  NfmSideMenuMoveToIcon,
  NfmSideMenuPageInIcon,
  NfmSideMenuPlayIcon,
  NfmSideMenuSuggestEditsIcon,
  NfmSideMenuTableHeaderIcon,
  NfmSideMenuTurnIntoIcon,
  PlusIcon,
  ReviewEnableWordWrapIcon,
} from "@/components/shared/icons";
import { WandSparkles } from "@/components/shared/icons/generic-icons";
import { NodexPopover, NodexPopoverAnchor } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { claimEditorSelectionSurface } from "@/lib/editor-selection-presentation";
import { writeTextToClipboard } from "@/lib/clipboard";
import { canFormatCodeLanguage, getCodeBlockPlainText } from "@/lib/nfm/code-block-model";
import { codeBlockViewState } from "@/lib/nfm/code-block-view-state";
import { formatCode } from "@/lib/nfm/code-formatters";
import { codeLanguagePreference } from "@/lib/nfm/code-language-preference";
import { cn } from "@/lib/utils";
import { hasTypedOwnerBlock } from "@/lib/typed-owner-blocks";
import { NFM_TURN_INTO_DEFINITIONS } from "@/lib/nfm-turn-into-targets";
import type { LibraryStructuralTurnIntoTarget } from "../../../../shared/library-module";
import {
  CODE_LANGUAGE_CATALOG,
  normalizeCodeLanguageId,
} from "../../../../shared/nfm/code-language-catalog";
import { NfmEditorPopoverContent } from "./nfm-editor-popover-content";
import { NfmStructuredClipboardExtension, type NfmClipboardCommand } from "./nfm-editor-extensions";
import { NfmFloatingPopover, type NfmPopoverReference } from "./nfm-floating-popover";
import { NfmMoveToMenu } from "./nfm-move-to-menu";
import { NfmTurnIntoBlockIcon, type NfmTurnIntoBlockKey } from "./nfm-turn-into-block-icon";
import type { NfmMoveToDestination, NfmMoveToResultScope } from "./nfm-move-to-menu-model";
import {
  buildNfmSideMenuSections,
  filterNfmSideMenuSections,
  flattenNfmSideMenuRows,
  getInitialNfmSideMenuFocusIndex,
  moveNfmSideMenuFocus,
  resolveNfmSideMenuScopeTitle,
  shouldRenderNfmSideMenuSeparatorBefore,
  type NfmSideMenuAction,
  type NfmSideMenuActionKey,
  type NfmSideMenuFlatRow,
  type NfmSideMenuSection,
  type NfmSideMenuSubmenuKey,
  type NfmSideMenuTargetBlockDescriptor,
} from "./nfm-side-menu-model";
import {
  createNfmSideMenuElementReference,
  resolveNfmSideMenuReference,
  NFM_SIDE_MENU_GAP,
  NFM_SIDE_MENU_MAX_HEIGHT_VH,
  NFM_SIDE_MENU_VIEWPORT_MARGIN,
  NFM_SIDE_MENU_WIDTH,
  type NfmSideMenuRect,
} from "./nfm-side-menu-anchor";
import { useNfmSideMenuRuntime } from "./nfm-side-menu-runtime";
import { downloadMermaidDiagram, readReadyMermaidSvg } from "./mermaid-code-preview";
import {
  applySideMenuSelectionIntent,
  createSideMenuDragSelectionSnapshot,
  createSideMenuSelectionIntent,
  type SideMenuDragSelectionSnapshot,
  type SideMenuSelectionEditor,
  type SideMenuSelectionIntent,
} from "./nfm-side-menu-selection";
import { createSideMenuFreezeController } from "./side-menu-freeze-controller";

interface SideMenuBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: SideMenuBlock[];
}

interface SideMenuEditorRuntime extends SideMenuSelectionEditor {
  domElement?: HTMLElement | null;
  isEditable?: boolean;
  getBlock?: (blockId: string) => SideMenuBlock | undefined;
  getParentBlock?: (blockId: string) => unknown;
  getSelection?: () => { blocks?: SideMenuBlock[] } | undefined;
  getTextCursorPosition?: () => { block?: SideMenuBlock };
  setTextCursorPosition?: (block: SideMenuBlock | string, placement?: "start" | "end") => void;
  insertBlocks?: (
    blocks: unknown[],
    referenceBlock: unknown,
    placement: "before" | "after" | "nested",
  ) => unknown[];
  removeBlocks?: (blocks: unknown[]) => void;
  updateBlock?: (block: unknown, update: unknown) => void;
  transact?: <T>(callback: () => T) => T;
  focus?: () => void;
  settings?: {
    tables?: {
      headers?: boolean;
    };
  };
  prosemirrorView?: SideMenuSelectionEditor["prosemirrorView"] & {
    dom?: HTMLElement;
    editable?: boolean;
    focus?: () => void;
  };
  schema: {
    blockSpecs: Record<string, { implementation: { meta?: { fileBlockAccept?: boolean } } }>;
    acceptsBlockChildren: (block: { type: string; props?: Record<string, unknown> }) => boolean;
  };
}

interface SideMenuDragStartEvent {
  dataTransfer: DataTransfer | null;
  clientY: number;
  selectedBlockIds?: string[];
  selectionFrom?: number;
  selectionTo?: number;
}

interface NfmSideMenuOpenState {
  block: SideMenuBlock;
  reference: NfmPopoverReference;
  returnFocusElement: HTMLElement | null;
  outsidePressIgnoreElement: HTMLElement | null;
  selectionIntent: SideMenuSelectionIntent;
}

export type NfmSideMenuCloseReason =
  | "action"
  | "clipboard-command"
  | "escape"
  | "editor-outside-pointer"
  | "outside-pointer";

interface NfmSideMenuOpenBlockInput {
  block: SideMenuBlock;
  reference: NfmPopoverReference;
  returnFocusElement: HTMLElement | null;
  outsidePressIgnoreElement?: HTMLElement | null;
  selectionIntent?: SideMenuSelectionIntent | null;
  freezeSideMenu?: boolean;
}

interface NfmSideMenuOpenSelectionInput {
  anchorRect?: NfmSideMenuRect | null;
  returnFocusElement?: HTMLElement | null;
  outsidePressIgnoreElement?: HTMLElement | null;
}

interface NfmSideMenuOpenController {
  acquireSideMenuFreeze: () => () => void;
  openBlockId: string | null;
  openForBlock: (input: NfmSideMenuOpenBlockInput) => boolean;
  openForCurrentSelection: (input?: NfmSideMenuOpenSelectionInput) => boolean;
  formattingToolbarSuppressionRange: NfmSideMenuSelectionRange | null;
}

export interface NfmSideMenuSelectionRange {
  from: number;
  to: number;
}

interface NfmSideMenuColorOption {
  color: NfmSideMenuColorValue;
  label: string;
}

interface NfmSideMenuTurnIntoItem {
  key: NfmTurnIntoBlockKey;
  label: string;
  type: string;
  props?: Record<string, boolean | number | string>;
  target?: LibraryStructuralTurnIntoTarget;
  enabled: boolean;
}

type NfmSideMenuColorValue =
  | "default"
  | "gray"
  | "brown"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink";

interface NfmSideMenuSurfaceProps {
  sections: NfmSideMenuSection[];
  query: string;
  focusedIndex: number;
  activeSubmenu: NfmSideMenuSubmenuKey | null;
  listboxId: string;
  comboboxId: string;
  activeDescendantId: string | undefined;
  turnIntoItems: NfmSideMenuTurnIntoItem[];
  colorOptions: NfmSideMenuColorOption[];
  canUseTextColor: boolean;
  canUseBackgroundColor: boolean;
  canSendBlocks: boolean;
  sourceProjectId: string | null;
  sourcePageId: string | null;
  textColor: string;
  backgroundColor: string;
  codeLanguageId: string;
  footerPrimary: string | null;
  footerSecondary: string | null;
  onQueryChange: (query: string) => void;
  onFocusIndexChange: (index: number) => void;
  onMoveFocus: (direction: 1 | -1) => void;
  onActivateFocused: () => void;
  onClose: () => void;
  onAction: (row: NfmSideMenuAction) => void;
  onSubmenuChange: (submenu: NfmSideMenuSubmenuKey | null) => void;
  onTurnInto: (item: NfmSideMenuTurnIntoItem) => void;
  onColor: (kind: "text" | "background", color: NfmSideMenuColorValue) => void;
  onCodeLanguageChange: (languageId: string) => void;
  onClipboardCommand?: (command: NfmClipboardCommand, clipboardEvent: ClipboardEvent) => boolean;
  onMoveBlocksToDestination: (destination: NfmMoveToDestination) => Promise<void> | void;
  renderMoveToMenu?: (props: {
    sourceProjectId: string | null;
    sourcePageId: string | null;
    onAccept: (destination: NfmMoveToDestination) => Promise<void> | void;
    onClose: () => void;
    resultScope?: NfmMoveToResultScope;
    ariaLabel?: string;
    placeholder?: string;
  }) => ReactNode;
}

const SIDE_MENU_CLICK_TOLERANCE = 4;
const SIDE_MENU_SHORTCUT_KEY = "/";
const SIDE_MENU_SUBMENU_SELECTOR = "[data-nfm-side-menu-submenu='true']";
const SIDE_MENU_MOTION_DURATION_MS = 200;
const SIDE_MENU_MOTION_DELAY_MS = 30;
const SIDE_MENU_EXIT_FALLBACK_MS = SIDE_MENU_MOTION_DURATION_MS + SIDE_MENU_MOTION_DELAY_MS + 50;
const SIDE_MENU_CLOSED_SCALE = 0.97;
const SIDE_MENU_COLOR_VALUES = [
  "default",
  "gray",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const satisfies readonly NfmSideMenuColorValue[];

const DEFAULT_SIDE_MENU_OPEN_CONTROLLER: NfmSideMenuOpenController = {
  acquireSideMenuFreeze: () => () => undefined,
  openBlockId: null,
  openForBlock: () => false,
  openForCurrentSelection: () => false,
  formattingToolbarSuppressionRange: null,
};

const NfmSideMenuOpenContext = createContext<NfmSideMenuOpenController>(
  DEFAULT_SIDE_MENU_OPEN_CONTROLLER,
);

const SIDE_MENU_COLOR_LABELS = {
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
} as const satisfies Record<NfmSideMenuColorValue, string>;

const SIDE_MENU_COLOR_STYLES = {
  default: "transparent",
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
} as const satisfies Record<NfmSideMenuColorValue, string>;

const SIDE_MENU_BACKGROUND_COLOR_STYLES = {
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
} as const satisfies Record<NfmSideMenuColorValue, string>;

function toStringProp(props: Record<string, unknown> | undefined, key: string): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function toNumberProp(props: Record<string, unknown> | undefined, key: string): number | null {
  const value = props?.[key];
  return typeof value === "number" ? value : null;
}

function normalizeColorValue(value: unknown): NfmSideMenuColorValue {
  return SIDE_MENU_COLOR_VALUES.includes(value as NfmSideMenuColorValue)
    ? (value as NfmSideMenuColorValue)
    : "default";
}

function propsToSchemaShape(props?: Record<string, boolean | number | string>) {
  return Object.fromEntries(
    Object.entries(props ?? {}).map(([key, value]) => [key, typeof value]),
  ) as Record<string, "boolean" | "number" | "string">;
}

function getSideMenuActionBlocks(openState: NfmSideMenuOpenState, fallbackBlock: SideMenuBlock) {
  return openState.selectionIntent.blocks.length > 0
    ? (openState.selectionIntent.blocks as SideMenuBlock[])
    : [fallbackBlock];
}

export function shouldCloseNfmSideMenuForPointerTarget({
  target,
  popupElement,
  outsidePressIgnoreElement,
}: {
  target: EventTarget | null;
  popupElement: HTMLElement | null;
  outsidePressIgnoreElement: HTMLElement | null;
}) {
  if (!(target instanceof Node)) return false;
  if (getClosestElement(target)?.closest(SIDE_MENU_SUBMENU_SELECTOR)) return false;
  if (popupElement?.contains(target)) return false;
  if (outsidePressIgnoreElement?.contains(target)) return false;
  return true;
}

export function shouldConsumeNfmSideMenuOutsidePointerTarget({
  target,
  editorRoot,
}: {
  target: EventTarget | null;
  editorRoot: HTMLElement | null;
}) {
  if (!editorRoot || !(target instanceof Node)) return false;
  return editorRoot.contains(target);
}

export function shouldReturnFocusAfterNfmSideMenuClose({
  reason,
  returnFocusElement,
}: {
  reason: NfmSideMenuCloseReason;
  returnFocusElement: HTMLElement | null;
}) {
  if (!returnFocusElement) return false;
  return reason !== "outside-pointer";
}

export function resolveNfmSideMenuReturnFocusElement({
  reason,
  returnFocusElement,
  editorRoot,
}: {
  reason: NfmSideMenuCloseReason;
  returnFocusElement: HTMLElement | null;
  editorRoot: HTMLElement | null;
}) {
  if (reason === "clipboard-command" || reason === "editor-outside-pointer") return editorRoot;
  return returnFocusElement;
}

export function resolveNfmSideMenuFormattingToolbarSuppressionRange({
  reason,
  selectionRange,
}: {
  reason: NfmSideMenuCloseReason;
  selectionRange: NfmSideMenuSelectionRange | null;
}) {
  if (reason === "action" || reason === "clipboard-command") return null;
  if (!selectionRange) return null;
  if (selectionRange.from === selectionRange.to) return null;
  return selectionRange;
}

export function shouldKeepNfmSideMenuFormattingToolbarSuppression({
  selectionRange,
  suppressionRange,
}: {
  selectionRange: NfmSideMenuSelectionRange;
  suppressionRange: NfmSideMenuSelectionRange | null;
}) {
  return (
    suppressionRange !== null &&
    selectionRange.from === suppressionRange.from &&
    selectionRange.to === suppressionRange.to
  );
}

function getTopLevelSideMenuActionBlocks(blocks: SideMenuBlock[]) {
  const selectedDescendantIds = new Set<string>();

  const addDescendantIds = (children: SideMenuBlock[] | undefined) => {
    for (const childBlock of children ?? []) {
      const childBlockId = getCurrentBlockId(childBlock);
      if (childBlockId) selectedDescendantIds.add(childBlockId);
      addDescendantIds(childBlock.children);
    }
  };

  for (const block of blocks) {
    addDescendantIds(block.children);
  }

  return blocks.filter((block) => {
    const blockId = getCurrentBlockId(block);
    return !blockId || !selectedDescendantIds.has(blockId);
  });
}

function cloneBlockForInsert(block: SideMenuBlock): Record<string, unknown> {
  const rest = { ...block } as Record<string, unknown>;
  delete rest.id;
  delete rest.children;
  return {
    ...rest,
    ...(block.children ? { children: block.children.map(cloneBlockForInsert) } : {}),
  };
}

function getCurrentBlockId(block: SideMenuBlock) {
  return typeof block.id === "string" && block.id.length > 0 ? block.id : null;
}

function toSideMenuTargetBlockDescriptor(block: SideMenuBlock): NfmSideMenuTargetBlockDescriptor {
  return {
    id: getCurrentBlockId(block),
    type: typeof block.type === "string" ? block.type : null,
    props: block.props,
  };
}

function getEditorEditable(editor: SideMenuEditorRuntime) {
  if (editor.isEditable === false) return false;
  if (editor.prosemirrorView?.editable === false) return false;
  return true;
}

function supportsBlockColor(editor: SideMenuEditorRuntime, block: SideMenuBlock) {
  if (!block.type) {
    return {
      text: false,
      background: false,
    };
  }

  const text =
    blockHasType(
      block as Parameters<typeof blockHasType>[0],
      editor as Parameters<typeof blockHasType>[1],
      block.type,
      { textColor: "string" },
    ) &&
    editorHasBlockWithType(editor as Parameters<typeof editorHasBlockWithType>[0], block.type, {
      textColor: "string",
    });
  const background =
    blockHasType(
      block as Parameters<typeof blockHasType>[0],
      editor as Parameters<typeof blockHasType>[1],
      block.type,
      { backgroundColor: "string" },
    ) &&
    editorHasBlockWithType(editor as Parameters<typeof editorHasBlockWithType>[0], block.type, {
      backgroundColor: "string",
    });

  return { text, background };
}

function getTurnIntoItems(
  editor: SideMenuEditorRuntime,
  selectedBlocks: readonly SideMenuBlock[],
): NfmSideMenuTurnIntoItem[] {
  return NFM_TURN_INTO_DEFINITIONS.map((item) => {
    const baseProps = "props" in item.localPatch ? item.localPatch.props : undefined;
    const props =
      item.key === "code" ? { ...baseProps, language: codeLanguagePreference.get() } : baseProps;
    const acceptsChildren = editor.schema.acceptsBlockChildren({
      type: item.localPatch.type,
      ...(props ? { props } : {}),
    });
    const wouldOrphanChildren =
      !acceptsChildren && selectedBlocks.some((block) => (block.children?.length ?? 0) > 0);
    return {
      key: item.key,
      label: item.label,
      type: item.localPatch.type,
      props,
      target: item.target,
      enabled:
        !wouldOrphanChildren &&
        editorHasBlockWithType(
          editor as Parameters<typeof editorHasBlockWithType>[0],
          item.localPatch.type,
          propsToSchemaShape(props),
        ),
    };
  });
}

function getBlockTypeIcon(item: NfmSideMenuTurnIntoItem) {
  return <NfmTurnIntoBlockIcon targetKey={item.key} />;
}

function getActionIcon(key: NfmSideMenuActionKey) {
  if (key === "copy-code") return <CopyIcon className="size-4" />;
  if (key === "expand-diagram") return <ExpandPanelIcon className="size-4" />;
  if (key === "download-diagram") return <DownloadIcon className="size-4" />;
  if (key === "wrap-code") return <ReviewEnableWordWrapIcon className="size-4" />;
  if (key === "code-language") return <CodeIcon />;
  if (key === "format-code") return <WandSparkles className="size-4" />;
  if (key === "turn-into") return <NfmSideMenuTurnIntoIcon />;
  if (key === "color") return <NfmSideMenuColorIcon />;
  if (key === "copy-link-to-block") return <NfmSideMenuCopyLinkIcon />;
  if (key === "duplicate") return <NfmSideMenuDuplicateIcon />;
  if (key === "move-to") return <NfmSideMenuMoveToIcon />;
  if (key === "delete") return <NfmSideMenuDeleteIcon />;
  if (key === "comment") return <NfmSideMenuCommentIcon />;
  if (key === "suggest-edits") return <NfmSideMenuSuggestEditsIcon />;
  if (key === "present-from-here") return <NfmSideMenuPlayIcon />;
  if (key === "ask-ai") return <NfmSideMenuAiFaceIcon />;
  if (key === "convert-divider-to-thread-section") return <CodeIcon />;
  return <NfmSideMenuTableHeaderIcon />;
}

function getOptionId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}

function keepEditorSelection(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) return;
  event.preventDefault();
}

function getClosestElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (!(target instanceof Node)) return null;
  return target.parentElement;
}

function focusNfmSideMenuReturnTarget(
  editor: SideMenuEditorRuntime,
  returnFocusElement: HTMLElement,
) {
  if (editor.domElement === returnFocusElement) {
    editor.focus?.();
    return;
  }

  try {
    returnFocusElement.focus({ preventScroll: true });
  } catch {
    returnFocusElement.focus();
  }
}

function getCurrentNfmSideMenuSelectionRange(
  editor: SideMenuEditorRuntime,
): NfmSideMenuSelectionRange | null {
  const selection = editor.prosemirrorView?.state.selection;
  if (!selection || selection.empty) return null;
  return {
    from: selection.from,
    to: selection.to,
  };
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function NfmAddBlockButton() {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const suggestionMenu = useExtension(SuggestionMenu);
  const SideMenuButton = Components.SideMenu.Button;
  type CursorTarget = Parameters<typeof editor.setTextCursorPosition>[0];
  const lastPointerActivationAtRef = useRef<number | null>(null);
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  }) as (CursorTarget & { content?: unknown[] }) | undefined;

  const activateAddBlock = useCallback(() => {
    if (!block) return;

    const blockContent = Array.isArray(block.content) ? block.content : [];
    if (blockContent.length === 0) {
      editor.setTextCursorPosition(block);
      suggestionMenu.openSuggestionMenu("/");
      return;
    }

    const insertedBlock = editor.insertBlocks([{ type: "paragraph" }], block, "after")[0];
    if (!insertedBlock) return;

    editor.setTextCursorPosition(insertedBlock);
    suggestionMenu.openSuggestionMenu("/");
  }, [block, editor, suggestionMenu]);

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;

      lastPointerActivationAtRef.current = performance.now();
      activateAddBlock();
    },
    [activateAddBlock],
  );

  const handleClick = useCallback(() => {
    const lastPointerActivationAt = lastPointerActivationAtRef.current;
    if (lastPointerActivationAt !== null && performance.now() - lastPointerActivationAt < 500) {
      lastPointerActivationAtRef.current = null;
      return;
    }

    activateAddBlock();
  }, [activateAddBlock]);

  if (!block) return null;

  return (
    <SideMenuButton
      className="bn-button nfm-side-menu-add-button size-6 cursor-pointer p-0 text-token-description-foreground transition-none"
      label={dict.side_menu.add_block_label}
      onClick={handleClick}
      onPointerUp={handlePointerUp}
      icon={
        <span className="pointer-events-none" data-test="dragHandleAdd">
          <PlusIcon className="icon-sm" />
        </span>
      }
    />
  );
}

function NfmSideMenuRow({
  row,
  index,
  listboxId,
  focused,
  activeSubmenu,
  onAction,
  onFocusIndexChange,
  onSubmenuChange,
  submenuContent,
}: {
  row: NfmSideMenuAction;
  index: number;
  listboxId: string;
  focused: boolean;
  activeSubmenu: NfmSideMenuSubmenuKey | null;
  onAction: (row: NfmSideMenuAction) => void;
  onFocusIndexChange: (index: number) => void;
  onSubmenuChange: (submenu: NfmSideMenuSubmenuKey | null) => void;
  submenuContent?: ReactNode;
}) {
  const rowElement = (
    <div
      id={getOptionId(listboxId, index)}
      role="option"
      aria-selected={focused}
      aria-disabled={!row.enabled || undefined}
      aria-haspopup={row.kind === "submenu" ? "dialog" : undefined}
      aria-expanded={row.kind === "submenu" ? activeSubmenu === row.submenu : undefined}
      data-focused={focused ? "true" : undefined}
      data-disabled={!row.enabled ? "true" : undefined}
      className={cn(
        "group flex h-7 select-none items-center gap-2 rounded-[7px] px-2 text-[14px] leading-7 outline-hidden",
        "text-token-foreground",
        row.enabled ? "cursor-interaction" : "cursor-default opacity-45",
        focused && "bg-token-list-hover-background",
      )}
      onPointerDown={keepEditorSelection}
      onPointerEnter={() => {
        onFocusIndexChange(index);
        if (row.kind === "submenu" && row.submenu && row.enabled) {
          onSubmenuChange(row.submenu);
          return;
        }
        onSubmenuChange(null);
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (!row.enabled) return;
        if (row.kind === "submenu" && row.submenu) {
          onSubmenuChange(row.submenu);
        }
        onAction(row);
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
        {getActionIcon(row.key)}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{row.label}</span>
      {row.mockReason ? (
        <NodexTooltip tooltipContent={row.mockReason}>
          <span className="shrink-0 rounded-[4px] bg-token-foreground/5 px-1 text-[10px] font-medium uppercase leading-4 text-token-description-foreground">
            Mock
          </span>
        </NodexTooltip>
      ) : null}
      {row.badge ? (
        <span className="shrink-0 rounded-[4px] bg-token-foreground/5 px-1 text-[11px] leading-4 text-token-description-foreground">
          {row.badge}
        </span>
      ) : null}
      {row.shortcut ? (
        <span className="shrink-0 text-[12px] leading-4 text-token-description-foreground">
          {row.shortcut}
        </span>
      ) : null}
      {row.checked ? <CheckmarkIcon className="size-4 shrink-0" /> : null}
      {row.kind === "submenu" ? (
        <NfmSideMenuChevronRightIcon className="text-token-description-foreground" />
      ) : null}
    </div>
  );

  if (row.kind !== "submenu" || !row.submenu || !submenuContent) return rowElement;

  const submenuWidth = row.submenu === "move-to" ? 330 : row.submenu === "language" ? 240 : 226;
  const isMoveToSubmenu = row.submenu === "move-to";

  return (
    <NodexPopover
      open={activeSubmenu === row.submenu}
      onOpenChange={(open) => {
        if (open) {
          onSubmenuChange(row.submenu ?? null);
          return;
        }
        if (activeSubmenu === row.submenu) {
          onSubmenuChange(null);
        }
      }}
    >
      <NodexPopoverAnchor>{rowElement}</NodexPopoverAnchor>
      <NfmEditorPopoverContent
        side="right"
        align="start"
        sideOffset={6}
        alignOffset={-4}
        aria-label={row.label}
        data-nfm-side-menu-submenu="true"
        className={cn(
          "text-[14px] leading-[1.2] shadow-xl-spread backdrop-blur-xl",
          isMoveToSubmenu
            ? "w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
            : row.submenu === "language"
              ? "w-[240px] max-h-[50vh] overflow-y-auto p-1"
              : "w-[226px] overflow-y-auto p-1",
        )}
        style={{ width: submenuWidth }}
      >
        {submenuContent}
      </NfmEditorPopoverContent>
    </NodexPopover>
  );
}

function NfmSideMenuSeparator({ kind }: { kind: "group" | "footer" }) {
  return (
    <div
      aria-hidden="true"
      data-nfm-side-menu-separator={kind}
      className={cn("w-full px-2 pb-1", kind === "group" ? "pt-1" : "pt-0")}
    >
      <div className="h-px w-full bg-token-menu-border" />
    </div>
  );
}

function NfmSideMenuSectionView({
  section,
  startIndex,
  previousRow,
  focusedIndex,
  activeSubmenu,
  listboxId,
  onAction,
  onFocusIndexChange,
  onSubmenuChange,
  renderSubmenu,
}: {
  section: NfmSideMenuSection;
  startIndex: number;
  previousRow: NfmSideMenuFlatRow | undefined;
  focusedIndex: number;
  activeSubmenu: NfmSideMenuSubmenuKey | null;
  listboxId: string;
  onAction: (row: NfmSideMenuAction) => void;
  onFocusIndexChange: (index: number) => void;
  onSubmenuChange: (submenu: NfmSideMenuSubmenuKey | null) => void;
  renderSubmenu: (submenu: NfmSideMenuSubmenuKey) => ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="flex h-6 items-center px-2 text-[12px] leading-6 text-token-description-foreground">
        <span className="min-w-0 flex-1 truncate">{section.label}</span>
      </div>
      <div className="flex flex-col gap-px">
        {section.rows.map((row, offset) => {
          const index = startIndex + offset;
          const currentFlatRow = { sectionKey: section.key, row };
          const previousFlatRow =
            offset === 0
              ? previousRow
              : { sectionKey: section.key, row: section.rows[offset - 1]! };
          return (
            <Fragment key={row.key}>
              {shouldRenderNfmSideMenuSeparatorBefore(previousFlatRow, currentFlatRow) ? (
                <NfmSideMenuSeparator kind="group" />
              ) : null}
              <NfmSideMenuRow
                row={row}
                index={index}
                listboxId={listboxId}
                focused={focusedIndex === index}
                activeSubmenu={activeSubmenu}
                onAction={onAction}
                onFocusIndexChange={onFocusIndexChange}
                onSubmenuChange={onSubmenuChange}
                submenuContent={row.submenu ? renderSubmenu(row.submenu) : undefined}
              />
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

type NfmSideMenuSubmenuRowProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "onClick" | "onPointerEnter"
> & {
  children: ReactNode;
  disabled?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onPointerEnter?: () => void;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  ariaHaspopup?: "dialog";
  ariaExpanded?: boolean;
};

const NfmSideMenuSubmenuRow = forwardRef<HTMLDivElement, NfmSideMenuSubmenuRowProps>(
  function NfmSideMenuSubmenuRow(
    {
      children,
      disabled = false,
      selected = false,
      onClick,
      onPointerEnter,
      leftSlot,
      rightSlot,
      ariaHaspopup,
      ariaExpanded,
      className,
      ...props
    },
    forwardedRef,
  ) {
    return (
      <div
        {...props}
        ref={forwardedRef}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={disabled || undefined}
        aria-current={selected ? "true" : undefined}
        aria-haspopup={ariaHaspopup}
        aria-expanded={ariaExpanded}
        className={cn(
          "flex h-7 select-none items-center gap-2 rounded-[7px] px-2 text-[14px] leading-7 outline-hidden",
          disabled
            ? "cursor-default text-token-text-secondary opacity-45"
            : "cursor-interaction text-token-foreground hover:bg-token-list-hover-background",
          className,
        )}
        onPointerDown={keepEditorSelection}
        onPointerEnter={onPointerEnter}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          onClick?.();
        }}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
          {leftSlot}
        </span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {selected ? <CheckmarkIcon className="size-4 shrink-0" /> : rightSlot}
      </div>
    );
  },
);

function NfmSideMenuColorDot({
  color,
  kind,
  selected,
}: {
  color: NfmSideMenuColorValue;
  kind: "text" | "background";
  selected: boolean;
}) {
  const style: CSSProperties =
    kind === "text"
      ? {
          color:
            color === "default" ? "var(--color-token-foreground)" : SIDE_MENU_COLOR_STYLES[color],
          backgroundColor: "transparent",
          boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${color === "default" ? "var(--color-token-border)" : SIDE_MENU_COLOR_STYLES[color]}`,
        }
      : {
          color: "var(--color-token-foreground)",
          backgroundColor: SIDE_MENU_BACKGROUND_COLOR_STYLES[color],
          boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${color === "default" ? "var(--color-token-border)" : SIDE_MENU_COLOR_STYLES[color]}`,
        };

  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] text-[12px] leading-none font-medium"
      style={style}
      aria-hidden="true"
    >
      {kind === "text" ? "A" : null}
    </span>
  );
}

function NfmSideMenuSubmenu({
  submenu,
  turnIntoItems,
  colorOptions,
  canUseTextColor,
  canUseBackgroundColor,
  canSendBlocks,
  sourceProjectId,
  sourcePageId,
  textColor,
  backgroundColor,
  codeLanguageId,
  onTurnInto,
  onColor,
  onCodeLanguageChange,
  onMoveBlocksToDestination,
  renderMoveToMenu,
}: Pick<
  NfmSideMenuSurfaceProps,
  | "turnIntoItems"
  | "colorOptions"
  | "canUseTextColor"
  | "canUseBackgroundColor"
  | "canSendBlocks"
  | "sourceProjectId"
  | "sourcePageId"
  | "textColor"
  | "backgroundColor"
  | "codeLanguageId"
  | "onTurnInto"
  | "onColor"
  | "onCodeLanguageChange"
  | "onMoveBlocksToDestination"
  | "renderMoveToMenu"
> & {
  submenu: NfmSideMenuSubmenuKey;
}) {
  const cardInRowRef = useRef<HTMLDivElement>(null);
  const [cardInOpen, setCardInOpen] = useState(false);
  const closeCardInAndRestoreFocus = useCallback(() => {
    setCardInOpen(false);
    requestAnimationFrame(() => {
      cardInRowRef.current?.focus();
    });
  }, []);
  const cardInMenuProps = {
    sourceProjectId,
    sourcePageId,
    onAccept: onMoveBlocksToDestination,
    onClose: closeCardInAndRestoreFocus,
    resultScope: "db-only" as const,
    ariaLabel: "Page in destination",
    placeholder: "Page in…",
  };

  return (
    <>
      {submenu === "language" ? (
        <div role="menu" aria-label="Language">
          {CODE_LANGUAGE_CATALOG.map((language) => (
            <NfmSideMenuSubmenuRow
              key={language.id}
              selected={language.id === codeLanguageId}
              leftSlot={<CodeIcon />}
              onClick={() => onCodeLanguageChange(language.id)}
            >
              {language.label}
            </NfmSideMenuSubmenuRow>
          ))}
        </div>
      ) : null}
      {submenu === "turn-into" ? (
        <div role="menu" aria-label="Turn into">
          <div className="flex h-6 items-center px-2 text-[12px] text-token-description-foreground">
            Turn into
          </div>
          {turnIntoItems.map((item) => (
            <NfmSideMenuSubmenuRow
              key={item.key}
              disabled={!item.enabled}
              leftSlot={getBlockTypeIcon(item)}
              onPointerEnter={() => setCardInOpen(false)}
              onClick={() => onTurnInto(item)}
            >
              {item.label}
            </NfmSideMenuSubmenuRow>
          ))}
          <div className="mx-2 my-1 h-px bg-token-menu-border" />
          <NodexPopover
            open={cardInOpen}
            onOpenChange={(open) => {
              if (open && canSendBlocks) {
                setCardInOpen(true);
                return;
              }
              setCardInOpen(false);
            }}
          >
            <NodexPopoverAnchor>
              <NfmSideMenuSubmenuRow
                ref={cardInRowRef}
                leftSlot={<NfmSideMenuPageInIcon />}
                rightSlot={
                  <NfmSideMenuChevronRightIcon className="text-token-description-foreground" />
                }
                disabled={!canSendBlocks}
                ariaHaspopup="dialog"
                ariaExpanded={cardInOpen}
                onPointerEnter={() => {
                  if (canSendBlocks) setCardInOpen(true);
                }}
                onClick={() => {
                  setCardInOpen(true);
                }}
              >
                Page in
              </NfmSideMenuSubmenuRow>
            </NodexPopoverAnchor>
            <NfmEditorPopoverContent
              side="right"
              align="start"
              sideOffset={6}
              alignOffset={-4}
              aria-label="Page in"
              data-nfm-side-menu-submenu="true"
              className="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0 text-[14px] leading-[1.2] shadow-xl-spread backdrop-blur-xl"
              style={{ width: 330 }}
            >
              {renderMoveToMenu?.(cardInMenuProps) ?? <NfmMoveToMenu {...cardInMenuProps} />}
            </NfmEditorPopoverContent>
          </NodexPopover>
        </div>
      ) : null}
      {submenu === "color" ? (
        <div role="menu" aria-label="Color">
          {canUseTextColor ? (
            <>
              <div className="flex h-6 items-center px-2 text-[12px] text-token-description-foreground">
                Text color
              </div>
              {colorOptions.map((option) => (
                <NfmSideMenuSubmenuRow
                  key={`text-${option.color}`}
                  selected={normalizeColorValue(textColor) === option.color}
                  leftSlot={
                    <NfmSideMenuColorDot
                      kind="text"
                      color={option.color}
                      selected={normalizeColorValue(textColor) === option.color}
                    />
                  }
                  onClick={() => onColor("text", option.color)}
                >
                  {option.label}
                </NfmSideMenuSubmenuRow>
              ))}
            </>
          ) : null}
          {canUseBackgroundColor ? (
            <>
              <div className="mx-2 my-1 h-px bg-token-menu-border" />
              <div className="flex h-6 items-center px-2 text-[12px] text-token-description-foreground">
                Background color
              </div>
              {colorOptions.map((option) => (
                <NfmSideMenuSubmenuRow
                  key={`background-${option.color}`}
                  selected={normalizeColorValue(backgroundColor) === option.color}
                  leftSlot={
                    <NfmSideMenuColorDot
                      kind="background"
                      color={option.color}
                      selected={normalizeColorValue(backgroundColor) === option.color}
                    />
                  }
                  onClick={() => onColor("background", option.color)}
                >
                  {option.label}
                </NfmSideMenuSubmenuRow>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function NfmSideMenuSurface({
  sections,
  query,
  focusedIndex,
  activeSubmenu,
  listboxId,
  comboboxId,
  activeDescendantId,
  turnIntoItems,
  colorOptions,
  canUseTextColor,
  canUseBackgroundColor,
  canSendBlocks,
  sourceProjectId,
  sourcePageId,
  textColor,
  backgroundColor,
  codeLanguageId,
  footerPrimary,
  footerSecondary,
  onQueryChange,
  onFocusIndexChange,
  onMoveFocus,
  onActivateFocused,
  onClose,
  onAction,
  onSubmenuChange,
  onTurnInto,
  onColor,
  onCodeLanguageChange,
  onClipboardCommand,
  onMoveBlocksToDestination,
  renderMoveToMenu,
}: NfmSideMenuSurfaceProps) {
  let rowIndex = 0;
  const flatRowsForSeparators = useMemo(() => flattenNfmSideMenuRows(sections), [sections]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onMoveFocus(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMoveFocus(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onActivateFocused();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  const handleInputClipboardCommand = (
    command: NfmClipboardCommand,
    event: ReactClipboardEvent<HTMLInputElement>,
  ) => {
    if (!onClipboardCommand?.(command, event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const closeSubmenuAndRestoreFocus = () => {
    onSubmenuChange(null);
    requestAnimationFrame(() => {
      document.getElementById(comboboxId)?.focus();
    });
  };
  const renderSubmenu = (submenu: NfmSideMenuSubmenuKey) => {
    if (submenu === "move-to") {
      const moveToMenuProps = {
        sourceProjectId,
        sourcePageId,
        onAccept: onMoveBlocksToDestination,
        onClose: closeSubmenuAndRestoreFocus,
      };

      return (
        renderMoveToMenu?.(moveToMenuProps) ?? (
          <NfmMoveToMenu
            sourceProjectId={sourceProjectId}
            sourcePageId={sourcePageId}
            onAccept={onMoveBlocksToDestination}
            onClose={closeSubmenuAndRestoreFocus}
          />
        )
      );
    }

    return (
      <NfmSideMenuSubmenu
        submenu={submenu}
        turnIntoItems={turnIntoItems}
        colorOptions={colorOptions}
        canUseTextColor={canUseTextColor}
        canUseBackgroundColor={canUseBackgroundColor}
        canSendBlocks={canSendBlocks}
        sourceProjectId={sourceProjectId}
        sourcePageId={sourcePageId}
        textColor={textColor}
        backgroundColor={backgroundColor}
        codeLanguageId={codeLanguageId}
        onTurnInto={onTurnInto}
        onColor={onColor}
        onCodeLanguageChange={onCodeLanguageChange}
        onMoveBlocksToDestination={onMoveBlocksToDestination}
        renderMoveToMenu={renderMoveToMenu}
      />
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Block actions"
      className="relative w-[265px] min-w-[180px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl bg-token-dropdown-background/90 p-0 text-[14px] leading-[1.2] text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
    >
      <div className="flex max-h-[70vh] flex-col overflow-hidden">
        <div className="p-1.5 pb-1">
          <input
            id={comboboxId}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={activeSubmenu !== null}
            aria-haspopup="listbox"
            aria-activedescendant={activeDescendantId}
            value={query}
            placeholder="Search actions…"
            className="h-7 w-full rounded-[7px] bg-token-foreground/5 px-2 text-[14px] text-token-foreground outline-hidden placeholder:text-token-description-foreground focus:bg-token-foreground/10"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            onCopy={(event) => handleInputClipboardCommand("copy", event)}
            onCut={(event) => handleInputClipboardCommand("cut", event)}
          />
        </div>
        <div className="notion-scroller vertical min-h-0 flex-1 overflow-y-auto px-1">
          <div id={listboxId} role="listbox" aria-labelledby={comboboxId}>
            {sections.length === 0 ? (
              <div className="flex h-10 items-center px-2 text-[13px] text-token-description-foreground">
                No results
              </div>
            ) : null}
            {sections.map((section) => {
              const startIndex = rowIndex;
              rowIndex += section.rows.length;
              return (
                <NfmSideMenuSectionView
                  key={section.key}
                  section={section}
                  startIndex={startIndex}
                  previousRow={flatRowsForSeparators[startIndex - 1]}
                  focusedIndex={focusedIndex}
                  activeSubmenu={activeSubmenu}
                  listboxId={listboxId}
                  onAction={(row) => {
                    if (row.kind === "submenu" && row.submenu) {
                      onSubmenuChange(row.submenu);
                    }
                    onAction(row);
                  }}
                  onFocusIndexChange={onFocusIndexChange}
                  onSubmenuChange={onSubmenuChange}
                  renderSubmenu={renderSubmenu}
                />
              );
            })}
          </div>
        </div>
        {footerPrimary || footerSecondary ? (
          <div className="px-1 pb-1 text-[12px] leading-4 text-token-description-foreground">
            <NfmSideMenuSeparator kind="footer" />
            <div className="px-2 py-1.5">
              {footerPrimary ? <div className="truncate">{footerPrimary}</div> : null}
              {footerSecondary ? <div className="truncate">{footerSecondary}</div> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NfmSideMenuPopup({
  openState,
  editor,
  structuredClipboard,
  releaseSideMenuFreeze,
  onCloseSelection,
  onClose,
}: {
  openState: NfmSideMenuOpenState | null;
  editor: SideMenuEditorRuntime;
  structuredClipboard: NonNullable<
    ReturnType<ReturnType<typeof NfmStructuredClipboardExtension>>
  > | null;
  releaseSideMenuFreeze?: () => void;
  onCloseSelection: (reason: NfmSideMenuCloseReason) => void;
  onClose: () => void;
}) {
  const runtime = useNfmSideMenuRuntime();
  const formattingToolbar = useExtension(FormattingToolbarExtension, {
    editor: editor as never,
  });
  const listboxId = useId();
  const comboboxId = useId();
  const popupRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pendingCloseRef = useRef(false);
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeSubmenu, setActiveSubmenu] = useState<NfmSideMenuSubmenuKey | null>(null);
  const [visible, setVisible] = useState(false);

  const block = openState?.block;
  const selectedActionBlocks = useMemo(
    () => (openState && block ? getSideMenuActionBlocks(openState, block) : []),
    [block, openState],
  );
  const topLevelSelectedBlocks = useMemo(
    () => getTopLevelSideMenuActionBlocks(selectedActionBlocks),
    [selectedActionBlocks],
  );
  const selectedTopLevelBlock = topLevelSelectedBlocks[0] ?? block ?? null;
  const currentBlockId = selectedTopLevelBlock ? getCurrentBlockId(selectedTopLevelBlock) : null;
  const subscribeCodeWrapped = useCallback(
    (listener: () => void) =>
      currentBlockId ? codeBlockViewState.subscribe(currentBlockId, listener) : () => undefined,
    [currentBlockId],
  );
  const getCodeWrapped = useCallback(
    () => (currentBlockId ? codeBlockViewState.getWrapped(currentBlockId) : false),
    [currentBlockId],
  );
  const codeWrapped = useSyncExternalStore(subscribeCodeWrapped, getCodeWrapped, getCodeWrapped);
  const codeLanguageId = normalizeCodeLanguageId(selectedTopLevelBlock?.props?.language);
  const isSingleCodeBlock =
    selectedTopLevelBlock?.type === "codeBlock" && topLevelSelectedBlocks.length === 1;
  const codeSurface = currentBlockId
    ? ([
        ...(editor.domElement?.querySelectorAll<HTMLElement>("[data-nfm-code-block-surface]") ??
          []),
      ].find((surface) => surface.dataset.blockId === currentBlockId) ?? null)
    : null;
  const readyMermaidSvg = readReadyMermaidSvg(codeSurface);
  const hasValidDiagram = readyMermaidSvg !== null;
  const colorTargetBlocks = useMemo(
    () => (selectedActionBlocks.length > 0 ? selectedActionBlocks : block ? [block] : []),
    [block, selectedActionBlocks],
  );
  const colorSupport = useMemo(() => {
    if (colorTargetBlocks.length === 0) return { text: false, background: false };

    return colorTargetBlocks.reduce(
      (acc, selectedBlock) => {
        const selectedSupport = supportsBlockColor(editor, selectedBlock);
        return {
          text: acc.text && selectedSupport.text,
          background: acc.background && selectedSupport.background,
        };
      },
      { text: true, background: true },
    );
  }, [colorTargetBlocks, editor]);
  const runtimeSnapshot = runtime.getSnapshot();
  const selectionTitle = useMemo(
    () => resolveNfmSideMenuScopeTitle(topLevelSelectedBlocks.map(toSideMenuTargetBlockDescriptor)),
    [topLevelSelectedBlocks],
  );
  const isEditable = getEditorEditable(editor);
  const baseSections = useMemo(
    () =>
      buildNfmSideMenuSections({
        currentBlockId,
        currentBlockType: selectedTopLevelBlock?.type ?? null,
        selectionTitle,
        selectedTopLevelBlockCount: topLevelSelectedBlocks.length,
        isEditable,
        canUseColor: colorSupport.text || colorSupport.background,
        canSendBlocks: runtimeSnapshot.canSendBlocks,
        hasConvertDividerToThreadSection: runtimeSnapshot.hasConvertDividerToThreadSection,
        isTableBlock: selectedTopLevelBlock?.type === "table",
        canUseTableHeaders: editor.settings?.tables?.headers === true,
        showMockActions: import.meta.env.DEV,
        codeBlock: isSingleCodeBlock
          ? {
              wrapped: codeWrapped,
              canFormat: canFormatCodeLanguage(codeLanguageId),
              isMermaid: codeLanguageId === "mermaid",
              hasValidDiagram,
            }
          : undefined,
      }),
    [
      selectedTopLevelBlock?.type,
      colorSupport.background,
      colorSupport.text,
      currentBlockId,
      codeLanguageId,
      codeWrapped,
      hasValidDiagram,
      editor.settings?.tables?.headers,
      runtimeSnapshot.hasConvertDividerToThreadSection,
      isEditable,
      isSingleCodeBlock,
      runtimeSnapshot.canSendBlocks,
      selectionTitle,
      topLevelSelectedBlocks.length,
    ],
  );
  const sections = useMemo(
    () => filterNfmSideMenuSections(baseSections, query),
    [baseSections, query],
  );
  const flatRows = useMemo(() => flattenNfmSideMenuRows(sections), [sections]);
  const turnIntoItems = useMemo(
    () =>
      getTurnIntoItems(
        editor,
        topLevelSelectedBlocks.length > 0 ? topLevelSelectedBlocks : block ? [block] : [],
      ),
    [block, editor, topLevelSelectedBlocks],
  );
  const colorOptions = useMemo(
    () =>
      SIDE_MENU_COLOR_VALUES.map((color) => ({
        color,
        label: SIDE_MENU_COLOR_LABELS[color],
      })),
    [],
  );
  const activeDescendantId =
    focusedIndex >= 0 && focusedIndex < flatRows.length
      ? getOptionId(listboxId, focusedIndex)
      : undefined;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const finalizeClose = useCallback(() => {
    if (!pendingCloseRef.current) return;
    pendingCloseRef.current = false;
    clearCloseTimer();
    setQuery("");
    setFocusedIndex(-1);
    setActiveSubmenu(null);
    onClose();
  }, [clearCloseTimer, onClose]);

  const close = useCallback(
    (reason: NfmSideMenuCloseReason = "action") => {
      if (!openState || pendingCloseRef.current) return;

      formattingToolbar.store.setState(false);
      onCloseSelection(reason);
      pendingCloseRef.current = true;
      setVisible(false);
      setActiveSubmenu(null);
      releaseSideMenuFreeze?.();
      const returnFocusElement = resolveNfmSideMenuReturnFocusElement({
        reason,
        returnFocusElement: openState.returnFocusElement,
        editorRoot: editor.domElement ?? null,
      });

      if (
        shouldReturnFocusAfterNfmSideMenuClose({
          reason,
          returnFocusElement,
        })
      ) {
        requestAnimationFrame(() => {
          if (!returnFocusElement) return;
          focusNfmSideMenuReturnTarget(editor, returnFocusElement);
        });
      }

      clearCloseTimer();
      closeTimerRef.current = window.setTimeout(
        finalizeClose,
        prefersReducedMotion() ? 0 : SIDE_MENU_EXIT_FALLBACK_MS,
      );
    },
    [
      clearCloseTimer,
      editor,
      finalizeClose,
      formattingToolbar.store,
      onCloseSelection,
      openState,
      releaseSideMenuFreeze,
    ],
  );

  useEffect(() => {
    if (!openState) {
      setVisible(false);
      return;
    }

    pendingCloseRef.current = false;
    clearCloseTimer();
    setQuery("");
    setFocusedIndex(-1);
    setActiveSubmenu(null);
    setVisible(false);

    const animationFrame = requestAnimationFrame(() => {
      setVisible(true);
    });

    return () => {
      cancelAnimationFrame(animationFrame);
    };
  }, [clearCloseTimer, openState]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    [clearCloseTimer],
  );

  useEffect(() => {
    if (!openState || !visible) return;
    formattingToolbar.store.setState(false);
  }, [formattingToolbar.store, openState, visible]);

  const executeAction = useCallback(
    (key: NfmSideMenuActionKey) => {
      if (!block || !currentBlockId || !openState) return;

      const selectedBlocks = getSideMenuActionBlocks(openState, block);
      const topLevelSelectedBlocks = getTopLevelSideMenuActionBlocks(selectedBlocks);
      if (!isEditable) return;

      if (key === "duplicate") {
        if (
          runtimeSnapshot.onDuplicateBlocks(
            topLevelSelectedBlocks.flatMap((candidate) =>
              typeof candidate.id === "string" ? [candidate.id] : [],
            ),
          )
        ) {
          close("action");
          return;
        }
        const referenceBlock = topLevelSelectedBlocks[topLevelSelectedBlocks.length - 1] ?? block;
        editor.insertBlocks?.(
          topLevelSelectedBlocks.map(cloneBlockForInsert),
          referenceBlock,
          "after",
        );
        close("action");
        return;
      }

      if (key === "copy-code") {
        void writeTextToClipboard(getCodeBlockPlainText(selectedTopLevelBlock ?? block)).then(
          (copied) => {
            if (!copied) toast.danger("Could not copy code");
          },
        );
        close("action");
        return;
      }

      if (key === "wrap-code") {
        codeBlockViewState.setWrapped(currentBlockId, !codeWrapped);
        return;
      }

      if (key === "expand-diagram") {
        close("action");
        queueMicrotask(() =>
          codeSurface
            ?.querySelector<HTMLButtonElement>(
              '[aria-label="Click diagram to expand in fullscreen"]',
            )
            ?.click(),
        );
        return;
      }

      if (key === "download-diagram") {
        if (!readyMermaidSvg) return;
        void downloadMermaidDiagram({
          svg: readyMermaidSvg,
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        });
        close("action");
        return;
      }

      if (key === "format-code") {
        const sourceBlock = selectedTopLevelBlock ?? block;
        if (sourceBlock.type !== "codeBlock") return;
        const source = getCodeBlockPlainText(sourceBlock);
        void formatCode(codeLanguageId, source).then((result) => {
          if (result.status === "failed") {
            toast.danger("Could not format code", { description: result.error.message });
            return;
          }
          if (result.status === "unsupported") return;
          if (result.status === "unchanged") {
            toast.info("Code is already formatted");
            close("action");
            return;
          }

          const latestBlock = editor.getBlock?.(currentBlockId);
          if (!latestBlock || getCodeBlockPlainText(latestBlock) !== source) {
            toast.info("Code changed before formatting finished");
            return;
          }
          const update = () => editor.updateBlock?.(latestBlock, { content: result.code });
          if (editor.transact) {
            editor.transact(update);
          } else {
            update();
          }
          close("action");
        });
        return;
      }

      if (key === "delete") {
        if (
          runtimeSnapshot.onDeleteBlocks(
            topLevelSelectedBlocks.flatMap((candidate) =>
              typeof candidate.id === "string" ? [candidate.id] : [],
            ),
          )
        ) {
          close("action");
          return;
        }
        editor.removeBlocks?.(topLevelSelectedBlocks);
        close("action");
        return;
      }

      if (key === "convert-divider-to-thread-section") {
        runtimeSnapshot.onConvertDividerToThreadSection(currentBlockId);
        close("action");
        return;
      }

      if (key === "table-header-row" || key === "table-header-column") {
        if (block.type !== "table") return;
        const tableContent =
          typeof block.content === "object" && block.content !== null
            ? (block.content as { headerRows?: number; headerCols?: number })
            : {};
        editor.updateBlock?.(block, {
          content: {
            ...tableContent,
            ...(key === "table-header-row"
              ? { headerRows: tableContent.headerRows ? undefined : 1 }
              : { headerCols: tableContent.headerCols ? undefined : 1 }),
          },
        });
        close("action");
      }
    },
    [
      block,
      close,
      codeLanguageId,
      codeWrapped,
      codeSurface,
      currentBlockId,
      editor,
      isEditable,
      readyMermaidSvg,
      openState,
      runtimeSnapshot,
      selectedTopLevelBlock,
    ],
  );

  const activateRow = useCallback(
    (row: NfmSideMenuAction) => {
      if (!row.enabled) return;
      if (row.kind === "submenu" && row.submenu) {
        setActiveSubmenu(row.submenu);
        return;
      }
      executeAction(row.key);
    },
    [executeAction],
  );

  const activateFocusedRow = useCallback(() => {
    const focusedRow = flatRows[focusedIndex]?.row;
    if (!focusedRow) return;
    activateRow(focusedRow);
  }, [activateRow, flatRows, focusedIndex]);

  useEffect(() => {
    setFocusedIndex(getInitialNfmSideMenuFocusIndex(query, flatRows));
    setActiveSubmenu(null);
  }, [flatRows, query]);

  useEffect(() => {
    if (!openState || !visible) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        !shouldCloseNfmSideMenuForPointerTarget({
          target: event.target,
          popupElement: popupRef.current,
          outsidePressIgnoreElement: openState.outsidePressIgnoreElement,
        })
      ) {
        return;
      }
      const shouldConsumePointer = shouldConsumeNfmSideMenuOutsidePointerTarget({
        target: event.target,
        editorRoot: editor.domElement ?? null,
      });

      if (shouldConsumePointer) {
        event.preventDefault();
        event.stopPropagation();
        close("editor-outside-pointer");
        return;
      }

      close("outside-pointer");
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close("escape");
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [close, editor, openState, visible]);

  useEffect(() => {
    if (!openState || !visible) return;
    requestAnimationFrame(() => {
      popupRef.current?.querySelector<HTMLInputElement>("input[role='combobox']")?.focus();
    });
  }, [openState, visible]);

  const floatingUIOptions = useMemo<FloatingUIOptions>(
    () => ({
      useFloatingOptions: {
        open: Boolean(openState && visible),
        placement: "left",
        strategy: "fixed",
        transform: false,
        middleware: [
          offset(NFM_SIDE_MENU_GAP),
          shift({ padding: NFM_SIDE_MENU_VIEWPORT_MARGIN }),
          size({
            padding: NFM_SIDE_MENU_VIEWPORT_MARGIN,
            apply({ availableHeight, elements }) {
              const availableMaxHeight = Math.max(0, availableHeight);
              const viewportMaxHeight =
                typeof window === "undefined"
                  ? availableMaxHeight
                  : Math.max(0, window.innerHeight * NFM_SIDE_MENU_MAX_HEIGHT_VH);
              elements.floating.style.maxHeight = `${Math.min(availableMaxHeight, viewportMaxHeight)}px`;
            },
          }),
        ],
      },
      focusManagerProps: {
        disabled: true,
      },
      useDismissProps: {
        enabled: false,
      },
      useTransitionStylesProps: {
        duration: prefersReducedMotion()
          ? { open: 0, close: 0 }
          : { open: SIDE_MENU_MOTION_DURATION_MS, close: SIDE_MENU_MOTION_DURATION_MS },
        initial: {
          opacity: 0,
          transform: `scale(${SIDE_MENU_CLOSED_SCALE})`,
        },
        open: {
          opacity: 1,
          transform: "scale(1)",
        },
        close: {
          opacity: 0,
          transform: `scale(${SIDE_MENU_CLOSED_SCALE})`,
        },
        common: {
          transformOrigin: "right center",
          transitionDelay: `${SIDE_MENU_MOTION_DELAY_MS}ms`,
          transitionTimingFunction: "ease",
        },
      },
      elementProps: {
        className:
          "fixed z-50 opacity-100 transition-[opacity,transform] duration-200 ease-[ease] motion-reduce:transition-none",
        style: {
          width: NFM_SIDE_MENU_WIDTH,
          maxHeight: "70vh",
          pointerEvents: visible ? "auto" : "none",
          zIndex: 50,
        } as CSSProperties,
        contentEditable: false,
        "data-nfm-side-menu-popup": "true",
        "data-state": visible ? "open" : "closed",
        onTransitionEnd: (event) => {
          if (event.target !== event.currentTarget) return;
          if (event.propertyName !== "opacity") return;
          if (visible) return;
          finalizeClose();
        },
      },
    }),
    [finalizeClose, openState, visible],
  );

  if (!openState || !block) return null;

  return (
    <NfmFloatingPopover
      reference={openState.reference}
      portalElement={null}
      floatingRef={popupRef}
      {...floatingUIOptions}
    >
      <NfmSideMenuSurface
        sections={sections}
        query={query}
        focusedIndex={focusedIndex}
        activeSubmenu={activeSubmenu}
        listboxId={listboxId}
        comboboxId={comboboxId}
        activeDescendantId={activeDescendantId}
        turnIntoItems={turnIntoItems}
        colorOptions={colorOptions}
        canUseTextColor={colorSupport.text}
        canUseBackgroundColor={colorSupport.background}
        canSendBlocks={runtimeSnapshot.canSendBlocks}
        sourceProjectId={runtimeSnapshot.sourceProjectId}
        sourcePageId={runtimeSnapshot.sourcePageId}
        textColor={toStringProp(block.props, "textColor")}
        backgroundColor={toStringProp(block.props, "backgroundColor")}
        codeLanguageId={codeLanguageId}
        footerPrimary={null}
        footerSecondary={null}
        onQueryChange={setQuery}
        onFocusIndexChange={setFocusedIndex}
        onMoveFocus={(direction) => {
          setFocusedIndex((currentIndex) =>
            moveNfmSideMenuFocus(currentIndex, direction, flatRows),
          );
        }}
        onActivateFocused={activateFocusedRow}
        onClose={() => close("escape")}
        onAction={activateRow}
        onSubmenuChange={setActiveSubmenu}
        onTurnInto={(item) => {
          if (!item.enabled || !item.target) return;
          const selectedBlocks = getSideMenuActionBlocks(openState, block);
          if (
            selectedBlocks.some(
              (selectedBlock) =>
                selectedBlock.type === "canvas" || selectedBlock.type === "database",
            )
          ) {
            toast.info("Canvas and Database blocks cannot be turned into text content.");
            close("action");
            return;
          }
          const rootBlocks = getTopLevelSideMenuActionBlocks(selectedBlocks);
          runtimeSnapshot.onTurnBlocksInto({
            rootBlockIds: rootBlocks.flatMap(
              (selectedBlock) => getCurrentBlockId(selectedBlock) ?? [],
            ),
            expandedBlockIds: selectedBlocks.flatMap(
              (selectedBlock) => getCurrentBlockId(selectedBlock) ?? [],
            ),
            target: item.target,
            localPatch: {
              type: item.type,
              ...(item.props ? { props: item.props } : {}),
            },
          });
          close("action");
        }}
        onColor={(kind, color) => {
          const selectedBlocks = getSideMenuActionBlocks(openState, block);
          if (hasTypedOwnerBlock(selectedBlocks)) {
            toast.info("Page, Canvas, and Database blocks do not support generic block colors.");
            close("action");
            return;
          }
          const propName = kind === "text" ? "textColor" : "backgroundColor";
          const currentValue = normalizeColorValue(block.props?.[propName]);
          const nextValue = currentValue === color ? "default" : color;
          for (const selectedBlock of selectedBlocks) {
            editor.updateBlock?.(selectedBlock, {
              props: { [propName]: nextValue },
            });
          }
          close("action");
        }}
        onCodeLanguageChange={(languageId) => {
          if (!isSingleCodeBlock || !selectedTopLevelBlock) return;
          const nextLanguageId = normalizeCodeLanguageId(languageId);
          const update = () =>
            editor.updateBlock?.(selectedTopLevelBlock, {
              props: { language: nextLanguageId },
            });
          if (editor.transact) {
            editor.transact(update);
          } else {
            update();
          }
          codeLanguagePreference.set(nextLanguageId);
          close("action");
        }}
        onClipboardCommand={(command, clipboardEvent) => {
          if (!structuredClipboard?.executeClipboardCommand(command, clipboardEvent)) return false;
          close("clipboard-command");
          return true;
        }}
        onMoveBlocksToDestination={async (destination) => {
          if (!currentBlockId) {
            throw new Error("No block selected.");
          }
          await runtimeSnapshot.onMoveBlocksToDestination(destination, currentBlockId);
          close("action");
        }}
      />
    </NfmFloatingPopover>
  );
}

export function useNfmSideMenuOpenController() {
  return useContext(NfmSideMenuOpenContext);
}

export function NfmSideMenuOpenProvider({ children }: { children: ReactNode }) {
  const blockNoteEditor = useBlockNoteEditor();
  const editor = blockNoteEditor as unknown as SideMenuEditorRuntime;
  const sideMenu = useExtension(SideMenuExtension);
  const structuredClipboard = blockNoteEditor.getExtension(NfmStructuredClipboardExtension) ?? null;
  const [openState, setOpenState] = useState<NfmSideMenuOpenState | null>(null);
  const [formattingToolbarSuppressionRange, setFormattingToolbarSuppressionRange] =
    useState<NfmSideMenuSelectionRange | null>(null);
  const selectionRange = useEditorState({
    editor: blockNoteEditor,
    selector: ({ editor }) => ({
      from: editor.prosemirrorState.selection.from,
      to: editor.prosemirrorState.selection.to,
    }),
  });
  const freezeController = useMemo(() => createSideMenuFreezeController(sideMenu), [sideMenu]);

  const close = useCallback(() => {
    setOpenState(null);
    freezeController.release();
  }, [freezeController]);

  const captureFormattingToolbarSuppression = useCallback(
    (reason: NfmSideMenuCloseReason) => {
      setFormattingToolbarSuppressionRange(
        resolveNfmSideMenuFormattingToolbarSuppressionRange({
          reason,
          selectionRange: getCurrentNfmSideMenuSelectionRange(editor),
        }),
      );
    },
    [editor],
  );

  const openForBlock = useCallback(
    ({
      block,
      reference,
      returnFocusElement,
      outsidePressIgnoreElement = null,
      selectionIntent,
      freezeSideMenu = false,
    }: NfmSideMenuOpenBlockInput) => {
      const resolvedSelectionIntent =
        selectionIntent ?? createSideMenuSelectionIntent(editor, block);

      setFormattingToolbarSuppressionRange(null);
      if (editor.domElement) claimEditorSelectionSurface(editor.domElement);
      applySideMenuSelectionIntent(editor, resolvedSelectionIntent);

      if (freezeSideMenu) {
        freezeController.handleMenuOpenChange(true);
      } else {
        freezeController.release();
      }

      setOpenState({
        block,
        reference,
        returnFocusElement,
        outsidePressIgnoreElement,
        selectionIntent: resolvedSelectionIntent,
      });
      return true;
    },
    [editor, freezeController],
  );

  const openForCurrentSelection = useCallback(
    (input: NfmSideMenuOpenSelectionInput = {}) => {
      const block = editor.getSelection?.()?.blocks?.[0] ?? editor.getTextCursorPosition?.().block;
      if (!block) return false;

      const editorRoot = editor.domElement ?? null;
      const reference = resolveNfmSideMenuReference({
        root: editorRoot,
        blockId: getCurrentBlockId(block),
        fallbackRect: input.anchorRect,
      });
      if (!reference) return false;

      return openForBlock({
        block,
        reference,
        returnFocusElement: input.returnFocusElement ?? editorRoot,
        outsidePressIgnoreElement: input.outsidePressIgnoreElement ?? null,
      });
    },
    [editor, openForBlock],
  );

  const value = useMemo<NfmSideMenuOpenController>(
    () => ({
      acquireSideMenuFreeze: freezeController.acquire,
      openBlockId: openState?.block ? getCurrentBlockId(openState.block) : null,
      openForBlock,
      openForCurrentSelection,
      formattingToolbarSuppressionRange,
    }),
    [
      formattingToolbarSuppressionRange,
      freezeController,
      openForBlock,
      openForCurrentSelection,
      openState,
    ],
  );

  const shouldKeepSuppressionRange = shouldKeepNfmSideMenuFormattingToolbarSuppression({
    selectionRange,
    suppressionRange: formattingToolbarSuppressionRange,
  });

  useEffect(() => {
    if (!formattingToolbarSuppressionRange) return;
    if (shouldKeepSuppressionRange) return;
    setFormattingToolbarSuppressionRange(null);
  }, [formattingToolbarSuppressionRange, shouldKeepSuppressionRange]);

  useEffect(
    () => () => {
      freezeController.releaseAll();
    },
    [freezeController],
  );

  return (
    <NfmSideMenuOpenContext.Provider value={value}>
      {children}
      <NfmSideMenuPopup
        openState={openState}
        editor={editor}
        structuredClipboard={structuredClipboard}
        releaseSideMenuFreeze={freezeController.release}
        onCloseSelection={captureFormattingToolbarSuppression}
        onClose={close}
      />
    </NfmSideMenuOpenContext.Provider>
  );
}

export function NfmSideMenuShortcutController() {
  const editor = useBlockNoteEditor() as unknown as SideMenuEditorRuntime;
  const sideMenuOpenController = useNfmSideMenuOpenController();

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== SIDE_MENU_SHORTCUT_KEY) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.shiftKey || event.altKey) return;

      const editorRoot = editor.domElement;
      if (editorRoot && document.activeElement && !editorRoot.contains(document.activeElement)) {
        return;
      }

      const opened = sideMenuOpenController.openForCurrentSelection({
        returnFocusElement: editorRoot ?? null,
      });
      if (!opened) return;

      event.preventDefault();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [editor, sideMenuOpenController]);

  return null;
}

export function NfmSideMenu() {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const sideMenu = useExtension(SideMenuExtension);
  const editor = useBlockNoteEditor();
  const SideMenuButton = Components.SideMenu.Button;
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  }) as unknown as SideMenuBlock | undefined;
  const runtimeEditor = editor as unknown as SideMenuEditorRuntime;
  const triggerWrapperRef = useRef<HTMLSpanElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const selectionIntentRef = useRef<SideMenuSelectionIntent | null>(null);
  const dragSelectionSnapshotRef = useRef<SideMenuDragSelectionSnapshot | null>(null);
  const dragStartedRef = useRef(false);
  const dragFreezeReleaseRef = useRef<(() => void) | null>(null);
  const lastPointerActivationAtRef = useRef<number | null>(null);
  const sideMenuOpenController = useNfmSideMenuOpenController();
  const runtime = useNfmSideMenuRuntime();

  const releaseDragFreeze = useCallback(() => {
    dragFreezeReleaseRef.current?.();
    dragFreezeReleaseRef.current = null;
  }, []);

  useEffect(() => {
    const cancelPendingGesture = () => {
      pointerStartRef.current = null;
      selectionIntentRef.current = null;
      dragSelectionSnapshotRef.current = null;
      dragStartedRef.current = false;
      releaseDragFreeze();
    };
    window.addEventListener("blur", cancelPendingGesture);
    return () => {
      window.removeEventListener("blur", cancelPendingGesture);
      cancelPendingGesture();
    };
  }, [releaseDragFreeze]);

  const dragTargetBlock = block;

  const dataAttributes = useMemo(() => {
    if (!block) return {};

    const attrs: Record<string, string> = {
      "data-block-type": block.type ?? "",
    };

    if (block.type === "heading") {
      const level = toNumberProp(block.props, "level");
      if (level !== null) attrs["data-level"] = level.toString();
    }

    if (
      block.type &&
      runtimeEditor.schema.blockSpecs[block.type]?.implementation?.meta?.fileBlockAccept
    ) {
      attrs["data-url"] = toStringProp(block.props, "url").length > 0 ? "true" : "false";
    }

    return attrs;
  }, [block, runtimeEditor.schema.blockSpecs]);

  const openFromHandle = useCallback(
    (returnFocusElement: HTMLElement | null, selectionIntent?: SideMenuSelectionIntent | null) => {
      if (!block) return;
      const triggerElement = triggerWrapperRef.current;
      if (!triggerElement) return;

      sideMenuOpenController.openForBlock({
        block,
        reference: createNfmSideMenuElementReference(triggerElement),
        returnFocusElement,
        outsidePressIgnoreElement: triggerElement,
        selectionIntent,
        freezeSideMenu: true,
      });
    },
    [block, sideMenuOpenController],
  );

  if (!block || !dragTargetBlock) return null;

  return (
    <Components.SideMenu.Root className="bn-side-menu" {...dataAttributes}>
      <NfmAddBlockButton />
      <span ref={triggerWrapperRef} className="inline-flex">
        <SideMenuButton
          label={dict.side_menu.drag_handle_label}
          draggable
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse" || event.button !== 0) return;
            releaseDragFreeze();
            dragFreezeReleaseRef.current = sideMenuOpenController.acquireSideMenuFreeze();
            dragStartedRef.current = false;
            selectionIntentRef.current = createSideMenuSelectionIntent(runtimeEditor, block);
            dragSelectionSnapshotRef.current = createSideMenuDragSelectionSnapshot(runtimeEditor);
            pointerStartRef.current = {
              x: event.clientX,
              y: event.clientY,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const start = pointerStartRef.current;
            if (!start) return;
            const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
            if (distance > SIDE_MENU_CLICK_TOLERANCE) {
              start.moved = true;
              selectionIntentRef.current = null;
            }
          }}
          onPointerUp={(event) => {
            if (event.pointerType !== "mouse" || event.button !== 0) return;
            const start = pointerStartRef.current;
            pointerStartRef.current = null;
            if (!start || start.moved || dragStartedRef.current) {
              if (!dragStartedRef.current) {
                dragSelectionSnapshotRef.current = null;
                releaseDragFreeze();
              }
              return;
            }

            const selectionIntent = selectionIntentRef.current;
            selectionIntentRef.current = null;
            dragSelectionSnapshotRef.current = null;
            lastPointerActivationAtRef.current = performance.now();
            openFromHandle(event.currentTarget, selectionIntent);
            releaseDragFreeze();
          }}
          onPointerCancel={(event) => {
            if (event.pointerType !== "mouse") return;
            pointerStartRef.current = null;
            selectionIntentRef.current = null;
            // Chromium hands pointer ownership to native HTML DnD by firing
            // pointercancel after dragstart. The drag lease must then live until
            // dragend (or window blur), not end at that ownership handoff.
            if (dragStartedRef.current) return;
            dragSelectionSnapshotRef.current = null;
            releaseDragFreeze();
          }}
          onClick={() => {
            const lastPointerActivationAt = lastPointerActivationAtRef.current;
            if (
              lastPointerActivationAt !== null &&
              performance.now() - lastPointerActivationAt < 500
            ) {
              lastPointerActivationAtRef.current = null;
              return;
            }

            selectionIntentRef.current = null;
            dragSelectionSnapshotRef.current = null;
            openFromHandle(
              triggerWrapperRef.current,
              createSideMenuSelectionIntent(runtimeEditor, block),
            );
          }}
          onDragStart={(event: SideMenuDragStartEvent) => {
            dragFreezeReleaseRef.current ??= sideMenuOpenController.acquireSideMenuFreeze();
            dragStartedRef.current = true;
            selectionIntentRef.current = null;
            const dragEvent = {
              ...event,
              ...(dragSelectionSnapshotRef.current ?? {}),
            };
            const result = sideMenu.blockDragStart(dragEvent, dragTargetBlock as never);
            if (event.dataTransfer && result?.blockIds.length) {
              runtime.getSnapshot().onBlockDragStart({
                dataTransfer: event.dataTransfer,
                blockIds: result.blockIds,
              });
            }
          }}
          onDragEnd={() => {
            pointerStartRef.current = null;
            selectionIntentRef.current = null;
            dragStartedRef.current = false;
            dragSelectionSnapshotRef.current = null;
            runtime.getSnapshot().onBlockDragEnd();
            sideMenu.blockDragEnd();
            releaseDragFreeze();
          }}
          className="bn-button nfm-side-menu-drag-handle mr-2.5 h-6 w-[18px] cursor-grab p-0 text-token-description-foreground transition-none"
          icon={<DragHandleDotsIcon className="icon-base pointer-events-none" />}
        />
      </span>
    </Components.SideMenu.Root>
  );
}
