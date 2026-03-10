import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { Layers3, Link2, Search } from "lucide-react";
import { useProjectedCardEmbedSync } from "./use-projected-card-embed-sync";
import {
  PROJECTION_ACTION_BTN,
} from "./projection-drag-handle";
import {
  hasRecursiveCardRefAncestor,
} from "./projection-card-toggle";
import {
  isCursorWithinOwnerTree,
} from "./use-projected-card-embed-sync";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type {
  ToggleListPropertyKey,
  ToggleListStatusId,
} from "@/lib/toggle-list/types";
import { TOGGLE_LIST_PROPERTY_KEYS } from "@/lib/toggle-list/types";
import type { Card } from "@/lib/types";
import { useKanban } from "@/lib/use-kanban";
import { useAllBoards } from "@/lib/use-all-boards";
import { useProjects } from "@/lib/use-projects";
import { normalizeProjectIcon } from "@/lib/project-icon";
import { cn } from "@/lib/utils";

function CardPicker({ onSelect }: { onSelect: (projectId: string, cardId: string) => void }) {
  const { boards, loading } = useAllBoards();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const all: Array<{ projectId: string; columnName: string; card: Card }> = [];
    for (const [projectId, board] of boards) {
      for (const column of board.columns) {
        for (const card of column.cards) {
          all.push({ projectId, columnName: column.name, card });
        }
      }
    }
    if (!query.trim()) return all.slice(0, 20);
    const lower = query.toLowerCase();
    return all.filter((c) => c.card.title.toLowerCase().includes(lower)).slice(0, 20);
  }, [boards, query]);

  return (
    <div className="p-1" contentEditable={false}>
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          className="flex-1 border-none bg-transparent py-1 text-base text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Search cards..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="max-h-50 overflow-y-auto">
        {loading && (
          <div className="px-2 py-3 text-center text-base text-muted-foreground">Loading cards...</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-base text-muted-foreground">No cards found</div>
        )}
        {filtered.map((item) => (
          <button
            key={`${item.projectId}:${item.card.id}`}
            type="button"
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm border-none bg-transparent px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => onSelect(item.projectId, item.card.id)}
          >
            <span className="min-w-0 flex-1 truncate text-base text-foreground">
              {item.card.title || "Untitled"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {item.projectId} / {item.columnName}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const ALL_PROPERTIES: ToggleListPropertyKey[] = [...TOGGLE_LIST_PROPERTY_KEYS];
const NO_HIDDEN: ToggleListPropertyKey[] = [];

interface CardRefProjectionEditor {
  getBlock: (id: string) => unknown;
  getParentBlock: (id: string) => unknown;
}

function supportsCardRefProjectionEditor(value: unknown): value is CardRefProjectionEditor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CardRefProjectionEditor>;
  if (typeof candidate.getBlock !== "function") return false;
  return typeof candidate.getParentBlock === "function";
}

/* ------------------------------------------------------------------ */
/*  Selection / cursor helpers (mirrors toggleListInlineView)          */
/* ------------------------------------------------------------------ */

function isBlockSelected(
  editor: { getSelection: () => { blocks: Array<{ id: string }> } | undefined },
  blockId: string,
): boolean {
  const selection = editor.getSelection();
  if (!selection) return false;
  return selection.blocks.some((block) => block.id === blockId);
}

interface CardRefCursorEditor {
  getParentBlock: (id: string) => { id?: string } | undefined;
  getTextCursorPosition: () => { block?: { id?: string } } | undefined;
}

function supportsCardRefCursorEditor(value: unknown): value is CardRefCursorEditor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CardRefCursorEditor>;
  if (typeof candidate.getParentBlock !== "function") return false;
  return typeof candidate.getTextCursorPosition === "function";
}

function isCardRefSelectedOrCursorWithin(
  editor: {
    getSelection: () => { blocks: Array<{ id: string }> } | undefined;
  },
  blockId: string,
): boolean {
  if (isBlockSelected(editor, blockId)) return true;
  if (!supportsCardRefCursorEditor(editor)) return false;
  return isCursorWithinOwnerTree(editor, blockId);
}

export const createCardRefBlockSpec = createReactBlockSpec(
  {
    type: "cardRef" as const,
    propSchema: {
      sourceProjectId: { default: "default" },
      cardId: { default: "" },
    },
    content: "none" as const,
  },
  {
    render: ({ block, editor }) => {
      const sourceProjectId = block.props.sourceProjectId || "default";
      const cardId = block.props.cardId || "";

      const [focusWithin, setFocusWithin] = useState(false);
      const [selected, setSelected] = useState(
        () => isCardRefSelectedOrCursorWithin(editor, block.id),
      );

      const { projects } = useProjects();
      const { cardIndex, loading, error, updateCard, patchCard, moveCard } = useKanban({
        projectId: sourceProjectId,
      });

      useEffect(() => {
        const syncSelection = () => {
          setSelected(isCardRefSelectedOrCursorWithin(editor, block.id));
        };
        syncSelection();
        const unsubscribe = editor.onSelectionChange(syncSelection);
        return unsubscribe;
      }, [block.id, editor]);

      const card = useMemo(
        () => {
          const indexedCard = cardIndex.get(cardId);
          if (!indexedCard) return null;

          return {
            ...indexedCard,
            columnId: indexedCard.columnId as ToggleListStatusId,
          };
        },
        [cardId, cardIndex],
      );

      const handlePickerSelect = useCallback(
        (pickedProjectId: string, pickedCardId: string) => {
          editor.updateBlock(block, {
            props: {
              sourceProjectId: pickedProjectId,
              cardId: pickedCardId,
            },
          });
        },
        [block, editor],
      );

      const recursionKey = `${sourceProjectId}:${cardId}`;
      const isRecursive = useMemo(() => {
        if (!cardId) return false;
        if (!supportsCardRefProjectionEditor(editor)) return false;
        return hasRecursiveCardRefAncestor(editor, block.id, recursionKey);
      }, [block.id, cardId, editor, recursionKey]);

      useProjectedCardEmbedSync({
        ownerBlockId: block.id,
        projectionKind: "cardRef",
        sourceProjectId,
        cards: !loading && !error && card && !isRecursive ? [card] : [],
        propertyOrder: ALL_PROPERTIES,
        hiddenProperties: NO_HIDDEN,
        showEmptyEstimate: false,
        editor,
        enabled: Boolean(cardId) && !isRecursive,
        updateCard,
        patchCard,
        moveCard,
      });

      if (!cardId) {
        return (
          <section contentEditable={false}>
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-base font-medium text-muted-foreground">
              <Link2 className="size-3.5" />
              <span>Card Reference</span>
            </div>
            <CardPicker onSelect={handlePickerSelect} />
          </section>
        );
      }

      if (isRecursive) {
        return (
          <div className="py-2 text-center text-base text-muted-foreground" contentEditable={false}>
            Recursive card reference
          </div>
        );
      }

      if (loading) {
        return (
          <div className="py-2 text-center text-base text-muted-foreground" contentEditable={false}>
            Loading card...
          </div>
        );
      }

      if (error) {
        return (
          <div className="py-2 text-center text-base text-muted-foreground" contentEditable={false}>
            Failed to load card.
          </div>
        );
      }

      if (!card) {
        return (
          <div className="py-2 text-center text-base text-muted-foreground italic opacity-50" contentEditable={false}>
            Card deleted
          </div>
        );
      }

      const active = selected || focusWithin;

      return (
        <section
          className="relative box-border w-full max-w-full rounded-lg bg-transparent p-0"
          data-card-ref-shell
          data-active={active ? "true" : "false"}
          data-card-ref-project={sourceProjectId}
          data-card-ref-card={cardId}
          contentEditable={false}
          onFocusCapture={() => setFocusWithin(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setFocusWithin(false);
            }
          }}
        >
          {/* Floating action bar – project selector */}
          <div
            className={cn(
              "pointer-events-none absolute -top-8.5 right-0 inline-flex items-center gap-1 rounded-lg px-0.5 py-0.5 opacity-0 transition-all duration-swift ease-out",
              active && "pointer-events-auto opacity-100",
            )}
            contentEditable={false}
          >
            <Select
              value={sourceProjectId}
              onValueChange={(value) => {
                editor.updateBlock(block, {
                  props: { sourceProjectId: value },
                });
              }}
            >
              <SelectTrigger className={cn(PROJECTION_ACTION_BTN, "h-7! pr-2")}>
                <span className="inline-flex items-center gap-1.5">
                  <Layers3 className="size-3.5" />
                  {sourceProjectId}
                </span>
              </SelectTrigger>
              <SelectContent sideOffset={4}>
                {projects.map((project) => {
                  const icon = normalizeProjectIcon(project.icon);
                  return (
                    <SelectItem key={project.id} value={project.id}>
                      {icon ? `${icon} ${project.name}` : project.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Projected card children are injected by useProjectedCardEmbedSync */}
          <div className="min-h-0" />
        </section>
      );
    },
  },
);
