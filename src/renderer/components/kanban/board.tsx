import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from "react";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Column } from "./column";
import { type CardPropertyUpdateInput } from "./card";
import {
  emptyCardSelection,
  normalizeCardSelection,
  toggleCardSelection,
  type CardSelectionState,
} from "./card-selection";
import { UndoToast } from "./undo-toast";
import { computeNativeDropIndexFromSurface } from "./native-drop-index";
import { KanbanBoardScrollContainer } from "./view-scroll-containers";
import {
  mapDraggedBlocksToCardInputs,
  resolveTopLevelDraggedBlocks,
} from "./editor/block-drop-card-mapper";
import {
  type CardDropApplyResult,
  clearCardDropTargetHover,
  updateCardDropTargetHover,
} from "./editor/card-drop-target-registry";
import {
  endExternalCardDragSession,
  getActiveExternalCardDragSession,
  startExternalCardDragSession,
  updateExternalCardDragPointer,
} from "./editor/external-card-drag-session";
import {
  endExternalEditorDragSession,
  getActiveExternalEditorDragSession,
  restoreEditorDocument,
  runInEditorTransaction,
  snapshotEditorDocument,
} from "./editor/external-block-drag-session";
import { resolveDraggedBlockIds } from "./editor/drag-source-resolver";
import { invoke } from "@/lib/api";
import { buildCardDeepLink } from "@/lib/card-deeplink";
import {
  getKanbanColumnLayout,
  readKanbanColumnLayoutPrefs,
  updateKanbanColumnLayoutPrefs,
  writeKanbanColumnLayoutPrefs,
  type KanbanColumnLayoutPrefs,
} from "@/lib/kanban-column-layout";
import { useKanban } from "@/lib/use-kanban";
import { useHistory } from "@/lib/use-history";
import { useKeyboardShortcuts } from "@/lib/use-keyboard-shortcuts";
import { writeTextToClipboard } from "@/lib/clipboard";
import {
  filterDbViewCards,
  getDefaultDbViewPrefs,
  hasActiveDbViewFilters,
  hasActiveDbViewSorts,
  sortDbViewCards,
  type DbViewCardRecord,
  type DbViewPrefs,
} from "../../lib/db-view-prefs";
import type {
  Card as CardType,
  CardStatus,
  CardCreatePlacement,
  CardDropMoveToEditorResult,
  CardInput,
  Project,
} from "@/lib/types";
import { buildCardSearchText, matchesSearchTokens, tokenizeSearchQuery } from "@/lib/card-search";
import {
  buildExternalCardDropMoveRequest,
  resolveExternalCardDropTarget,
} from "./board-drop-routing";
import { resolveFilteredDropOrder } from "./filtered-drag-order";
import {
  buildKanbanCardDragData,
  isKanbanCardDragData,
  type KanbanCardDragData,
} from "./pragmatic-drag-data";
import { resolveKanbanDropLocation } from "./pragmatic-drop-location";
import { resolveKanbanCardDropStrategy } from "./kanban-card-drop-strategy";

function hasSameCardSelection(
  left: CardSelectionState,
  right: CardSelectionState,
): boolean {
  if (left.cardIds.size !== right.cardIds.size) return false;

  for (const cardId of left.cardIds) {
    if (!right.cardIds.has(cardId)) return false;
  }

  return true;
}

