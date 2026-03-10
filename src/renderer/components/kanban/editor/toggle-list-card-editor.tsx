import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattingToolbarController, SideMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";
import { resolveAssetSourceToHttpUrl, uploadImageAsset } from "@/lib/assets";
import type { CardInput, Estimate, MoveCardInput } from "@/lib/types";
import type { Priority } from "@/lib/types";
import {
  blockToCardPatch,
  cardToToggleBlock,
  hasCardToggleStructure,
  makeCardToggleBlockId,
} from "@/lib/toggle-list/block-mapping";
import {
  buildInboundUpdates,
  buildOutboundPatches,
} from "@/lib/toggle-list/sync";
import type {
  ToggleListCard,
  ToggleListPropertyKey,
} from "@/lib/toggle-list/types";
import type { MetaChipPropertyType } from "@/lib/toggle-list/meta-chips";
import { useSpellcheck } from "@/lib/use-spellcheck";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { EDITOR_SYNC_DEBOUNCE_MS } from "@/lib/timing";
import { createNfmEditorExtensions, createNfmPasteHandler, NFM_DISABLED_EXTENSIONS } from "./nfm-editor-extensions";
import { createNfmLinkExtension } from "./nfm-link-extension";
import { NfmSideMenu } from "./nfm-side-menu";
import {
  deferCollapsedToggleVerticalArrowToBrowser,
  type InlineArrowDirection,
  registerInlineSummaryBoundaryHandle,
  unregisterInlineSummaryBoundaryHandle,
} from "./inline-view-arrow-nav";
import { ChipPropertyEditor } from "./chip-property-editor";
import { createToggleListDropAdapter } from "./external-drop-adapters";
import { useCardImportDropTarget } from "./use-card-import-drop-target";
import { mapCardToDroppedCardToggleBlock } from "./card-drop-toggle-mapper";
import {
  insertCardTogglesAtPointer,
  resolveCardDropIndicatorPosition,
  type EditorForCardDropInsert,
} from "./card-drop-insert";
import {
  clearCardDropIndicator,
  renderCardDropIndicator,
} from "./card-drop-indicator";
import { NfmFormattingToolbar } from "./nfm-formatting-toolbar";
import { ImagePreviewDialog } from "./image-preview-dialog";
import {
  isSpaceShortcut,
  resolveImagePreviewByBlockId,
  resolveFocusedImagePreview,
  type ImageBlockLookupEditor,
  type ImageSelectionEditor,
} from "./image-preview-shortcut";
import { NfmSlashMenu } from "./nfm-slash-menu";
import { useEditorDragBehaviors } from "./use-editor-drag-behaviors";
import {
  restoreEditorDocument,
  snapshotEditorDocument,
} from "./external-block-drag-session";
import type { ExternalCardDragPayload } from "./external-card-drag-session";
import { useSideMenuSelectionGuard } from "./side-menu-selection-guard";
import {
  applyCardToggleMetaEdit,
  updateCardToggleSnapshotForMetaEdit,
} from "./card-toggle-snapshot";
import { shouldSuppressPreferIndentBoundaryTab } from "./prefer-indent-tab-boundary";
import { shouldRejectToggleListStructureChange } from "./projection-structure-guard";

interface ActiveChipEdit {
  propertyType: Exclude<MetaChipPropertyType, "tag">;
  cardId: string;
  blockId: string;
  token: string;
  anchorRect: DOMRect;
}

interface ToggleListCardEditorProps {
  schema: unknown;
  projectId: string;
  cards: ToggleListCard[];
  propertyOrder: ToggleListPropertyKey[];
  hiddenProperties: ToggleListPropertyKey[];
  updateCard: (columnId: string, cardId: string, updates: Partial<CardInput>) => Promise<unknown>;
  moveCard?: (input: MoveCardInput) => Promise<boolean>;
  showEmptyEstimate?: boolean;
  className?: string;
  placeholder?: string;
  boundaryRegistryId?: string;
  onBoundaryArrow?: (direction: InlineArrowDirection) => boolean;
}

