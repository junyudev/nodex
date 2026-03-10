import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import {
  FormattingToolbarController,
  SideMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { ChevronDown, ChevronUp, CornerDownLeft, Repeat2, X } from "lucide-react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { nfmSchema } from "./nfm-schema";
import {
  createNfmEditorExtensions,
  createNfmPasteHandler,
  NFM_DISABLED_EXTENSIONS,
} from "./nfm-editor-extensions";
import { createNfmLinkExtension } from "./nfm-link-extension";
import { NfmFormattingToolbar } from "./nfm-formatting-toolbar";
import { ChipPropertyEditor } from "./chip-property-editor";
import { useEditorDragBehaviors } from "./use-editor-drag-behaviors";
import { useCardImportDropTarget } from "./use-card-import-drop-target";
import { NfmSlashMenu } from "./nfm-slash-menu";
import {
  getNfmSearchState,
  goToNextNfmSearchMatch,
  goToPreviousNfmSearchMatch,
  replaceActiveNfmSearchMatch,
  replaceAllNfmSearchMatches,
  revealActiveNfmSearchMatch,
  setNfmSearchQuery,
} from "./search-extension";
import { resolveFindShortcutSeedQuery } from "./find-shortcut-seed";
import {
  deferCollapsedToggleVerticalArrowToBrowser,
  handleArrowFromInlineBlockSelection,
  handleArrowIntoInlineSummary,
} from "./inline-view-arrow-nav";
import {
  insertCardTogglesAtPointer,
  insertCardToggleAtPointer,
  resolveCardDropAnchor,
  resolveCardDropIndicatorPosition,
  type EditorForCardDropInsert,
} from "./card-drop-insert";
import {
  clearCardDropIndicator,
  renderCardDropIndicator,
} from "./card-drop-indicator";
import { mapCardToDroppedCardToggleBlock } from "./card-drop-toggle-mapper";
import {
  mapDraggedBlocksToCardInputs,
  resolveTopLevelDraggedBlocks,
} from "./block-drop-card-mapper";
import { NfmDragHandleMenu, type SendBlocksMode } from "./nfm-drag-handle-menu";
import { NfmSideMenu } from "./nfm-side-menu";
import { resolveSendBlockSelection } from "./send-block-selection";
import { SendBlocksDialog } from "./send-blocks-dialog";
import { useSideMenuSelectionGuard } from "./side-menu-selection-guard";
import { ImagePreviewDialog } from "./image-preview-dialog";
import {
  isSpaceShortcut,
  resolveImagePreviewByBlockId,
  resolveFocusedImagePreview,
  type ImageBlockLookupEditor,
  type ImageSelectionEditor,
} from "./image-preview-shortcut";
import { createCardStageDropAdapter } from "./external-drop-adapters";
import {
  type DragSessionBlock,
  type EditorForExternalBlockDrop,
  runInEditorTransaction,
  restoreEditorDocument,
  snapshotEditorDocument,
} from "./external-block-drag-session";
import type { ExternalCardDragPayload } from "./external-card-drag-session";
import { resolveDraggedBlockIds } from "./drag-source-resolver";
import {
  inferInlineViewDropImport,
  type InlineViewProjectedRow,
} from "./inline-view-drop-inference";
import {
  materializeProjectedCardToggleBlock,
  resolveProjectedCardDropSource,
} from "./projected-card-drop";
import {
  applyCardToggleMetaEdit,
  updateCardToggleSnapshotForMetaEdit,
} from "./card-toggle-snapshot";
import {
  isProjectedCardToggleBlock,
  isProjectionMutationActive,
  splitEmbedChildren,
  stripProjectedSubtrees,
} from "./projection-card-toggle";
import { shouldSuppressPreferIndentBoundaryTab } from "./prefer-indent-tab-boundary";
import { shouldRejectProjectedOwnerStructureChange } from "./projection-structure-guard";
import { isBlockWithinOwnerTree } from "./use-projected-card-embed-sync";
import { invoke } from "@/lib/api";
import { parseNfm, serializeNfm, nfmToBlockNote, blockNoteToNfm, applyToggleStatesFromDom } from "@/lib/nfm";
import {
  parseToggleListInlineViewSettings,
  type ToggleListInlineViewProps,
} from "@/lib/toggle-list/inline-view-props";
import { TOGGLE_LIST_STATUS_ORDER, type ToggleListStatusId } from "@/lib/toggle-list/types";
import { useKanban } from "@/lib/use-kanban";
import type { MetaChipPropertyType } from "@/lib/toggle-list/meta-chips";
import type { BlockDropImportSourceUpdate, Board } from "@/lib/types";
import { resolveAssetSourceToHttpUrl, uploadImageAsset } from "@/lib/assets";
import { useSpellcheck } from "@/lib/use-spellcheck";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

interface ActiveChipEdit {
  propertyType: Exclude<MetaChipPropertyType, "tag">;
  cardId: string;
  blockId: string;
  token: string;
  anchorRect: DOMRect;
}

interface NfmEditorProps {
  projectId: string;
  content: string;
  onChange: (nfm: string) => void;
  onBlur: () => void;
  sourceCardContext?: {
    cardId: string;
    columnId: string;
  };
  placeholder?: string;
  className?: string;
}

interface NfmEditorChangeBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
}

interface NfmEditorChange {
  type: "insert" | "delete" | "move" | "update";
  block: NfmEditorChangeBlock;
  prevBlock?: NfmEditorChangeBlock;
}

interface InlineViewHostContextRuntimeEditor {
  nodexSourceCardContext?: {
    projectId: string;
    cardId: string;
  } | null;
}