interface KanbanBoardProps {
  projectId: string;
  projects: Project[];
  searchQuery: string;
  dbViewPrefs: DbViewPrefs | null;
  openCardStage: (
    projectId: string,
    cardId: string,
    titleSnapshot?: string,
  ) => void;
  cardStageCardId: string | undefined;
  cardStageCloseRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

export function KanbanBoard({
  projectId,
  projects,
  searchQuery,
  dbViewPrefs,
  openCardStage,
  cardStageCardId,
  cardStageCloseRef,
}: KanbanBoardProps) {
  // History hooks
  const {
    sessionId,
    lastAction,
    undo,
    redo,
    refreshState: refreshHistoryState,
    clearLastAction,
  } = useHistory(projectId);

  // Pass sessionId to kanban hook so all mutations are tracked
  const {
    board,
    loading,
    error,
    createCard,
    updateCard,
    deleteCard,
    moveCard,
    moveCards,
    moveCardToProject,
    importBlockDrop,
    moveCardDropToEditor,
    refresh,
  } =
    useKanban({
      projectId,
      sessionId,
      onMutation: refreshHistoryState,
    });

  // Keyboard shortcuts for undo/redo
  const handleUndo = useCallback(async () => {
    const success = await undo();
    if (success) {
      refresh(); // Refresh board after undo
    }
  }, [undo, refresh]);

  const handleRedo = useCallback(async () => {
    const success = await redo();
    if (success) {
      refresh(); // Refresh board after redo
    }
  }, [redo, refresh]);

  useKeyboardShortcuts({
    onUndo: handleUndo,
    onRedo: handleRedo,
    enabled: !loading,
  });

  const [cardSelection, setCardSelection] = useState<CardSelectionState>(() => emptyCardSelection());
  const externalCardDragSessionIdRef = useRef<string | undefined>(undefined);
  const boardScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [dragInstanceId] = useState(() => Symbol("kanban-board-dnd"));

  const [dropIndicator, setDropIndicator] = useState<{
    columnId: string;
    index: number;
  } | null>(null);
  const [activeDropColumnId, setActiveDropColumnId] = useState<string | null>(null);
  const [activeDraggedCardIds, setActiveDraggedCardIds] = useState<ReadonlySet<string>>(() => new Set());
  const isKanbanCardDragActive = activeDraggedCardIds.size > 0;

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [columnLayoutPrefs, setColumnLayoutPrefs] = useState<KanbanColumnLayoutPrefs>(
    () => readKanbanColumnLayoutPrefs(projectId),
  );

  const searchTokens = useMemo(
    () => tokenizeSearchQuery(deferredSearchQuery),
    [deferredSearchQuery]
  );
  const viewPrefs = dbViewPrefs ?? getDefaultDbViewPrefs("kanban");
  const hasSearchFilter = searchTokens.length > 0;
  const hasRuleFiltering = hasActiveDbViewFilters("kanban", viewPrefs.rules);
  const hasNonDefaultSort = hasActiveDbViewSorts("kanban", viewPrefs.rules);
  const externalBlockImportDisabled = hasSearchFilter || hasRuleFiltering || hasNonDefaultSort;

  const filteredBoard = useMemo(() => {
    if (!board) return null;

    return {
      ...board,
      columns: board.columns.map((column, columnIndex) => {
        const columnCards = column.cards.map<DbViewCardRecord>((card, cardIndex) => ({
          ...card,
          columnId: column.id,
          columnName: column.name,
          boardIndex: columnIndex * 100_000 + cardIndex,
        }));
        const filteredByRules = filterDbViewCards(columnCards, viewPrefs.rules);
        const filteredBySearch = hasSearchFilter
          ? filteredByRules.filter((card) =>
            matchesSearchTokens(
              `${buildCardSearchText(card)} ${card.columnName.toLowerCase()}`,
              searchTokens,
            ))
          : filteredByRules;

        return {
          ...column,
          cards: sortDbViewCards(filteredBySearch, viewPrefs.rules),
        };
      }),
    };
  }, [board, hasSearchFilter, searchTokens, viewPrefs.rules]);

  useEffect(() => {
    setCardSelection((current) => {
      const normalized = normalizeCardSelection(
        current,
        filteredBoard ?? board,
      );
      return hasSameCardSelection(current, normalized) ? current : normalized;
    });
  }, [board, filteredBoard]);

  useEffect(() => {
    setColumnLayoutPrefs(readKanbanColumnLayoutPrefs(projectId));
  }, [projectId]);

  const currentProjectName = useMemo(
    () => projects.find((project) => project.id === projectId)?.name ?? projectId,
    [projectId, projects],
  );

  const contextMenuProjects = useMemo(
    () => projects.map((project) => ({
      id: project.id,
      name: project.name,
      icon: project.icon,
      description: project.description,
      workspacePath: project.workspacePath,
    })),
    [projects],
  );

  const selectedCardIds = cardSelection.cardIds;

  const resolveColumnSurface = useCallback((columnId: string): HTMLElement | null => {
    if (typeof document === "undefined") return null;

    return document.querySelector<HTMLElement>(`[data-kanban-column-id="${columnId}"]`);
  }, []);

  const buildDragData = useCallback(
    (card: CardType, columnId: string): KanbanCardDragData => buildKanbanCardDragData({
      board: filteredBoard ?? board,
      selection: cardSelection,
      instanceId: dragInstanceId,
      projectId,
      activeCard: card,
      columnId: columnId as CardStatus,
    }),
    [board, cardSelection, dragInstanceId, filteredBoard, projectId],
  );

  const clearBoardCardDragState = useCallback(() => {
    setDropIndicator(null);
    setActiveDropColumnId(null);
    setActiveDraggedCardIds(new Set());
    clearCardDropTargetHover();
    endExternalCardDragSession(externalCardDragSessionIdRef.current);
    externalCardDragSessionIdRef.current = undefined;
  }, []);

  const commitExternalCardDropMove = useCallback(
    async (
      source: {
        projectId: string;
        cards: Array<{
          cardId: string;
          status: CardStatus;
        }>;
      },
      optimisticResult: Pick<CardDropApplyResult, "targetUpdates">,
    ): Promise<CardDropMoveToEditorResult | null> => {
      const moveRequest = buildExternalCardDropMoveRequest({
        sourceProjectId: source.projectId,
        sourceCards: source.cards,
        targetUpdates: optimisticResult.targetUpdates,
        groupId: crypto.randomUUID(),
      });
      if (!moveRequest) return null;

      if (moveRequest.targetProjectId === projectId) {
        return moveCardDropToEditor(moveRequest.input);
      }

      try {
        const result = await invoke(
          "card:move-drop-to-editor",
          moveRequest.targetProjectId,
          moveRequest.input,
          sessionId,
        ) as CardDropMoveToEditorResult;
        await refresh();
        refreshHistoryState();
        return result;
      } catch {
        return null;
      }
    },
    [moveCardDropToEditor, projectId, refresh, refreshHistoryState, sessionId],
  );

  const performCardDrop = useCallback(async (
    dragData: KanbanCardDragData,
    dropTargets: ReadonlyArray<{ data: Record<string | symbol, unknown> }>,
    pointer: { x: number; y: number } | null,
  ) => {
    const cardDragSession = getActiveExternalCardDragSession();

    if (cardDragSession) {
      const target = resolveExternalCardDropTarget(cardDragSession);
      if (target && cardDragSession.pointer) {
        const optimisticResult = target.applyDrop(
          cardDragSession.payload,
          cardDragSession.pointer,
        );
        if (optimisticResult) {
          try {
            const result = await commitExternalCardDropMove(
              {
                projectId: cardDragSession.payload.projectId,
                cards: cardDragSession.payload.cards.map((entry) => ({
                  cardId: entry.card.id,
                  status: entry.columnId as CardStatus,
                })),
              },
              optimisticResult,
            );
            if (!result) {
              optimisticResult.rollback();
            }
          } finally {
            optimisticResult.cleanup?.();
          }
        }

        endExternalCardDragSession(externalCardDragSessionIdRef.current);
        externalCardDragSessionIdRef.current = undefined;
        return;
      }
    }

    const dragCardIds = dragData.dragItems.map((entry) => entry.card.id);
    const destination = resolveKanbanDropLocation({
      visibleBoard: filteredBoard,
      dropTargets,
      sourceData: dragData,
      draggedCardIds: dragCardIds,
      pointerY: pointer?.y ?? null,
      resolveColumnSurface,
    });
    if (!destination) {
      return;
    }

    const dropStrategy = resolveKanbanCardDropStrategy({
      hasNonDefaultSort,
      destinationColumnId: destination.columnId,
      dragItems: dragData.dragItems,
    });
    if (dropStrategy === "none") {
      return;
    }

    const sharedSourceColumnId = dragData.dragItems.every(
      (entry) => entry.columnId === dragData.dragItems[0]?.columnId,
    )
      ? (dragData.dragItems[0]?.columnId as CardStatus | undefined)
      : undefined;
    const newOrder = dropStrategy === "reorder"
      ? resolveFilteredDropOrder({
        board,
        visibleBoard: filteredBoard,
        draggedCardIds: dragCardIds,
        targetColumnId: destination.columnId,
        targetVisibleIndex: destination.index,
      })
      : undefined;

    if (dragCardIds.length > 1) {
      const moved = await moveCards({
        cardIds: dragCardIds,
        ...(sharedSourceColumnId ? { fromStatus: sharedSourceColumnId } : {}),
        toStatus: destination.columnId,
        ...(typeof newOrder === "number" ? { newOrder } : {}),
      });
      if (!moved) return;

      setCardSelection({
        cardIds: new Set(dragCardIds),
      });
      return;
    }

    const moved = await moveCard({
      cardId: dragData.sourceCardId,
      fromStatus: dragData.sourceColumnId,
      toStatus: destination.columnId,
      ...(typeof newOrder === "number" ? { newOrder } : {}),
    });
    if (!moved) return;

    setCardSelection(emptyCardSelection());
  }, [
    board,
    commitExternalCardDropMove,
    filteredBoard,
    hasNonDefaultSort,
    moveCard,
    moveCards,
    resolveColumnSurface,
  ]);

  useEffect(() => {
    const element = boardScrollContainerRef.current;
    if (!element) {
      return;
    }

    return autoScrollForElements({
      element,
      canScroll: ({ source }) => isKanbanCardDragData(source.data)
        && source.data.instanceId === dragInstanceId,
    });
  }, [dragInstanceId]);

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isKanbanCardDragData(source.data)
        && source.data.instanceId === dragInstanceId,
      onDragStart: ({ source }) => {
        if (!isKanbanCardDragData(source.data)) {
          return;
        }

        endExternalCardDragSession(externalCardDragSessionIdRef.current);
        externalCardDragSessionIdRef.current = startExternalCardDragSession({
          projectId: source.data.projectId,
          cards: source.data.dragItems,
        });
        setActiveDraggedCardIds(new Set(source.data.dragItems.map((entry) => entry.card.id)));
        setActiveDropColumnId(null);
        clearCardDropTargetHover();
        setDropIndicator(null);
        if (!selectedCardIds.has(source.data.sourceCardId)) {
          setCardSelection(emptyCardSelection());
        }
      },
      onDrag: ({ source, location }) => {
        if (!isKanbanCardDragData(source.data)) {
          return;
        }

        const pointer = {
          x: location.current.input.clientX,
          y: location.current.input.clientY,
        };
        updateExternalCardDragPointer(externalCardDragSessionIdRef.current, pointer);
        updateCardDropTargetHover(pointer, {
          projectId: source.data.projectId,
          cards: source.data.dragItems,
        });

        const nextIndicator = resolveKanbanDropLocation({
          visibleBoard: filteredBoard,
          dropTargets: location.current.dropTargets as Array<{ data: Record<string | symbol, unknown> }>,
          sourceData: source.data,
          draggedCardIds: source.data.dragItems.map((entry) => entry.card.id),
          pointerY: pointer.y,
          resolveColumnSurface,
        });
        const nextDropStrategy = nextIndicator
          ? resolveKanbanCardDropStrategy({
            hasNonDefaultSort,
            destinationColumnId: nextIndicator.columnId,
            dragItems: source.data.dragItems,
          })
          : "none";
        setActiveDropColumnId((current) => {
          const nextColumnId = nextDropStrategy === "move-only"
            ? nextIndicator?.columnId ?? null
            : null;
          return current === nextColumnId ? current : nextColumnId;
        });
        if (nextDropStrategy !== "reorder") {
          setDropIndicator((current) => current ? null : current);
          return;
        }

        setDropIndicator((current) => {
          if (!nextIndicator) {
            return current ? null : current;
          }
          if (current?.columnId === nextIndicator.columnId && current.index === nextIndicator.index) {
            return current;
          }
          return nextIndicator;
        });
      },
      onDrop: async ({ source, location }) => {
        if (!isKanbanCardDragData(source.data)) {
          clearBoardCardDragState();
          return;
        }

        const pointer = {
          x: location.current.input.clientX,
          y: location.current.input.clientY,
        };
        updateExternalCardDragPointer(externalCardDragSessionIdRef.current, pointer);
        clearCardDropTargetHover();
        setDropIndicator(null);

        try {
          await performCardDrop(
            source.data,
            location.current.dropTargets as Array<{ data: Record<string | symbol, unknown> }>,
            pointer,
          );
        } finally {
          clearBoardCardDragState();
        }
      },
    });
  }, [
    clearBoardCardDragState,
    dragInstanceId,
    filteredBoard,
    hasNonDefaultSort,
    performCardDrop,
    resolveColumnSurface,
    selectedCardIds,
  ]);

  const handleAddCard = useCallback(async (
    columnId: string,
    input: CardInput,
    placement: CardCreatePlacement = "bottom",
  ) => {
    await createCard(columnId, input, placement);
  }, [createCard]);

  const handleNativeDragOver = useCallback(
    (columnId: string, event: React.DragEvent<HTMLDivElement>) => {
      if (isKanbanCardDragActive) {
        return;
      }

      if (externalBlockImportDisabled) {
        setDropIndicator(null);
        return;
      }

      const session = getActiveExternalEditorDragSession();
      if (!session) {
        setDropIndicator(null);
        return;
      }

      const draggedIds = resolveDraggedBlockIds(session.editor, session.container);
      if (draggedIds.length === 0) {
        setDropIndicator(null);
        return;
      }

      const draggedBlocks = resolveTopLevelDraggedBlocks(session.editor, draggedIds);
      if (draggedBlocks.length === 0) {
        setDropIndicator(null);
        return;
      }

      event.preventDefault();
      const index = computeNativeDropIndexFromSurface(
        event.currentTarget,
        event.clientY,
      );
      setDropIndicator({ columnId, index });
    },
    [externalBlockImportDisabled, isKanbanCardDragActive],
  );

  const handleNativeDragLeave = useCallback(
    (columnId: string, event: React.DragEvent<HTMLDivElement>) => {
      if (isKanbanCardDragActive) {
        return;
      }

      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      setDropIndicator((current) => {
        if (!current || current.columnId !== columnId) return current;
        return null;
      });
    },
    [isKanbanCardDragActive],
  );

  const handleNativeDrop = useCallback(
    async (columnId: string, event: React.DragEvent<HTMLDivElement>) => {
      if (isKanbanCardDragActive) {
        return;
      }

      setDropIndicator(null);

      if (externalBlockImportDisabled) return;

      const session = getActiveExternalEditorDragSession();
      if (!session) return;

      const draggedIds = resolveDraggedBlockIds(session.editor, session.container);
      if (draggedIds.length === 0) return;

      const draggedBlocks = resolveTopLevelDraggedBlocks(session.editor, draggedIds);
      if (draggedBlocks.length === 0) return;

      const cards = mapDraggedBlocksToCardInputs(draggedBlocks);
      if (cards.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      const insertIndex = computeNativeDropIndexFromSurface(
        event.currentTarget,
        event.clientY,
      );
      const snapshot = snapshotEditorDocument(session.editor);
      const baseline = session.adapter.captureBaseline(session.editor, session.container);
      const releaseOptimisticMutation = session.adapter.beginOptimisticMutation?.();

      try {
        runInEditorTransaction(session.editor, () => {
          session.editor.removeBlocks(draggedBlocks.map((block) => block.id));
        });

        const sourceUpdates = session.adapter.buildSourceUpdates(
          session.editor,
          session.container,
          baseline,
        );

        const result = await importBlockDrop({
          targetStatus: columnId as CardType["status"],
          insertIndex,
          cards,
          sourceUpdates,
          groupId: crypto.randomUUID(),
        });

        if (!result) {
          restoreEditorDocument(session.editor, snapshot);
          return;
        }

        endExternalEditorDragSession(session.id);
      } finally {
        releaseOptimisticMutation?.();
      }
    },
    [externalBlockImportDisabled, importBlockDrop, isKanbanCardDragActive],
  );

  const handleEditCard = useCallback(async (
    columnId: string,
    card: CardType,
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (event.shiftKey) {
      event.preventDefault();
      setCardSelection((current) => toggleCardSelection(current, card.id));
      return;
    }

    if (selectedCardIds.size > 0) {
      setCardSelection(emptyCardSelection());
    }

    if (cardStageCardId === card.id) {
      await cardStageCloseRef?.current?.();
      return;
    }
    openCardStage(projectId, card.id, card.title);
  }, [
    cardStageCardId,
    cardStageCloseRef,
    openCardStage,
    projectId,
    selectedCardIds.size,
  ]);

  const handleCardMenuOpen = useCallback((cardId: string) => {
    setCardSelection({
      cardIds: new Set([cardId]),
    });
  }, []);

  const handleDeleteCardFromMenu = useCallback(
    async ({
      cardId,
      columnId,
    }: {
      cardId: string;
      columnId: string;
    }) => {
      const deleted = await deleteCard(columnId, cardId);
      if (!deleted) {
        await refresh();
        return;
      }

      if (cardStageCardId === cardId) {
        await cardStageCloseRef?.current?.();
      }

      setCardSelection(emptyCardSelection());
    },
    [cardStageCardId, cardStageCloseRef, deleteCard, refresh],
  );

  const handleCopyCardLinkFromMenu = useCallback(
    async ({
      cardId,
    }: {
      cardId: string;
      projectId: string;
    }) => {
      await writeTextToClipboard(buildCardDeepLink({ cardId }));
    },
    [],
  );

  const handleMoveCardToProjectFromMenu = useCallback(
    async ({
      cardId,
      sourceStatus,
      targetProjectId,
    }: {
      cardId: string;
      sourceStatus: CardType["status"];
      targetProjectId: string;
    }) => {
      const moved = await moveCardToProject({
        cardId,
        sourceStatus,
        targetProjectId,
      });
      if (!moved) {
        await refresh();
        return;
      }

      setCardSelection(emptyCardSelection());
    },
    [moveCardToProject, refresh],
  );

  const handleUpdateCardProperty = useCallback(
    async ({
      cardId,
      columnId,
      property,
      value,
    }: CardPropertyUpdateInput) => {
      const column = board?.columns.find((candidate) => candidate.id === columnId);
      const card = column?.cards.find((candidate) => candidate.id === cardId);
      if (!card) {
        return;
      }

      if (property === "priority") {
        if ((card.priority ?? "none") === value) {
          return;
        }
        await updateCard(columnId, cardId, {
          priority: value === "none" ? null : (value as CardType["priority"]),
        });
        return;
      }

      const nextEstimate = value === "none" ? null : value;
      if ((card.estimate ?? null) === nextEstimate) {
        return;
      }

      await updateCard(columnId, cardId, {
        estimate: nextEstimate as CardType["estimate"],
      });
    },
    [board, updateCard],
  );

  const updateColumnLayout = useCallback((
    columnId: CardStatus,
    patch: { collapsed?: boolean; width?: number },
  ) => {
    setColumnLayoutPrefs((current) => {
      const next = updateKanbanColumnLayoutPrefs(current, columnId, patch);
      writeKanbanColumnLayoutPrefs(projectId, next);
      return next;
    });
  }, [projectId]);

  // Loading state
  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-sm text-(--foreground-secondary)">
          Loading board...
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-sm text-(--destructive)">
          Error: {error}
        </div>
      </div>
    );
  }

  if (!board || !filteredBoard) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <KanbanBoardScrollContainer ref={boardScrollContainerRef}>
        {/* Board container - Notion-style scroll with sticky headers */}
        <div className="flex w-max min-w-full px-4">
          {filteredBoard.columns.map((column) => (
            <Column
              projectId={projectId}
              projectName={currentProjectName}
              key={column.id}
              column={column}
              displayPrefs={viewPrefs.display}
              dragInstanceId={dragInstanceId}
              buildDragData={buildDragData}
              layout={getKanbanColumnLayout(columnLayoutPrefs, column.id)}
              onAddCard={handleAddCard}
              onEditCard={handleEditCard}
              onUpdateCardProperty={handleUpdateCardProperty}
              onCollapsedChange={(columnId, collapsed) => updateColumnLayout(columnId, { collapsed })}
              onWidthChange={(columnId, width) => updateColumnLayout(columnId, { width })}
              onMoveCardToProjectFromMenu={handleMoveCardToProjectFromMenu}
              onDeleteCardFromMenu={handleDeleteCardFromMenu}
              onCopyCardLinkFromMenu={handleCopyCardLinkFromMenu}
              onOpenCardMenu={handleCardMenuOpen}
              onNativeDragOver={handleNativeDragOver}
              onNativeDragLeave={handleNativeDragLeave}
              onNativeDrop={handleNativeDrop}
              dropDisabled={hasNonDefaultSort}
              dropIndicatorIndex={
                dropIndicator?.columnId === column.id
                  ? dropIndicator.index
                  : undefined
              }
              draggedCardIds={activeDraggedCardIds}
              isDropTargetActive={activeDropColumnId === column.id}
              focusedCardId={cardStageCardId}
              selectedCardIds={selectedCardIds}
              contextMenuProjects={contextMenuProjects}
            />
          ))}
        </div>
      </KanbanBoardScrollContainer>

      {/* Undo/Redo toast notification */}
      <UndoToast
        action={lastAction?.type || null}
        description={lastAction?.description || null}
        onDismiss={clearLastAction}
      />
    </div>
  );
}
