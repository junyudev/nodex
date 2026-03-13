import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Column } from "./column";
import { CardPreview, type CardPropertyUpdateInput } from "./card";
import {
  emptyCardSelection,
  normalizeCardSelection,
  resolveDragGroup,
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
  resolveColumnDropIndex,
  resolveDragPointer,
} from "./drag-pointer";
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
  type ExternalCardDragItem,
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
import { resolveDragOverlayGeometry } from "./drag-overlay-geometry";
import { resolveFilteredDropOrder } from "./filtered-drag-order";

// Custom collision detection: prioritize pointerWithin for columns, fall back to rectIntersection
const customCollisionDetection: CollisionDetection = (args) => {
  // First try pointerWithin - best for finding the container the pointer is in
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }
  // Fall back to rectIntersection for edge cases
  return rectIntersection(args);
};

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
  const [activeDrag, setActiveDrag] = useState<{
    items: ExternalCardDragItem[];
  } | null>(null);
  const [activeDragGeometry, setActiveDragGeometry] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const externalCardDragSessionIdRef = useRef<string | undefined>(undefined);

  const [dropIndicator, setDropIndicator] = useState<{
    columnId: string;
    index: number;
  } | null>(null);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  const searchTokens = useMemo(
    () => tokenizeSearchQuery(deferredSearchQuery),
    [deferredSearchQuery]
  );
  const viewPrefs = dbViewPrefs ?? getDefaultDbViewPrefs("kanban");
  const hasSearchFilter = searchTokens.length > 0;
  const hasRuleFiltering = hasActiveDbViewFilters("kanban", viewPrefs.rules);
  const hasNonDefaultSort = hasActiveDbViewSorts("kanban", viewPrefs.rules);
  const dragDisabled = hasSearchFilter || hasRuleFiltering || hasNonDefaultSort;

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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const resolveColumnSurface = useCallback((columnId: string): HTMLElement | null => {
    if (typeof document === "undefined") return null;

    return document.querySelector<HTMLElement>(`[data-kanban-column-id="${columnId}"]`);
  }, []);

  const resolveColumnInsertionIndex = useCallback((
    columnId: string,
    fallbackIndex: number,
    event: DragOverEvent | DragEndEvent,
  ): number => resolveColumnDropIndex({
    surface: resolveColumnSurface(columnId),
    fallbackIndex,
    event,
  }), [resolveColumnSurface]);

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current as { card: CardType; columnId: string };
    const dragItems = resolveDragGroup(
      filteredBoard ?? board,
      cardSelection,
      {
        card: data.card,
        columnId: data.columnId,
      },
    );

    endExternalCardDragSession(externalCardDragSessionIdRef.current);
    externalCardDragSessionIdRef.current = startExternalCardDragSession({
      projectId,
      cards: dragItems,
    });

    clearCardDropTargetHover();
    setActiveDragGeometry(
      resolveDragOverlayGeometry(active.rect.current.initial),
    );
    setActiveDrag({ items: dragItems });
    if (!selectedCardIds.has(data.card.id)) {
      setCardSelection(emptyCardSelection());
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setDropIndicator(null);
      return;
    }

    if (over.data.current?.column) {
      const col = over.data.current.column as { id: string; cards: unknown[] };
      setDropIndicator({
        columnId: col.id,
        index: resolveColumnInsertionIndex(col.id, col.cards.length, event),
      });
    } else if (over.data.current?.card) {
      if (activeDrag && activeDrag.items.length > 1 && selectedCardIds.has(String(over.id))) {
        setDropIndicator(null);
        return;
      }
      const columnId = over.data.current.columnId as string;
      const column = filteredBoard?.columns.find((c) => c.id === columnId);
      const overIndex = column?.cards.findIndex((c) => c.id === over.id) ?? 0;
      setDropIndicator({ columnId, index: overIndex });
    } else {
      setDropIndicator(null);
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const session = getActiveExternalCardDragSession();
    if (!session) return;

    const pointer = resolveDragPointer(event);
    if (!pointer) return;
    updateExternalCardDragPointer(externalCardDragSessionIdRef.current, pointer);
    updateCardDropTargetHover(pointer, session.payload);
  };

  const handleDragCancel = () => {
    setActiveDrag(null);
    setActiveDragGeometry(null);
    setDropIndicator(null);
    clearCardDropTargetHover();
    endExternalCardDragSession(externalCardDragSessionIdRef.current);
    externalCardDragSessionIdRef.current = undefined;
  };

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

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    const cardDragSession = getActiveExternalCardDragSession();
    const activeDragItems = activeDrag?.items ?? [];
    setActiveDrag(null);
    setActiveDragGeometry(null);
    setDropIndicator(null);
    clearCardDropTargetHover();

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

    endExternalCardDragSession(externalCardDragSessionIdRef.current);
    externalCardDragSessionIdRef.current = undefined;

    if (!over || !active.data.current) return;

    const activeData = active.data.current as { card: CardType; columnId: CardStatus };
    const fromStatus = activeData.columnId;
    const cardId = activeData.card.id;
    const dragItems = activeDragItems.length > 0
      ? activeDragItems
      : [{
        card: activeData.card,
        columnId: activeData.columnId,
        columnName: board?.columns.find((column) => column.id === activeData.columnId)?.name
          ?? activeData.columnId,
      }];
    const dragCardIds = dragItems.map((entry) => entry.card.id);
    const sharedSourceColumnId = dragItems.every((entry) => entry.columnId === dragItems[0]?.columnId)
      ? (dragItems[0]?.columnId as CardStatus | undefined)
      : undefined;

    let toStatus: CardStatus;
    let targetVisibleIndex: number;

    if (over.data.current?.column) {
      toStatus = over.data.current.column.id as CardStatus;
      const targetColumn = filteredBoard?.columns.find((c) => c.id === toStatus);
      const fallbackIndex = targetColumn?.cards.length ?? 0;
      targetVisibleIndex = resolveColumnInsertionIndex(
        toStatus,
        fallbackIndex,
        event,
      );
    } else if (over.data.current?.card) {
      toStatus = over.data.current.columnId as CardStatus;
      const targetColumn = filteredBoard?.columns.find((c) => c.id === toStatus);
      targetVisibleIndex = targetColumn?.cards.findIndex((c) => c.id === over.id) ?? 0;
    } else {
      return;
    }

    if (over.data.current?.card && dragCardIds.includes(String(over.id))) {
      return;
    }

    const newOrder = dragDisabled
      ? resolveFilteredDropOrder({
        board,
        visibleBoard: filteredBoard,
        draggedCardIds: dragCardIds,
        targetColumnId: toStatus,
        targetVisibleIndex,
      })
      : targetVisibleIndex;

    if (dragCardIds.length > 1) {
      const moved = await moveCards({
        cardIds: dragCardIds,
        ...(sharedSourceColumnId ? { fromStatus: sharedSourceColumnId } : {}),
        toStatus,
        newOrder,
      });
      if (!moved) return;

      setCardSelection({
        cardIds: new Set(dragCardIds),
      });
      return;
    }

    const moved = await moveCard({
      cardId,
      fromStatus,
      toStatus,
      newOrder,
    });
    if (!moved) return;

    setCardSelection(emptyCardSelection());
  };

  const handleAddCard = useCallback(async (
    columnId: string,
    input: CardInput,
    placement: CardCreatePlacement = "bottom",
  ) => {
    await createCard(columnId, input, placement);
  }, [createCard]);

  const handleNativeDragOver = useCallback(
    (columnId: string, event: React.DragEvent<HTMLDivElement>) => {
      if (dragDisabled) {
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
    [dragDisabled],
  );

  const handleNativeDragLeave = useCallback(
    (columnId: string, event: React.DragEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      setDropIndicator((current) => {
        if (!current || current.columnId !== columnId) return current;
        return null;
      });
    },
    [],
  );

  const handleNativeDrop = useCallback(
    async (columnId: string, event: React.DragEvent<HTMLDivElement>) => {
      setDropIndicator(null);

      if (dragDisabled) return;

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
    [dragDisabled, importBlockDrop],
  );

  const handleEditCard = useCallback(async (
    columnId: string,
    card: CardType,
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (!dragDisabled && event.shiftKey) {
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
    dragDisabled,
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
      <KanbanBoardScrollContainer>
        <DndContext
          sensors={sensors}
          collisionDetection={customCollisionDetection}
          onDragStart={dragDisabled ? undefined : handleDragStart}
          onDragMove={dragDisabled ? undefined : handleDragMove}
          onDragOver={dragDisabled ? undefined : handleDragOver}
          onDragEnd={dragDisabled ? undefined : handleDragEnd}
          onDragCancel={dragDisabled ? undefined : handleDragCancel}
        >
          {/* Board container - Notion-style scroll with sticky headers */}
          <div className="flex w-max min-w-full px-4">
            {filteredBoard.columns.map((column) => (
              <Column
                projectId={projectId}
                projectName={currentProjectName}
                key={column.id}
                column={column}
                displayPrefs={viewPrefs.display}
                onAddCard={handleAddCard}
                onEditCard={handleEditCard}
                onUpdateCardProperty={handleUpdateCardProperty}
                onMoveCardToProjectFromMenu={handleMoveCardToProjectFromMenu}
                onDeleteCardFromMenu={handleDeleteCardFromMenu}
                onCopyCardLinkFromMenu={handleCopyCardLinkFromMenu}
                onOpenCardMenu={handleCardMenuOpen}
                onNativeDragOver={handleNativeDragOver}
                onNativeDragLeave={handleNativeDragLeave}
                onNativeDrop={handleNativeDrop}
                dragDisabled={dragDisabled}
                dropIndicatorIndex={
                  dropIndicator?.columnId === column.id
                    ? dropIndicator.index
                    : undefined
                }
                focusedCardId={cardStageCardId}
                selectedCardIds={selectedCardIds}
                contextMenuProjects={contextMenuProjects}
              />
            ))}
          </div>

          {/* Drag overlay - shows card being dragged */}
          {typeof document !== "undefined"
            ? createPortal(
              <DragOverlay>
                {activeDrag ? (
                  <div className="relative opacity-90">
                    <CardPreview
                      card={activeDrag.items[0]!.card}
                      columnId={activeDrag.items[0]!.columnId}
                      displayPrefs={viewPrefs.display}
                      isSelected={activeDrag.items.length > 1}
                      fixedWidth={activeDragGeometry?.width}
                      fixedHeight={activeDragGeometry?.height}
                    />
                    {activeDrag.items.length > 1 ? (
                      <div className="absolute -top-1.5 -right-1.5 rounded-full bg-(--foreground) px-1.75 py-0.75 text-sm font-medium text-(--background) shadow-lg">
                        {activeDrag.items.length}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )
            : null}
        </DndContext>
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