interface RuntimeBlockLike {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

interface EditorForInlineViewDrop {
  getBlock: (id: string) => RuntimeBlockLike | undefined;
  getParentBlock: (id: string) => RuntimeBlockLike | undefined;
}

interface InlineViewDropContext {
  ownerBlockId: string;
  sourceProjectId: string;
  projectedRows: InlineViewProjectedRow[];
  insertRowIndex: number;
  settings: ReturnType<typeof parseToggleListInlineViewSettings>;
}

interface SendBlocksDialogState {
  mode: SendBlocksMode;
  blockIds: string[];
  blocks: DragSessionBlock[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRuntimeBlock(value: unknown): RuntimeBlockLike | null {
  if (!isRecord(value)) return null;
  return value as RuntimeBlockLike;
}

function toStringProp(
  props: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function toStatusId(value: string): ToggleListStatusId | undefined {
  if (!TOGGLE_LIST_STATUS_ORDER.includes(value as ToggleListStatusId)) return undefined;
  return value as ToggleListStatusId;
}

function resolveInlineViewOwnerBlock(
  editor: EditorForInlineViewDrop,
  startBlockId: string,
): RuntimeBlockLike | null {
  let currentId: string | undefined = startBlockId;

  while (typeof currentId === "string" && currentId.length > 0) {
    const current = asRuntimeBlock(editor.getBlock(currentId));
    if (!current) return null;
    if (current.type === "toggleListInlineView") return current;

    const parent = asRuntimeBlock(editor.getParentBlock(currentId));
    currentId = typeof parent?.id === "string" ? parent.id : undefined;
  }

  return null;
}

function collectInlineViewProjectedRows(
  ownerBlock: RuntimeBlockLike,
): InlineViewProjectedRow[] {
  if (typeof ownerBlock.id !== "string" || ownerBlock.id.length === 0) return [];
  const ownerChildren = Array.isArray(ownerBlock.children)
    ? ownerBlock.children
    : [];
  const { projectedRows } = splitEmbedChildren(ownerChildren, ownerBlock.id);

  const rows: InlineViewProjectedRow[] = [];
  for (const projected of projectedRows) {
    const row = asRuntimeBlock(projected);
    if (!row || typeof row.id !== "string" || row.id.length === 0) continue;
    if (!isRecord(row.props)) continue;

    const cardId = toStringProp(row.props, "projectionCardId")
      || toStringProp(row.props, "cardId");
    if (!cardId) continue;

    const sourceColumnId = toStatusId(toStringProp(row.props, "sourceColumnId"));
    rows.push({
      blockId: row.id,
      cardId,
      ...(sourceColumnId ? { sourceColumnId } : {}),
    });
  }

  return rows;
}

function resolveInlineViewDropContext(
  editor: EditorForInlineViewDrop,
  anchor: ReturnType<typeof resolveCardDropAnchor>,
): InlineViewDropContext | null {
  if (!anchor) return null;
  const owner = resolveInlineViewOwnerBlock(editor, anchor.blockId);
  if (!owner || typeof owner.id !== "string" || owner.id.length === 0) return null;

  const projectedRows = collectInlineViewProjectedRows(owner);
  const rowIndexById = new Map(projectedRows.map((row, index) => [row.blockId, index]));

  const anchorTargetsOwner = anchor.blockId === owner.id;
  const anchorTargetsRowRoot = rowIndexById.has(anchor.blockId);
  if (!anchorTargetsOwner && !anchorTargetsRowRoot) return null;

  const insertRowIndex = anchorTargetsOwner
    ? (anchor.placement === "before" ? 0 : projectedRows.length)
    : (rowIndexById.get(anchor.blockId) ?? projectedRows.length) + (anchor.placement === "after" ? 1 : 0);

  const ownerProps = isRecord(owner.props)
    ? owner.props
    : {};
  const sourceProjectId = toStringProp(ownerProps, "sourceProjectId") || "default";
  const settings = parseToggleListInlineViewSettings(
    ownerProps as Partial<ToggleListInlineViewProps>,
  );

  return {
    ownerBlockId: owner.id,
    sourceProjectId,
    projectedRows,
    insertRowIndex,
    settings,
  };
}

function blockHasProjectedAncestor(
  editor: EditorForInlineViewDrop,
  blockId: string,
): boolean {
  let currentId: string | undefined = blockId;

  while (typeof currentId === "string" && currentId.length > 0) {
    const current = editor.getBlock(currentId);
    if (!current) return false;
    if (isProjectedCardToggleBlock(current)) return true;

    const parent = editor.getParentBlock(currentId);
    currentId = typeof parent?.id === "string" ? parent.id : undefined;
  }

  return false;
}

function isBoard(value: unknown): value is Board {
  if (!isRecord(value)) return false;
  return Array.isArray(value.columns);
}

export function NfmEditor({
  projectId,
  content,
  onChange,
  onBlur,
  sourceCardContext,
  placeholder = "Add a description...",
  className,
}: NfmEditorProps) {
  const { resolved: themeMode } = useTheme();
  const { spellcheck } = useSpellcheck();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
  const [activeChipEdit, setActiveChipEdit] = useState<ActiveChipEdit | null>(null);
  const [sendBlocksDialog, setSendBlocksDialog] = useState<SendBlocksDialogState | null>(null);
  const [imagePreview, setImagePreview] = useState<{ source: string; alt: string } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const suppressExternalDropRef = useRef(false);
  const suppressExternalContentSyncRef = useRef(false);
  const { moveCardDropToEditor } = useKanban({ projectId });

  // Use refs to avoid stale closures
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const onBlurRef = useRef(onBlur);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  const uploadFile = useCallback(
    async (file: File) => uploadImageAsset(file),
    [projectId],
  );

  const resolveFileUrl = useCallback(
    async (source: string) => resolveAssetSourceToHttpUrl(source),
    [],
  );

  const pasteHandler = useMemo(() => createNfmPasteHandler(), []);
  const extensions = useMemo(() => createNfmEditorExtensions(), []);
  const tiptapExtensions = useMemo(() => [createNfmLinkExtension()], []);

  // Track toggle block IDs for localStorage cleanup
  const toggleBlockIdsRef = useRef<string[]>([]);

  // Parse initial content for the editor, pre-populating localStorage for toggle states
  const initialContent = useMemo(() => {
    // Clean up previous toggle localStorage entries
    for (const id of toggleBlockIdsRef.current) {
      localStorage.removeItem(`toggle-${id}`);
    }
    toggleBlockIdsRef.current = [];

    if (!content.trim()) return undefined;
    const blocks = parseNfm(content);
    const toggleStates = new Map<string, boolean>();
    const bnBlocks = nfmToBlockNote(blocks, toggleStates);

    // Pre-populate localStorage so BlockNote's createToggleWrapper reads correct initial state
    for (const [id, isOpen] of toggleStates) {
      localStorage.setItem(`toggle-${id}`, isOpen ? "true" : "false");
      toggleBlockIdsRef.current.push(id);
    }

    return bnBlocks.length > 0 ? bnBlocks : undefined;
  }, [projectId]);

  const editor = useCreateBlockNote(
    {
      schema: nfmSchema,
      initialContent,
      tabBehavior: "prefer-indent",
      placeholders: {
        default: placeholder,
      },
      uploadFile,
      resolveFileUrl,
      pasteHandler,
      disableExtensions: [...NFM_DISABLED_EXTENSIONS, "link"],
      extensions,
      _tiptapOptions: {
        extensions: tiptapExtensions,
      },
    },
    [projectId],
  );

  useEffect(() => {
    const runtime = editor as unknown as InlineViewHostContextRuntimeEditor;
    runtime.nodexSourceCardContext = sourceCardContext
      ? { projectId, cardId: sourceCardContext.cardId }
      : null;

    return () => {
      runtime.nodexSourceCardContext = null;
    };
  }, [editor, projectId, sourceCardContext]);

  const syncSearchStats = useCallback(() => {
    if (!editor) return;
    const state = getNfmSearchState(editor);
    setSearchMatchCount(state.totalMatches);
    setSearchActiveIndex(state.activeIndex);
  }, [editor]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setReplaceOpen(false);
    setReplaceQuery("");
    if (!editor) return;
    setNfmSearchQuery(editor, "");
    syncSearchStats();
  }, [editor, syncSearchStats]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const navigateSearch = useCallback(
    (direction: "next" | "prev", preserveInputFocus = false) => {
      if (!editor) return;
      if (direction === "next") {
        goToNextNfmSearchMatch(editor);
      } else {
        goToPreviousNfmSearchMatch(editor);
      }
      revealActiveNfmSearchMatch(editor);
      syncSearchStats();
      if (preserveInputFocus) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
      }
    },
    [editor, syncSearchStats]
  );

  const replaceCurrentMatch = useCallback(() => {
    if (!editor) return;

    const state = getNfmSearchState(editor);
    if (state.totalMatches === 0) return;

    if (state.activeIndex < 0) {
      goToNextNfmSearchMatch(editor);
      revealActiveNfmSearchMatch(editor);
      syncSearchStats();
    }

    const replaced = replaceActiveNfmSearchMatch(editor, replaceQuery);
    if (!replaced) return;

    goToNextNfmSearchMatch(editor);
    revealActiveNfmSearchMatch(editor);
    syncSearchStats();

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [editor, replaceQuery, syncSearchStats]);

  const replaceAllMatches = useCallback(() => {
    if (!editor) return;
    replaceAllNfmSearchMatches(editor, replaceQuery);
    syncSearchStats();

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [editor, replaceQuery, syncSearchStats]);

  // Track the last value we sent via onChange to avoid re-parsing our own changes
  const lastEmittedRef = useRef(content);

  const serializeEditorToNfm = useCallback((): string => {
    if (!editor) return "";
    const strippedDocument = stripProjectedSubtrees(editor.document);
    const nfmBlocks = blockNoteToNfm(strippedDocument);
    if (containerRef.current) {
      applyToggleStatesFromDom(strippedDocument, nfmBlocks, containerRef.current);
    }
    return serializeNfm(nfmBlocks);
  }, [editor]);

  useEffect(() => {
    const runtime = editor as unknown as {
      onBeforeChange?: (listener: (event: { getChanges: () => NfmEditorChange[] }) => boolean | void) => () => void;
    };

    if (typeof runtime.onBeforeChange !== "function") return;

    const unsubscribe = runtime.onBeforeChange(({ getChanges }) => {
      if (isProjectionMutationActive()) return;

      if (shouldRejectProjectedOwnerStructureChange(getChanges())) {
        return false;
      }
    });

    return unsubscribe;
  }, [editor]);

  // Handle content changes from the editor
  const handleChange = useCallback(() => {
    if (!editor) return;
    const doc = editor.document;
    // Check if document is empty (single empty paragraph)
    const isEmpty =
      doc.length === 0 ||
      (doc.length === 1 &&
        doc[0].type === "paragraph" &&
        (!doc[0].content || (doc[0].content as unknown[]).length === 0) &&
        (!doc[0].children || doc[0].children.length === 0));

    if (isEmpty) {
      lastEmittedRef.current = "";
      if (!suppressExternalDropRef.current && !suppressExternalContentSyncRef.current) {
        onChangeRef.current("");
      }
      return;
    }

    const nfmString = serializeEditorToNfm();
    lastEmittedRef.current = nfmString;
    if (suppressExternalDropRef.current || suppressExternalContentSyncRef.current) return;
    onChangeRef.current(nfmString);
  }, [editor, serializeEditorToNfm]);

  // Sync external content changes (card switching)
  const prevContentRef = useRef(content);
  useEffect(() => {
    if (!editor) return;
    if (content === prevContentRef.current) return;
    prevContentRef.current = content;

    // Skip if this is a value we just emitted (avoids fighting with our own onChange)
    if (content === lastEmittedRef.current) return;

    // Clean up previous toggle localStorage entries
    for (const id of toggleBlockIdsRef.current) {
      localStorage.removeItem(`toggle-${id}`);
    }
    toggleBlockIdsRef.current = [];

    // Compute replacement blocks synchronously (localStorage must be populated
    // before replaceBlocks so BlockNote reads correct toggle initial states).
    let nextBlocks: typeof editor.document | undefined;

    if (!content.trim()) {
      nextBlocks = [];
    } else {
      const blocks = parseNfm(content);
      const toggleStates = new Map<string, boolean>();
      const bnBlocks = nfmToBlockNote(blocks, toggleStates);

      // Pre-populate localStorage for toggle state restoration
      for (const [id, isOpen] of toggleStates) {
        localStorage.setItem(`toggle-${id}`, isOpen ? "true" : "false");
        toggleBlockIdsRef.current.push(id);
      }

      if (bnBlocks.length > 0) {
        nextBlocks = bnBlocks;
      }
    }

    if (nextBlocks === undefined) return;

    // Defer replaceBlocks to a microtask so Tiptap's ReactRenderer.flushSync
    // (for custom block node views like toggleListInlineView) does not collide
    // with React's active commit phase. Microtasks run before the next paint,
    // so the update is invisible to users.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      suppressExternalContentSyncRef.current = true;
      try {
        editor.transact((tr) => {
          tr.setMeta("addToHistory", false);
          editor.replaceBlocks(editor.document, nextBlocks);
        });
        lastEmittedRef.current = content;
      } finally {
        suppressExternalContentSyncRef.current = false;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [content, editor]);

  useEffect(() => {
    if (!editor) return;
    setNfmSearchQuery(editor, searchQuery);
    syncSearchStats();
  }, [editor, searchQuery, syncSearchStats]);

  useEffect(() => {
    if (!editor) return;
    const unsubscribeChange = editor.onChange(() => {
      syncSearchStats();
    });
    const unsubscribeSelection = editor.onSelectionChange(() => {
      syncSearchStats();
    });
    return () => {
      unsubscribeChange();
      unsubscribeSelection();
    };
  }, [editor, syncSearchStats]);

  // Handle blur via DOM events since BlockNoteView doesn't have onBlur prop
  const containerRef = useRef<HTMLDivElement>(null);

  // Detect toggle button clicks (which don't create ProseMirror transactions)
  // and trigger save so toggle open/closed state is persisted via ▶/▼ markers
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !editor) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "data-show-children" &&
          (mutation.target as HTMLElement).classList.contains("bn-toggle-wrapper")
        ) {
          handleChange();
          // Toggle clicks are discrete actions — flush save immediately
          // (queueMicrotask defers until after React's batched state update)
          queueMicrotask(() => onBlurRef.current());
          return;
        }
      }
    });

    observer.observe(el, {
      attributes: true,
      attributeFilter: ["data-show-children"],
      subtree: true,
    });

    return () => observer.disconnect();
  }, [editor, handleChange]);

