import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useKanban } from "@/lib/use-kanban";
import { useToggleListSettings } from "@/lib/use-toggle-list-settings";
import { filterCards, rankCards } from "@/lib/toggle-list/rules";
import { type ToggleListStatusId } from "@/lib/toggle-list/types";
import { cn } from "@/lib/utils";
import { ToggleListCardEditor } from "./editor/toggle-list-card-editor";
import { toggleListSchema } from "./editor/toggle-list-schema";
import { ToggleListSummaryBadges, ToggleListRulesBody } from "./toggle-list-rules-body";
import { ToggleListScrollContainer } from "./view-scroll-containers";

interface ToggleListViewProps {
  projectId: string;
  searchQuery: string;
}

const RULES_PANEL_STORAGE_KEY = "nodex-toggle-list-rules-panel-v1";

function readRulesPanelExpanded(projectId: string): boolean {
  try {
    const raw = localStorage.getItem(RULES_PANEL_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return true;
    const value = parsed[projectId];
    return typeof value === "boolean" ? value : true;
  } catch {
    return true;
  }
}

function writeRulesPanelExpanded(projectId: string, expanded: boolean): void {
  try {
    const raw = localStorage.getItem(RULES_PANEL_STORAGE_KEY);
    const parsedRaw = raw !== null ? JSON.parse(raw) : {};
    const parsed =
      typeof parsedRaw === "object" && parsedRaw !== null
        ? (parsedRaw as Record<string, unknown>)
        : {};
    localStorage.setItem(
      RULES_PANEL_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        [projectId]: expanded,
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function ToggleListView({ projectId, searchQuery }: ToggleListViewProps) {
  const [rulesExpanded, setRulesExpanded] = useState(() => readRulesPanelExpanded(projectId));
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const { board, loading, error, updateCard, moveCard } = useKanban({ projectId });
  const { settings, update, reset } = useToggleListSettings(projectId);

  const cards = useMemo(() => {
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

  const availableTags = useMemo(() => {
    if (!board) return [];
    const uniqueTags = new Set(
      board.columns.flatMap((column) =>
        column.cards.flatMap((card) => card.tags),
      ),
    );
    return Array.from(uniqueTags).sort();
  }, [board]);

  const filteredCards = useMemo(
    () => filterCards(cards, settings, deferredSearchQuery),
    [cards, deferredSearchQuery, settings],
  );

  const visibleCards = useMemo(
    () => rankCards(filteredCards, settings),
    [filteredCards, settings],
  );

  useEffect(() => {
    setRulesExpanded(readRulesPanelExpanded(projectId));
  }, [projectId]);

  useEffect(() => {
    writeRulesPanelExpanded(projectId, rulesExpanded);
  }, [projectId, rulesExpanded]);

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
      <div className="px-4 pt-2 pb-5">
        <section className="mb-3 flex flex-col rounded-lg border border-(--border)/50 bg-(--background) px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-base font-semibold text-(--foreground) hover:text-(--foreground-secondary)"
                onClick={() => setRulesExpanded((prev) => !prev)}
                aria-expanded={rulesExpanded}
                aria-label={rulesExpanded ? "Collapse rules" : "Expand rules"}
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform duration-150",
                    !rulesExpanded && "-rotate-90",
                  )}
                />
                Rules
              </button>
              <ToggleListSummaryBadges settings={settings} visibleCount={visibleCards.length} />
            </div>

            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-(--foreground-tertiary) hover:text-(--foreground-secondary)"
              onClick={reset}
            >
              <RotateCcw className="size-3" />
              Reset
            </button>
          </div>

          {rulesExpanded && (
            <ToggleListRulesBody
              settings={settings}
              availableTags={availableTags}
              updateSettings={update}
            />
          )}
        </section>

        <section className="nodex-toggle-list-editor-shell rounded-lg border border-(--border) bg-(--card) px-3.5 pt-3 pb-4">
          <ToggleListCardEditor
            schema={toggleListSchema}
            projectId={projectId}
            cards={visibleCards}
            propertyOrder={settings.propertyOrder}
            hiddenProperties={settings.hiddenProperties}
            showEmptyEstimate={settings.showEmptyEstimate}
            updateCard={updateCard}
            moveCard={moveCard}
            className="nodex-toggle-list-editor min-h-80"
          />
        </section>
      </div>
    </ToggleListScrollContainer>
  );
}