interface ToggleListCardEditorChange {
  type: "insert" | "delete" | "move" | "update";
  block: { id?: string; type: string; props?: Record<string, unknown> };
  prevBlock?: { id?: string; type: string; props?: Record<string, unknown> };
}

type ToggleListCardEditorRuntime = Parameters<typeof BlockNoteView>[0]["editor"] & {
  document: unknown[];
  onBeforeChange: (listener: (event: { getChanges: () => ToggleListCardEditorChange[] }) => boolean | void) => () => void;
  onChange: (listener: () => void) => () => void;
  replaceBlocks: (toRemove: unknown[], replacements: unknown[]) => void;
  updateBlock: (id: string, update: unknown) => void;
  setTextCursorPosition: (blockId: string, placement: "start" | "end") => void;
  focus: () => void;
  getTextCursorPosition: () => { block: { id: string; type: string } };
  transact: <T>(fn: (tr: { selection: InlineArrowSelection }) => T) => T;
};

interface InlineArrowSelection {
  anchor: number;
  head: number;
  $anchor: {
    parentOffset: number;
    parent: {
      content: {
        size: number;
      };
    };
  };
}

function isSelectionAtBlockBoundary(
  editor: {
    transact: <T>(fn: (tr: { selection: InlineArrowSelection }) => T) => T;
  },
  direction: InlineArrowDirection,
): boolean {
  return editor.transact((tr) => {
    const { anchor, head, $anchor } = tr.selection;
    if (anchor !== head) return false;

    if (direction === "prev") {
      return $anchor.parentOffset === 0;
    }

    return $anchor.parentOffset === $anchor.parent.content.size;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToggleBlock(value: unknown): value is { id: string; children?: unknown[] } {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.type !== "string") return false;

  if (value.type === "toggleListItem") return true;
  if (value.type !== "heading") return false;
  if (!isRecord(value.props)) return false;
  return value.props.isToggleable === true;
}

function findBlockById(blocks: unknown[], blockId: string): unknown | null {
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.id === blockId) return block;
    if (!Array.isArray(block.children)) continue;

    const nested = findBlockById(block.children, blockId);
    if (nested) return nested;
  }

  return null;
}

function collectToggleBlockIds(blocks: unknown[]): string[] {
  const ids: string[] = [];

  for (const block of blocks) {
    if (isToggleBlock(block)) {
      ids.push(block.id);
    }

    if (!isRecord(block) || !Array.isArray(block.children)) continue;
    ids.push(...collectToggleBlockIds(block.children));
  }

  return ids;
}

function collectCardDescriptionPatches(
  blocks: unknown[],
  container: HTMLElement | undefined,
): Map<string, string> {
  const patches = new Map<string, string>();

  for (const block of blocks) {
    const patch = blockToCardPatch(block, container);
    if (!patch) continue;
    patches.set(patch.cardId, patch.description);
  }

  return patches;
}

