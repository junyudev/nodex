import { useDeferredValue, useMemo } from "react";
import {
  filterDbViewCards,
  getAvailableDisplayProperties,
  getDefaultDbViewPrefs,
  sortDbViewCards,
  type DbViewPrefs,
  type DbViewCardRecord,
} from "../../lib/db-view-prefs";
import { buildCardSearchText, matchesSearchTokens, tokenizeSearchQuery } from "@/lib/card-search";
import { useKanban } from "@/lib/use-kanban";
import { TOGGLE_LIST_PROPERTY_KEYS, type ToggleListPropertyKey, type ToggleListStatusId } from "@/lib/toggle-list/types";
import { ToggleListCardEditor } from "./editor/toggle-list-card-editor";
import { toggleListSchema } from "./editor/toggle-list-schema";
import { ToggleListScrollContainer } from "./view-scroll-containers";

interface ToggleListViewProps {
  projectId: string;
  searchQuery: string;
  dbViewPrefs: DbViewPrefs | null;
}

export function ToggleListView({ projectId, searchQuery, dbViewPrefs }: ToggleListViewProps) {
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const { board, loading, error, updateCard, moveCard } = useKanban({ projectId });
  const viewPrefs = dbViewPrefs ?? getDefaultDbViewPrefs("toggle-list");
  const displayProperties = useMemo(
    () =>
      getAvailableDisplayProperties("toggle-list").filter(
        (property): property is ToggleListPropertyKey =>
          TOGGLE_LIST_PROPERTY_KEYS.includes(property as ToggleListPropertyKey),
      ),
    [],
  );
  const propertyOrder = useMemo(
    () =>
      viewPrefs.display.propertyOrder.filter(
        (property): property is ToggleListPropertyKey => displayProperties.includes(property as ToggleListPropertyKey),
      ),
    [displayProperties, viewPrefs.display.propertyOrder],
  );
  const hiddenProperties = useMemo(
    () =>
      viewPrefs.display.hiddenProperties.filter(
        (property): property is ToggleListPropertyKey => displayProperties.includes(property as ToggleListPropertyKey),
      ),
    [displayProperties, viewPrefs.display.hiddenProperties],
  );

  const cards = useMemo<DbViewCardRecord[]>(() => {
    if (!board) return [];

    return board.columns.flatMap((column, columnIndex) =>
      column.cards.map((card, cardIndex) => ({
        ...card,
        columnId: column.id as ToggleListStatusId,
        columnName: column.name,
        boardIndex: columnIndex * 100_000 + cardIndex,
      })),
    );
  }, [board]);

  const filteredCards = useMemo(
    () => {
      const filteredByRules = filterDbViewCards(cards, viewPrefs.rules);
      const searchTokens = tokenizeSearchQuery(deferredSearchQuery);
      if (searchTokens.length === 0) return filteredByRules;
      return filteredByRules.filter((card) => {
        const searchable = `${buildCardSearchText(card)} ${card.columnName.toLowerCase()}`;
        return matchesSearchTokens(searchable, searchTokens);
      });
    },
    [cards, deferredSearchQuery, viewPrefs.rules],
  );

  const visibleCards = useMemo(
    () => sortDbViewCards(filteredCards, viewPrefs.rules),
    [filteredCards, viewPrefs.rules],
  );

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-sm text-(--foreground-secondary)">
          Loading toggle list...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-sm text-(--destructive)">
          Error: {error}
        </div>
      </div>
    );
  }

  if (!board) return null;

  return (
    <ToggleListScrollContainer>
      <div className="px-4">
        <section className="nodex-toggle-list-editor-shell rounded-lg border border-(--border) bg-(--card) px-3.5 pt-3 pb-4">
          <ToggleListCardEditor
            schema={toggleListSchema}
            projectId={projectId}
            cards={visibleCards}
            propertyOrder={propertyOrder}
            hiddenProperties={hiddenProperties}
            showEmptyEstimate={viewPrefs.display.showEmptyEstimate}
            showEmptyPriority={viewPrefs.display.showEmptyPriority}
            updateCard={updateCard}
            moveCard={moveCard}
            className="nodex-toggle-list-editor min-h-80"
          />
        </section>
      </div>
    </ToggleListScrollContainer>
  );
}
