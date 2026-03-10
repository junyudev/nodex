import { useState, useMemo, useCallback } from "react";
import { Sidebar } from "@excalidraw/excalidraw";
import { Search, Plus, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Board, Card } from "@/lib/types";

const PRIORITY_LABELS: Record<string, string> = {
  "p0-critical": "P0",
  "p1-high": "P1",
  "p2-medium": "P2",
  "p3-low": "P3",
  "p4-later": "P4",
};

const PRIORITY_CLASSES: Record<string, string> = {
  "p0-critical": "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  "p1-high": "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  "p2-medium": "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  "p3-low": "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  "p4-later": "bg-gray-50 text-gray-500 dark:bg-gray-800/50 dark:text-gray-500",
};

interface CanvasCardSidebarProps {
  board: Board | null;
  placedCardIds: Set<string>;
  onPlaceCard: (card: Card, columnId: string) => void;
  onCreateAndPlace: () => void;
}

export function CanvasCardSidebar({
  board,
  placedCardIds,
  onPlaceCard,
  onCreateAndPlace,
}: CanvasCardSidebarProps) {
  const [search, setSearch] = useState("");

  const allCards = useMemo(() => {
    if (!board) return [];
    const cards: { card: Card; columnId: string; columnName: string }[] = [];
    for (const col of board.columns) {
      for (const card of col.cards) {
        cards.push({ card, columnId: col.id, columnName: col.name });
      }
    }
    return cards;
  }, [board]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allCards;
    const q = search.toLowerCase();
    return allCards.filter(({ card }) => card.title.toLowerCase().includes(q));
  }, [allCards, search]);

  const handlePlace = useCallback(
    (card: Card, columnId: string) => {
      onPlaceCard(card, columnId);
    },
    [onPlaceCard],
  );

  return (
    <Sidebar name="cards" docked={false}>
      <Sidebar.Header>
        <div className="flex items-center gap-2 text-sm font-medium">
          Cards
        </div>
      </Sidebar.Header>
      <Sidebar.Tabs>
        <Sidebar.Tab tab="browse">
          <div className="flex h-full flex-col gap-2 p-2">
            {/* Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-gray-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search cards..."
                className="h-7 pl-7 text-xs"
              />
            </div>

            {/* Create new */}
            <button
              onClick={onCreateAndPlace}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium",
                "bg-blue-50 text-blue-700 hover:bg-blue-100",
                "dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/30",
                "transition-colors",
              )}
            >
              <Plus className="size-3.5" />
              Create new card
            </button>

            {/* Card list */}
            <div className="-mx-2 flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-gray-400">
                  {search ? "No cards found" : "No cards yet"}
                </div>
              )}
              {filtered.map(({ card, columnId, columnName }) => {
                const isPlaced = placedCardIds.has(card.id);
                return (
                  <button
                    key={card.id}
                    onClick={() => handlePlace(card, columnId)}
                    disabled={isPlaced}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left",
                      "transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50",
                      isPlaced && "cursor-default opacity-50",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 truncate text-xs font-medium">
                        {isPlaced && <Check className="size-3 shrink-0 text-green-500" />}
                        {card.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <span
                          className={cn(
                            "rounded-sm px-1 text-xs font-medium",
                            PRIORITY_CLASSES[card.priority] ?? PRIORITY_CLASSES["p2-medium"],
                          )}
                        >
                          {PRIORITY_LABELS[card.priority] ?? "P2"}
                        </span>
                        <span className="truncate text-xs text-gray-400">
                          {columnName}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Sidebar.Tab>
      </Sidebar.Tabs>
    </Sidebar>
  );
}