  // Clean up toggle localStorage entries on unmount
  useEffect(() => {
    return () => {
      for (const id of toggleBlockIdsRef.current) {
        localStorage.removeItem(`toggle-${id}`);
      }
    };
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleFocusOut = (e: FocusEvent) => {
      if (suppressExternalDropRef.current) return;
      // Only trigger blur if focus is moving outside the editor
      if (!el.contains(e.relatedTarget as Node)) {
        onBlurRef.current();
      }
    };

    el.addEventListener("focusout", handleFocusOut);
    return () => el.removeEventListener("focusout", handleFocusOut);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element) {
        const nearestEditor = event.target.closest(".nfm-editor");
        if (nearestEditor && nearestEditor !== el) {
          return;
        }
      }

      const targetIsTextField =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement;

      if (
        !targetIsTextField &&
        event.key === "Tab"
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && shouldSuppressPreferIndentBoundaryTab(editor, event.target, event.shiftKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (
        !targetIsTextField &&
        !event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (isSpaceShortcut(event)) {
          const focusedImage = resolveFocusedImagePreview(editor as unknown as ImageSelectionEditor);
          if (focusedImage) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) {
              setImagePreview({
                source: resolveAssetSourceToHttpUrl(focusedImage.source),
                alt: focusedImage.alt,
              });
            }
            return;
          }
        }

        if (event.key === "ArrowUp" && handleArrowFromInlineBlockSelection(editor, "prev")) {
          event.preventDefault();
          return;
        }

        if (event.key === "ArrowDown" && handleArrowFromInlineBlockSelection(editor, "next")) {
          event.preventDefault();
          return;
        }

        if (event.key === "ArrowUp" && handleArrowIntoInlineSummary(editor, "prev")) {
          event.preventDefault();
          return;
        }

        if (event.key === "ArrowDown" && handleArrowIntoInlineSummary(editor, "next")) {
          event.preventDefault();
          return;
        }

        if (
          event.key === "ArrowUp"
          && deferCollapsedToggleVerticalArrowToBrowser(editor, el, "prev", event)
        ) {
          return;
        }

        if (
          event.key === "ArrowDown"
          && deferCollapsedToggleVerticalArrowToBrowser(editor, el, "next", event)
        ) {
          return;
        }
      }

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();

      if (!modifier) return;

      if (key === "f") {
        event.preventDefault();
        if (!targetIsTextField) {
          const seedQuery = resolveFindShortcutSeedQuery(editor);
          if (seedQuery.length > 0) {
            setSearchQuery(seedQuery);
          }
        }
        openSearch();
        return;
      }

      if (!searchOpen) return;

      if (key === "g") {
        event.preventDefault();
        navigateSearch(event.shiftKey ? "prev" : "next");
        return;
      }

      if (
        key === "enter" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        navigateSearch("next");
      }
    };