export function ToggleListCardEditor({
  schema,
  projectId,
  cards,
  propertyOrder,
  hiddenProperties,
  updateCard,
  moveCard,
  showEmptyEstimate = false,
  className,
  placeholder = "Toggle list row title",
  boundaryRegistryId,
  onBoundaryArrow,
}: ToggleListCardEditorProps) {
  const { resolved: themeMode } = useTheme();
  const { spellcheck } = useSpellcheck();
  const [activeChipEdit, setActiveChipEdit] = useState<ActiveChipEdit | null>(null);
  const [imagePreview, setImagePreview] = useState<{ source: string; alt: string } | null>(null);
  const chipEditOpenRef = useRef(false);
  const cardIds = useMemo(() => cards.map((card) => card.id), [cards]);
  const cardById = useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );
  const cardToggleBlockIds = useMemo(
    () => cards.map((card) => makeCardToggleBlockId(projectId, card.id)),
    [cards, projectId],
  );
  const nextBlocksPayload = useMemo(
    () => {
      const toggleStates = new Map<string, boolean>();
      const blocks = cards.map((card) =>
        cardToToggleBlock(
          projectId,
          card,
          propertyOrder,
          hiddenProperties,
          toggleStates,
          showEmptyEstimate,
        ),
      );
      return { blocks, toggleStates };
    },
    [cards, hiddenProperties, projectId, propertyOrder, showEmptyEstimate],
  );

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

  const editor = useCreateBlockNote(
    {
      schema: schema as never,
      tabBehavior: "prefer-indent",
      trailingBlock: false,
      placeholders: { default: placeholder },
      uploadFile,
      resolveFileUrl,
      pasteHandler,
      disableExtensions: [...NFM_DISABLED_EXTENSIONS, "link"],
      extensions,
      _tiptapOptions: {
        extensions: tiptapExtensions,
      },
    } as never,
    [projectId],
  ) as unknown as ToggleListCardEditorRuntime;

  const containerRef = useRef<HTMLDivElement>(null);
  const cardByIdRef = useRef(cardById);
  const dirtyCardIdsRef = useRef<Set<string>>(new Set());
  const inFlightCardIdsRef = useRef<Set<string>>(new Set());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isApplyingRef = useRef(false);
  const allowStructuralChangesRef = useRef(false);
  const hasFocusWithinRef = useRef(false);
  const pendingInboundSyncRef = useRef(false);
  const trackedToggleBlockIdsRef = useRef<Set<string>>(new Set());
  const suppressExternalDropSyncDepthRef = useRef(0);

  const externalDropAdapter = useMemo(
    () =>
      createToggleListDropAdapter(projectId, cards, () => {
        suppressExternalDropSyncDepthRef.current += 1;
        return () => {
          suppressExternalDropSyncDepthRef.current = Math.max(
            0,
            suppressExternalDropSyncDepthRef.current - 1,
          );
        };
      }),
    [cards, projectId],
  );

  useEditorDragBehaviors({
    editor,
    containerRef,
    externalDropAdapter,
  });
  useSideMenuSelectionGuard(containerRef);

  useEffect(() => {
    cardByIdRef.current = cardById;
  }, [cardById]);

  const applyEditorUpdates = useCallback((updater: () => void) => {
    isApplyingRef.current = true;
    allowStructuralChangesRef.current = true;
    try {
      updater();
    } finally {
      allowStructuralChangesRef.current = false;
      isApplyingRef.current = false;
    }
  }, []);

  const removeToggleStateEntries = useCallback((blockIds: readonly string[]) => {
    for (const blockId of blockIds) {
      localStorage.removeItem(`toggle-${blockId}`);
      trackedToggleBlockIdsRef.current.delete(blockId);
    }
  }, []);

  const addToggleStateEntries = useCallback((toggleStates: ReadonlyMap<string, boolean>) => {
    for (const [blockId, isOpen] of toggleStates) {
      localStorage.setItem(`toggle-${blockId}`, isOpen ? "true" : "false");
      trackedToggleBlockIdsRef.current.add(blockId);
    }
  }, []);

  const replaceToggleStateEntries = useCallback(
    (toggleStates: ReadonlyMap<string, boolean>) => {
      removeToggleStateEntries([...trackedToggleBlockIdsRef.current]);
      addToggleStateEntries(toggleStates);
    },
    [addToggleStateEntries, removeToggleStateEntries],
  );

  const applyCardImportDrop = useCallback(
    (payload: ExternalCardDragPayload, pointer: { x: number; y: number }) => {
      const container = containerRef.current;
      if (!container) return null;

      const baselinePatches = collectCardDescriptionPatches(editor.document, container);
      const snapshot = snapshotEditorDocument(editor);
      const droppedBlocks = payload.cards.map((entry) =>
        mapCardToDroppedCardToggleBlock(
          entry.card,
          payload.projectId,
          entry.columnId,
          entry.columnName,
        )
      );

      suppressExternalDropSyncDepthRef.current += 1;
      try {
        let inserted = false;
        applyEditorUpdates(() => {
          inserted = insertCardTogglesAtPointer(
            editor as unknown as EditorForCardDropInsert,
            container,
            pointer,
            droppedBlocks,
            { inlineOnly: true },
          );
        });

        if (!inserted) {
          suppressExternalDropSyncDepthRef.current = Math.max(
            0,
            suppressExternalDropSyncDepthRef.current - 1,
          );
          return null;
        }

        const nextPatches = collectCardDescriptionPatches(editor.document, container);
        const targetUpdates = cards.flatMap((card) => {
          const previousDescription = baselinePatches.get(card.id);
          const nextDescription = nextPatches.get(card.id);
          if (nextDescription === undefined) return [];
          if (previousDescription === nextDescription) return [];

          return [{
            projectId,
            columnId: card.columnId,
            cardId: card.id,
            updates: {
              description: nextDescription,
            },
          }];
        });

        if (targetUpdates.length === 0) {
          applyEditorUpdates(() => {
            restoreEditorDocument(editor, snapshot);
          });
          suppressExternalDropSyncDepthRef.current = Math.max(
            0,
            suppressExternalDropSyncDepthRef.current - 1,
          );
          return null;
        }

        return {
          targetUpdates,
          rollback: () => {
            applyEditorUpdates(() => {
              restoreEditorDocument(editor, snapshot);
            });
          },
          cleanup: () => {
            suppressExternalDropSyncDepthRef.current = Math.max(
              0,
              suppressExternalDropSyncDepthRef.current - 1,
            );
          },
        };
      } catch {
        applyEditorUpdates(() => {
          restoreEditorDocument(editor, snapshot);
        });
        suppressExternalDropSyncDepthRef.current = Math.max(
          0,
          suppressExternalDropSyncDepthRef.current - 1,
        );
        return null;
      }
    },
    [applyEditorUpdates, cards, editor, projectId],
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
        { inlineOnly: true },
      );
      renderCardDropIndicator(container, indicator);
    },
    [editor],
  );

  useCardImportDropTarget({
    containerRef,
    getTargetCardIds: () => cardIds,
    applyDrop: applyCardImportDrop,
    setHover: handleCardImportHover,
  });

  const flushOutboundSync = useCallback(async () => {
    if (isApplyingRef.current) return;
    if (suppressExternalDropSyncDepthRef.current > 0) return;

    const patches = buildOutboundPatches(
      editor.document,
      cardByIdRef.current,
      containerRef.current ?? undefined,
    )
      .filter((patch) => !inFlightCardIdsRef.current.has(patch.cardId));

    if (patches.length === 0) return;

    await Promise.all(
      patches.map(async (patch) => {
        dirtyCardIdsRef.current.add(patch.cardId);
        inFlightCardIdsRef.current.add(patch.cardId);

        try {
          await updateCard(patch.columnId, patch.cardId, patch.updates);
        } finally {
          inFlightCardIdsRef.current.delete(patch.cardId);
          dirtyCardIdsRef.current.delete(patch.cardId);
        }
      }),
    );
  }, [editor, updateCard]);

  useEffect(() => {
    const unsubscribe = editor.onBeforeChange(({ getChanges }) => {
      if (allowStructuralChangesRef.current) return;

      if (shouldRejectToggleListStructureChange(getChanges())) {
        return false;
      }
    },
    );

    return unsubscribe;
  }, [editor]);

  useEffect(() => {
    const unsubscribe = editor.onChange(() => {
      if (isApplyingRef.current) return;
      if (suppressExternalDropSyncDepthRef.current > 0) return;

      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }

      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = null;
        void flushOutboundSync();
      }, EDITOR_SYNC_DEBOUNCE_MS);
    });

    return unsubscribe;
  }, [editor, flushOutboundSync]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (suppressExternalDropSyncDepthRef.current > 0) continue;
        if (
          mutation.type !== "attributes" ||
          mutation.attributeName !== "data-show-children" ||
          !(mutation.target instanceof HTMLElement) ||
          !mutation.target.classList.contains("bn-toggle-wrapper")
        ) {
          continue;
        }

        if (syncTimerRef.current) {
          clearTimeout(syncTimerRef.current);
          syncTimerRef.current = null;
        }
        void flushOutboundSync();
        return;
      }
    });

    observer.observe(el, {
      attributes: true,
      attributeFilter: ["data-show-children"],
      subtree: true,
    });

    return () => observer.disconnect();
  }, [flushOutboundSync]);

  useEffect(
    () => () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      removeToggleStateEntries([...trackedToggleBlockIdsRef.current]);
    },
    [removeToggleStateEntries],
  );

  const reconcileInbound = useCallback(() => {
    if (isApplyingRef.current) return;
    if (suppressExternalDropSyncDepthRef.current > 0) return;
    if (hasFocusWithinRef.current) {
      pendingInboundSyncRef.current = true;
      return;
    }
    pendingInboundSyncRef.current = false;

    const currentBlocks = editor.document;
    if (!hasCardToggleStructure(currentBlocks, cardIds)) {
      applyEditorUpdates(() => {
        replaceToggleStateEntries(nextBlocksPayload.toggleStates);
        editor.replaceBlocks(editor.document, nextBlocksPayload.blocks);
      });
      return;
    }

    const updates = buildInboundUpdates(
      currentBlocks,
      cardById,
      propertyOrder,
      hiddenProperties,
      dirtyCardIdsRef.current,
      inFlightCardIdsRef.current,
      containerRef.current ?? undefined,
      showEmptyEstimate,
    );
    if (updates.length === 0) return;

    applyEditorUpdates(() => {
      for (const change of updates) {
        if (change.update.children) {
          const currentBlock = findBlockById(editor.document, change.blockId);
          if (currentBlock && isRecord(currentBlock) && Array.isArray(currentBlock.children)) {
            removeToggleStateEntries(collectToggleBlockIds(currentBlock.children));
          }
        }
        if (change.toggleStates) {
          addToggleStateEntries(change.toggleStates);
        }
        editor.updateBlock(change.blockId, change.update);
      }
    });
  }, [
    addToggleStateEntries,
    applyEditorUpdates,
    cardById,
    cardIds,
    editor,
    hiddenProperties,
    nextBlocksPayload,
    propertyOrder,
    removeToggleStateEntries,
    replaceToggleStateEntries,
    showEmptyEstimate,
  ]);

  useEffect(() => {
    reconcileInbound();
  }, [reconcileInbound]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleFocusIn = () => {
      hasFocusWithinRef.current = true;
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) {
        return;
      }
      // Portaled chip editor is outside the container — keep focus-within active
      if (chipEditOpenRef.current) return;

      hasFocusWithinRef.current = false;

      if (!pendingInboundSyncRef.current) return;
      Promise.resolve().then(() => {
        if (!hasFocusWithinRef.current) {
          reconcileInbound();
        }
      });
    };

    el.addEventListener("focusin", handleFocusIn);
    el.addEventListener("focusout", handleFocusOut);

    return () => {
      el.removeEventListener("focusin", handleFocusIn);
      el.removeEventListener("focusout", handleFocusOut);
    };
  }, [reconcileInbound]);

  const focusBoundarySummary = useCallback(
    (direction: InlineArrowDirection): boolean => {
      if (cardToggleBlockIds.length === 0) return false;
      const targetBlockId = direction === "prev"
        ? cardToggleBlockIds[cardToggleBlockIds.length - 1]
        : cardToggleBlockIds[0];
      if (!targetBlockId) return false;

      const placement = direction === "prev" ? "end" : "start";
      try {
        editor.setTextCursorPosition(targetBlockId, placement);
        editor.focus();
        return true;
      } catch {
        return false;
      }
    },
    [cardToggleBlockIds, editor],
  );

  useEffect(() => {
    if (!boundaryRegistryId) return;
    const handle = { focusBoundarySummary };
    registerInlineSummaryBoundaryHandle(boundaryRegistryId, handle);

    return () => {
      unregisterInlineSummaryBoundaryHandle(boundaryRegistryId, handle);
    };
  }, [boundaryRegistryId, focusBoundarySummary]);

  const handleBoundaryArrow = useCallback(
    (direction: InlineArrowDirection): boolean => {
      if (!onBoundaryArrow || cardToggleBlockIds.length === 0) return false;

      const cursor = editor.getTextCursorPosition();
      if (cursor.block.type !== "cardToggle") return false;

      const edgeBlockId = direction === "prev"
        ? cardToggleBlockIds[0]
        : cardToggleBlockIds[cardToggleBlockIds.length - 1];
      if (!edgeBlockId || cursor.block.id !== edgeBlockId) return false;
      if (!isSelectionAtBlockBoundary(editor, direction)) return false;

      return onBoundaryArrow(direction);
    },
    [cardToggleBlockIds, editor, onBoundaryArrow],
  );

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
      if (targetIsTextField) return;

      if (
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

      if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) {
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

      if (!isSpaceShortcut(event)) return;

      const focusedImage = resolveFocusedImagePreview(editor as unknown as ImageSelectionEditor);
      if (!focusedImage) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) return;

      setImagePreview({
        source: resolveAssetSourceToHttpUrl(focusedImage.source),
        alt: focusedImage.alt,
      });
    };

    el.addEventListener("keydown", handleKeyDown, true);
    return () => {
      el.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [editor]);

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
    if (!onBoundaryArrow) return;

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
      if (targetIsTextField) return;

      if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (event.key === "ArrowUp" && handleBoundaryArrow("prev")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.key === "ArrowDown" && handleBoundaryArrow("next")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    el.addEventListener("keydown", handleKeyDown, true);
    return () => {
      el.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [handleBoundaryArrow, onBoundaryArrow]);

  // Keep chipEditOpenRef in sync with state
  useEffect(() => {
    chipEditOpenRef.current = activeChipEdit !== null;
  }, [activeChipEdit]);

  // Event delegation: capture clicks on editable meta chips
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
    async (propertyType: string, cardId: string, value: string, blockId: string) => {
      const card = cardByIdRef.current.get(cardId);
      if (!card) {
        const block = findBlockById(editor.document, blockId);
        if (!block || !isRecord(block)) return;
        if (block.type !== "cardToggle") return;

        const props = isRecord(block.props) ? block.props : {};
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
        applyEditorUpdates(() => {
          editor.updateBlock(blockId, {
            props: {
              ...props,
              meta: nextMeta,
              snapshot: nextSnapshot,
            },
          });
        });
        return;
      }

      switch (propertyType) {
        case "priority":
          await updateCard(card.columnId, cardId, { priority: value as Priority });
          break;
        case "estimate":
          await updateCard(card.columnId, cardId, {
            estimate: value === "none" ? null : (value as Estimate),
          });
          break;
        case "status":
          if (moveCard && value !== card.columnId) {
            await moveCard({ cardId, fromColumnId: card.columnId, toColumnId: value });
          }
          break;
      }
    },
    [applyEditorUpdates, editor, moveCard, updateCard],
  );

  const handleChipEditorClose = useCallback(() => {
    setActiveChipEdit(null);
    // If there was a pending inbound sync, trigger it now
    if (pendingInboundSyncRef.current && !hasFocusWithinRef.current) {
      Promise.resolve().then(() => {
        if (!hasFocusWithinRef.current && !chipEditOpenRef.current) {
          reconcileInbound();
        }
      });
    }
  }, [reconcileInbound]);

  return (
    <div ref={containerRef} className={cn("nfm-editor", className)} spellCheck={spellcheck}>
      <BlockNoteView
        editor={editor}
        theme={themeMode}
        formattingToolbar={false}
        slashMenu={false}
        sideMenu={false}
        data-theming-css-variables-demo
      >
        <SideMenuController sideMenu={NfmSideMenu} />
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
            void handleChipSelect(propertyType, cardId, value, activeChipEdit.blockId);
          }}
          onClose={handleChipEditorClose}
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