    el.addEventListener("keydown", handleKeyDown, true);
    return () => el.removeEventListener("keydown", handleKeyDown, true);
  }, [navigateSearch, openSearch, searchOpen]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleDoubleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const nearestEditor = event.target.closest(".nfm-editor");
      if (nearestEditor && nearestEditor !== el) {
        return;
      }

      const imageContent = event.target.closest<HTMLElement>("[data-content-type='image']");
      if (!imageContent || !el.contains(imageContent)) return;

      const blockOuter = imageContent.closest<HTMLElement>("[data-node-type='blockOuter'][data-id]");
      const clickedImage = blockOuter?.dataset.id
        ? resolveImagePreviewByBlockId(editor as unknown as ImageBlockLookupEditor, blockOuter.dataset.id)
        : null;
      const focusedImage = resolveFocusedImagePreview(editor as unknown as ImageSelectionEditor);
      const preview = clickedImage ?? focusedImage;
      if (!preview) return;

      event.preventDefault();
      event.stopPropagation();
      setImagePreview({
        source: resolveAssetSourceToHttpUrl(preview.source),
        alt: preview.alt,
      });
    };

    el.addEventListener("dblclick", handleDoubleClick, true);
    return () => {
      el.removeEventListener("dblclick", handleDoubleClick, true);
    };
  }, [editor]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleChipClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const chip = target.closest<HTMLElement>("[data-chip-property]");
      if (!chip) return;

      const propertyType = chip.dataset.chipProperty as MetaChipPropertyType | undefined;
      const cardId = chip.dataset.chipCardId;
      const blockId = chip.dataset.chipBlockId;
      const token = chip.dataset.chipToken;

      if (!propertyType || !cardId || !blockId || !token) return;
      if (propertyType === "tag") return;

      event.preventDefault();
      event.stopPropagation();

      setActiveChipEdit({
        propertyType,
        cardId,
        blockId,
        token,
        anchorRect: chip.getBoundingClientRect(),
      });
    };

    el.addEventListener("click", handleChipClick, true);
    return () => el.removeEventListener("click", handleChipClick, true);
  }, []);

  const handleChipSelect = useCallback(
    (propertyType: string, _cardId: string, value: string, blockId: string) => {
      const runtime = editor as unknown as {
        getBlock: (id: string) => { type?: string; props?: Record<string, unknown> } | undefined;
        updateBlock: (id: string, update: { props: Record<string, unknown> }) => void;
      };

      if (typeof runtime.getBlock !== "function") return;
      if (typeof runtime.updateBlock !== "function") return;

      const block = runtime.getBlock(blockId);
      if (!block || block.type !== "cardToggle") return;

      const props = typeof block.props === "object" && block.props
        ? block.props
        : {};
      const currentMeta = typeof props.meta === "string" ? props.meta : "";
      const currentSnapshot = typeof props.snapshot === "string" ? props.snapshot : "";
      const nextMeta = applyCardToggleMetaEdit(
        currentMeta,
        propertyType as "priority" | "estimate" | "status",
        value,
      );
      if (nextMeta === currentMeta) return;

      const nextSnapshot = updateCardToggleSnapshotForMetaEdit(
        currentSnapshot,
        propertyType as "priority" | "estimate" | "status",
        value,
      );
      runtime.updateBlock(blockId, {
        props: {
          ...props,
          meta: nextMeta,
          snapshot: nextSnapshot,
        },
      });
    },
    [editor],
  );

  const handleChipEditorClose = useCallback(() => {
    setActiveChipEdit(null);
  }, []);

  const closeSendBlocksDialog = useCallback(() => {
    setSendBlocksDialog(null);
  }, []);

  const openSendBlocksDialog = useCallback(
    (mode: SendBlocksMode, fallbackBlockId: string) => {
      if (!sourceCardContext) return;

      const container = containerRef.current;
      if (!container) return;

      const dropEditor = editor as unknown as EditorForExternalBlockDrop & EditorForInlineViewDrop;
      const selection = resolveSendBlockSelection(dropEditor, container, fallbackBlockId);
      if (selection.blockIds.length === 0) return;

      if (selection.blockIds.some((blockId) => blockHasProjectedAncestor(dropEditor, blockId))) {
        return;
      }

      setSendBlocksDialog({
        mode,
        blockIds: selection.blockIds,
        blocks: selection.blocks,
      });
    },
    [editor, sourceCardContext],
  );

  const handleAppendBlocksToCard = useCallback(
    async ({
      projectId: targetProjectId,
      columnId: targetColumnId,
      cardId: targetCardId,
    }: {
      projectId: string;
      columnId: string;
      cardId: string;
    }) => {
      if (!sourceCardContext || !sendBlocksDialog) {
        throw new Error("No blocks selected.");
      }
      if (targetProjectId === projectId && targetCardId === sourceCardContext.cardId) {
        throw new Error("Choose a different destination card.");
      }

      const boardResult = await invoke("board:get", targetProjectId);
      if (!isBoard(boardResult)) {
        throw new Error("Unable to load destination card.");
      }
      const targetColumn = boardResult.columns.find((column) => column.id === targetColumnId);
      if (!targetColumn) {
        throw new Error("Destination column not found.");
      }
      const targetCard = targetColumn.cards.find((card) => card.id === targetCardId);
      if (!targetCard) {
        throw new Error("Destination card not found.");
      }

      const dropEditor = editor as unknown as EditorForExternalBlockDrop;
      const sourceSnapshot = snapshotEditorDocument(dropEditor);
      const baselineSourceDescription = serializeEditorToNfm();
      const targetBlocks = parseNfm(targetCard.description ?? "");
      const transferableBlocks = stripProjectedSubtrees(sendBlocksDialog.blocks) as DragSessionBlock[];
      const movedBlocks = blockNoteToNfm(transferableBlocks);
      const nextTargetDescription = serializeNfm([...targetBlocks, ...movedBlocks]);

      suppressExternalDropRef.current = true;
      try {
        runInEditorTransaction(dropEditor, () => {
          dropEditor.removeBlocks(sendBlocksDialog.blockIds);
        });

        const nextSourceDescription = serializeEditorToNfm();
        if (nextSourceDescription === baselineSourceDescription) {
          restoreEditorDocument(dropEditor, sourceSnapshot);
          throw new Error("Unable to move selected blocks.");
        }

        await invoke(
          "card:import-block-drop",
          targetProjectId,
          {
            targetColumnId,
            cards: [],
            sourceUpdates: [
              {
                projectId,
                columnId: sourceCardContext.columnId,
                cardId: sourceCardContext.cardId,
                updates: { description: nextSourceDescription },
              },
              {
                projectId: targetProjectId,
                columnId: targetColumnId,
                cardId: targetCardId,
                updates: { description: nextTargetDescription },
              },
            ],
            groupId: crypto.randomUUID(),
          },
        );
        lastEmittedRef.current = nextSourceDescription;
      } catch (error) {
        restoreEditorDocument(dropEditor, sourceSnapshot);
        throw error;
      } finally {
        suppressExternalDropRef.current = false;
      }
    },
    [editor, projectId, sendBlocksDialog, serializeEditorToNfm, sourceCardContext],
  );

  const handleSendBlocksToProject = useCallback(
    async ({
      projectId: targetProjectId,
      columnId: targetColumnId,
    }: {
      projectId: string;
      columnId: string;
    }) => {
      if (!sourceCardContext || !sendBlocksDialog) {
        throw new Error("No blocks selected.");
      }

      const transferableBlocks = stripProjectedSubtrees(sendBlocksDialog.blocks) as DragSessionBlock[];
      const cards = mapDraggedBlocksToCardInputs(transferableBlocks);
      if (cards.length === 0) {
        throw new Error("Unable to build cards from the selected blocks.");
      }

      const dropEditor = editor as unknown as EditorForExternalBlockDrop;
      const sourceSnapshot = snapshotEditorDocument(dropEditor);
      const baselineSourceDescription = serializeEditorToNfm();

      suppressExternalDropRef.current = true;
      try {
        runInEditorTransaction(dropEditor, () => {
          dropEditor.removeBlocks(sendBlocksDialog.blockIds);
        });

        const nextSourceDescription = serializeEditorToNfm();
        if (nextSourceDescription === baselineSourceDescription) {
          restoreEditorDocument(dropEditor, sourceSnapshot);
          throw new Error("Unable to move selected blocks.");
        }

        await invoke(
          "card:import-block-drop",
          targetProjectId,
          {
            targetColumnId,
            cards,
            sourceUpdates: [
              {
                projectId,
                columnId: sourceCardContext.columnId,
                cardId: sourceCardContext.cardId,
                updates: { description: nextSourceDescription },
              },
            ],
            groupId: crypto.randomUUID(),
          },
        );
        lastEmittedRef.current = nextSourceDescription;
      } catch (error) {
        restoreEditorDocument(dropEditor, sourceSnapshot);
        throw error;
      } finally {
        suppressExternalDropRef.current = false;
      }
    },
    [editor, projectId, sendBlocksDialog, serializeEditorToNfm, sourceCardContext],
  );

  const externalDropAdapter = useMemo(() => {
    if (!sourceCardContext) return null;
    return createCardStageDropAdapter(
      {
        projectId,
        cardId: sourceCardContext.cardId,
        columnId: sourceCardContext.columnId,
      },
      () => {
        suppressExternalDropRef.current = true;
        return () => {
          suppressExternalDropRef.current = false;
        };
      },
    );
  }, [projectId, sourceCardContext]);

  useEditorDragBehaviors({
    editor,
    containerRef,
    externalDropAdapter,
  });
  useSideMenuSelectionGuard(containerRef);

  const applyCardImportDrop = useCallback(
    (payload: ExternalCardDragPayload, pointer: { x: number; y: number }) => {
      if (!sourceCardContext) return null;
      const container = containerRef.current;
      if (!container) return null;

      const baselineDescription = serializeEditorToNfm();
      const dropEditor = editor as unknown as EditorForExternalBlockDrop;
      const snapshot = snapshotEditorDocument(dropEditor);
      const droppedBlocks = payload.cards.map((entry) =>
        mapCardToDroppedCardToggleBlock(
          entry.card,
          payload.projectId,
          entry.columnId,
          entry.columnName,
        )
      );

      suppressExternalDropRef.current = true;
      try {
        const inserted = insertCardTogglesAtPointer(
          editor as unknown as EditorForCardDropInsert,
          container,
          pointer,
          droppedBlocks,
        );
        if (!inserted) {
          suppressExternalDropRef.current = false;
          return null;
        }

        const nextDescription = serializeEditorToNfm();
        if (nextDescription === baselineDescription) {
          restoreEditorDocument(dropEditor, snapshot);
          suppressExternalDropRef.current = false;
          return null;
        }

        lastEmittedRef.current = nextDescription;
        return {
          targetUpdates: [
            {
              projectId,
              columnId: sourceCardContext.columnId,
              cardId: sourceCardContext.cardId,
              updates: { description: nextDescription },
            },
          ],
          rollback: () => {
            restoreEditorDocument(dropEditor, snapshot);
          },
          cleanup: () => {
            suppressExternalDropRef.current = false;
          },
        };
      } catch {
        restoreEditorDocument(dropEditor, snapshot);
        suppressExternalDropRef.current = false;
        return null;
      }
    },
    [editor, projectId, serializeEditorToNfm, sourceCardContext],
  );

  const handleCardImportHover = useCallback(
    (
      hover: boolean,
      pointer: { x: number; y: number } | null,
      payload: ExternalCardDragPayload | null,
    ) => {
      void payload;
      const container = containerRef.current;
      if (!container) return;

      if (!hover || !pointer) {
        clearCardDropIndicator(container);
        return;
      }

      const indicator = resolveCardDropIndicatorPosition(
        editor as unknown as EditorForCardDropInsert,
        container,
        pointer,
      );
      renderCardDropIndicator(container, indicator);
    },
    [editor],
  );

  useCardImportDropTarget({
    containerRef,
    enabled: sourceCardContext !== undefined,
    getTargetCardIds: () => (sourceCardContext ? [sourceCardContext.cardId] : []),
    applyDrop: applyCardImportDrop,
    setHover: handleCardImportHover,
  });

  const handleInlineEmbedDrop = useCallback(
    async (event: DragEvent) => {
      if (!sourceCardContext) return;

      const container = containerRef.current;
      if (!container) return;

      const dropEditor = editor as unknown as EditorForExternalBlockDrop & EditorForCardDropInsert;
      const draggedIds = resolveDraggedBlockIds(dropEditor, container);
      if (draggedIds.length === 0) return;

      const draggedBlocks = resolveTopLevelDraggedBlocks(dropEditor, draggedIds);
      if (draggedBlocks.length === 0) return;
      const pointer = { x: event.clientX, y: event.clientY };
      const anchor = resolveCardDropAnchor(container, pointer);
      if (draggedBlocks.length === 1) {
        const draggedBlock = draggedBlocks[0];
        if (!draggedBlock) return;

        const dropSource = resolveProjectedCardDropSource(draggedBlock);
        if (dropSource) {
          if (
            anchor
            && isBlockWithinOwnerTree(
              (blockId) => dropEditor.getParentBlock(blockId),
              dropSource.ownerBlockId,
              anchor.blockId,
            )
          ) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();

          const baselineDescription = serializeEditorToNfm();
          const snapshot = snapshotEditorDocument(dropEditor);
          const droppedBlock = materializeProjectedCardToggleBlock(draggedBlock, dropSource);

          suppressExternalDropRef.current = true;
          try {
            const inserted = insertCardToggleAtPointer(
              dropEditor,
              container,
              pointer,
              droppedBlock,
            );
            if (!inserted) {
              restoreEditorDocument(dropEditor, snapshot);
              return;
            }

            const nextDescription = serializeEditorToNfm();
            if (nextDescription === baselineDescription) {
              restoreEditorDocument(dropEditor, snapshot);
              return;
            }

            const result = await moveCardDropToEditor({
              sourceProjectId: dropSource.sourceProjectId,
              sourceCardId: dropSource.sourceCardId,
              sourceColumnId: dropSource.sourceColumnId,
              targetUpdates: [
                {
                  projectId,
                  columnId: sourceCardContext.columnId,
                  cardId: sourceCardContext.cardId,
                  updates: { description: nextDescription },
                },
              ],
              groupId: crypto.randomUUID(),
            });

            if (!result) {
              restoreEditorDocument(dropEditor, snapshot);
              return;
            }

            lastEmittedRef.current = nextDescription;
            return;
          } catch {
            restoreEditorDocument(dropEditor, snapshot);
            return;
          } finally {
            suppressExternalDropRef.current = false;
          }
        }
      }

      if (draggedBlocks.some((block) => resolveProjectedCardDropSource(block) !== null)) {
        return;
      }

      if (draggedIds.some((blockId) => blockHasProjectedAncestor(dropEditor, blockId))) {
        return;
      }

      const dropContext = resolveInlineViewDropContext(dropEditor, anchor);
      if (!dropContext) return;
      if (draggedIds.includes(dropContext.ownerBlockId)) return;
      if (
        draggedIds.some((blockId) =>
          isBlockWithinOwnerTree(
            (id) => dropEditor.getParentBlock(id),
            blockId,
            dropContext.ownerBlockId,
          ),
        )
      ) {
        return;
      }

      const cardsToCreate = mapDraggedBlocksToCardInputs(draggedBlocks);
      if (cardsToCreate.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      const boardResult = await invoke("board:get", dropContext.sourceProjectId);
      if (!isBoard(boardResult)) return;

      const inferredDrop = inferInlineViewDropImport({
        settings: dropContext.settings,
        projectedRows: dropContext.projectedRows,
        insertRowIndex: dropContext.insertRowIndex,
        board: boardResult,
        cards: cardsToCreate,
      });
      if (inferredDrop.cards.length === 0) return;

      const baselineDescription = serializeEditorToNfm();
      const snapshot = snapshotEditorDocument(dropEditor);

      suppressExternalDropRef.current = true;
      try {
        runInEditorTransaction(dropEditor, () => {
          dropEditor.removeBlocks(draggedIds);
        });

        const nextDescription = serializeEditorToNfm();
        if (nextDescription === baselineDescription) {
          restoreEditorDocument(dropEditor, snapshot);
          return;
        }

        const sourceUpdates: BlockDropImportSourceUpdate[] = [
          {
            projectId,
            columnId: sourceCardContext.columnId,
            cardId: sourceCardContext.cardId,
            updates: { description: nextDescription },
          },
        ];

        await invoke(
          "card:import-block-drop",
          dropContext.sourceProjectId,
          {
            targetColumnId: inferredDrop.targetColumnId,
            ...(inferredDrop.insertIndex !== undefined ? { insertIndex: inferredDrop.insertIndex } : {}),
            cards: inferredDrop.cards,
            sourceUpdates,
            groupId: crypto.randomUUID(),
          },
        );
        lastEmittedRef.current = nextDescription;
      } catch {
        restoreEditorDocument(dropEditor, snapshot);
      } finally {
        suppressExternalDropRef.current = false;
      }
    },
    [
      editor,
      moveCardDropToEditor,
      projectId,
      serializeEditorToNfm,
      sourceCardContext,
    ],
  );

  useEffect(() => {
    if (!sourceCardContext) return;
    const container = containerRef.current;
    if (!container) return;

    const onDropCapture = (event: DragEvent) => {
      void handleInlineEmbedDrop(event);
    };

    container.addEventListener("drop", onDropCapture, true);
    return () => {
      container.removeEventListener("drop", onDropCapture, true);
    };
  }, [handleInlineEmbedDrop, sourceCardContext]);

  const customSideMenu = useCallback(
    () => (
      <NfmSideMenu
        dragHandleMenu={({ releaseSideMenuFreeze }) => (
          <NfmDragHandleMenu
            canSendBlocks={sourceCardContext !== undefined}
            onSendBlocks={openSendBlocksDialog}
            releaseSideMenuFreeze={releaseSideMenuFreeze}
          />
        )}
      />
    ),
    [openSendBlocksDialog, sourceCardContext],
  );

  const activeMatchLabel =
    searchMatchCount === 0
      ? "0 of 0"
      : `${Math.max(searchActiveIndex + 1, 0)} of ${searchMatchCount}`;

  return (
    <div ref={containerRef} className={cn("nfm-editor", className)} spellCheck={spellcheck}>
      {searchOpen && (
        <div className="pointer-events-none sticky top-2 z-90 flex h-0 justify-end">
          <div className="pointer-events-auto mr-2 flex w-fit max-w-[calc(100%-16px)] flex-col self-start overflow-hidden rounded-lg border border-(--border) bg-(--card) shadow-[0_2px_8px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.32),0_0_0_1px_rgba(255,255,255,0.06)]">
            <div className="flex items-center gap-0.5 px-1 py-1 pl-2.5">
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    navigateSearch(e.shiftKey ? "prev" : "next", true);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
                placeholder="Find in description"
                className="h-7 min-w-35 flex-1 border-none bg-transparent text-base/7 font-normal text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                aria-label="Find in description"
              />
              <span className="min-w-10.5 pr-0.5 text-right text-xs whitespace-nowrap text-(--foreground-tertiary) tabular-nums">{activeMatchLabel}</span>
              <button
                type="button"
                className="inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) transition-background-color duration-swift ease-out hover:bg-(--background-tertiary) hover:text-(--foreground)"
                onClick={() => navigateSearch("prev", true)}
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp className="size-4" />
              </button>
              <button
                type="button"
                className="inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) transition-background-color duration-swift ease-out hover:bg-(--background-tertiary) hover:text-(--foreground)"
                onClick={() => navigateSearch("next", true)}
                aria-label="Next match"
                title="Next match (Enter)"
              >
                <ChevronDown className="size-4" />
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) transition-background-color duration-swift ease-out hover:bg-(--background-tertiary) hover:text-(--foreground)",
                  replaceOpen && "text-(--accent-blue)"
                )}
                onClick={() => setReplaceOpen((prev) => !prev)}
                aria-label={replaceOpen ? "Hide replace controls" : "Show replace controls"}
                title={replaceOpen ? "Hide replace controls" : "Show replace controls"}
              >
                <Repeat2 className="size-4" />
              </button>
              <button
                type="button"
                className="inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) transition-background-color duration-swift ease-out hover:bg-(--background-tertiary) hover:text-(--foreground)"
                onClick={closeSearch}
                aria-label="Close find"
                title="Close (Esc)"
              >
                <X className="size-4" />
              </button>
            </div>

            {replaceOpen && (
              <div className="flex items-center gap-0.5 px-1 py-1 pt-0 pl-2.5">
                <input
                  value={replaceQuery}
                  onChange={(e) => setReplaceQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      replaceCurrentMatch();
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeSearch();
                    }
                  }}
                  placeholder="Replace with..."
                  className="h-7 min-w-30 flex-1 border-none bg-transparent text-base/7 font-normal text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                  aria-label="Replace text"
                />
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    className="h-6.5 cursor-pointer rounded-sm border-none bg-transparent px-2 text-xs font-medium whitespace-nowrap text-(--foreground-secondary) transition-background-color duration-swift ease-out hover:bg-(--background-tertiary) hover:text-(--foreground)"
                    onClick={replaceAllMatches}
                    aria-label="Replace all matches"
                    title="Replace all matches"
                  >
                    Replace all
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-6.5 cursor-pointer items-center gap-1 rounded-sm border-none bg-(--accent-blue) px-2.5 text-xs font-medium whitespace-nowrap text-white transition-filter duration-swift ease-out hover:brightness-110"
                    onClick={replaceCurrentMatch}
                    aria-label="Replace current match"
                    title="Replace current match"
                  >
                    Replace
                    <CornerDownLeft className="size-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <BlockNoteView
        editor={editor}
        onChange={handleChange}
        theme={themeMode}
        formattingToolbar={false}
        slashMenu={false}
        sideMenu={false}
        data-theming-css-variables-demo
      >
        <SideMenuController sideMenu={customSideMenu} />
        <FormattingToolbarController formattingToolbar={NfmFormattingToolbar} />
        <NfmSlashMenu projectId={projectId} />
      </BlockNoteView>
      {activeChipEdit && (
        <ChipPropertyEditor
          propertyType={activeChipEdit.propertyType}
          currentToken={activeChipEdit.token}
          cardId={activeChipEdit.cardId}
          anchorRect={activeChipEdit.anchorRect}
          onSelect={(propertyType, cardId, value) => {
            handleChipSelect(propertyType, cardId, value, activeChipEdit.blockId);
          }}
          onClose={handleChipEditorClose}
        />
      )}
      {sendBlocksDialog && sourceCardContext && (
        <SendBlocksDialog
          open={sendBlocksDialog !== null}
          mode={sendBlocksDialog.mode}
          blockCount={sendBlocksDialog.blockIds.length}
          sourceProjectId={projectId}
          sourceCardId={sourceCardContext.cardId}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeSendBlocksDialog();
          }}
          onAppendToCard={handleAppendBlocksToCard}
          onSendToProject={handleSendBlocksToProject}
        />
      )}
      {imagePreview && (
        <ImagePreviewDialog
          open={imagePreview !== null}
          source={imagePreview.source}
          alt={imagePreview.alt}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setImagePreview(null);
            }
          }}
        />
      )}
    </div>
  );
}
