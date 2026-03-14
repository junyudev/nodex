import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  FileText,
  FolderSearch2,
  LayoutGrid,
  PanelBottom,
  Search,
  Settings2,
  SquareKanban,
  Table2,
} from "lucide-react";
import { filterCommandPaletteItems, type CommandPaletteCard, type CommandPaletteCommand } from "../../lib/command-palette";
import type { CommandPaletteCardSearchIndex } from "../../lib/command-palette-card-search";
import { cn } from "../../lib/utils";
import { CardIcon } from "./card-icon";
import { ThreadsIcon } from "./threads-icon";
import { ToggleListIcon } from "./toggle-list-icon";

type PaletteItem = CommandPaletteCommand | CommandPaletteCard;

interface CommandPaletteSurfaceProps {
  open: boolean;
  openTriggerTick: number;
  initialQuery?: string;
  commands: CommandPaletteCommand[];
  cards: CommandPaletteCard[];
  cardSearchIndex?: CommandPaletteCardSearchIndex | null;
  loading: boolean;
  onRequestClose: () => void;
  onExecute: (item: PaletteItem) => void;
}

function getCommandGlyph(id: string) {
  if (id === "open-project-picker") return FolderSearch2;
  if (id === "go-back") return ArrowLeft;
  if (id === "go-forward") return ArrowRight;
  if (id === "search-current-project") return Search;
  if (id === "toggle-terminal") return PanelBottom;
  if (id === "open-settings") return Settings2;
  if (id === "view-kanban") return SquareKanban;
  if (id === "view-list") return Table2;
  if (id === "view-toggle-list") return ToggleListIcon;
  if (id === "view-canvas") return LayoutGrid;
  if (id === "view-calendar") return CalendarDays;
  if (id === "focus-views-stage") return LayoutGrid;
  if (id === "focus-cards-stage") return CardIcon;
  if (id === "focus-threads-stage") return ThreadsIcon;
  return FileText;
}

function CommandRow({
  item,
  selected,
}: {
  item: CommandPaletteCommand;
  selected: boolean;
}) {
  const Glyph = getCommandGlyph(item.id);

  return (
    <div className="flex w-full items-center gap-2">
      <Glyph className={cn("size-4 shrink-0 text-token-description-foreground", selected && "text-token-foreground")} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">{item.title}</div>
      </div>
      {item.shortcut ? (
        <kbd className="shrink-0 rounded-sm bg-token-foreground/5 px-1.5 py-0.5 text-[11px] font-sans font-medium leading-none tracking-wide text-token-description-foreground">
          {item.shortcut}
        </kbd>
      ) : null}
    </div>
  );
}

function CardRow({
  item,
  selected,
  showSubtitle,
}: {
  item: CommandPaletteCard;
  selected: boolean;
  showSubtitle: boolean;
}) {
  const hasPreview = Boolean(item.searchPreview);
  const decorations = item.searchDecorations;
  const renderSegments = (
    segments: Array<{ text: string; highlight: boolean }>,
    keyPrefix: string,
  ) => segments.map((segment, index) => (
    <span
      key={`${keyPrefix}:${index}`}
      className={segment.highlight ? "rounded-[3px] bg-token-foreground/8 px-0.5 text-token-foreground" : undefined}
    >
      {segment.text}
    </span>
  ));
  return (
    <div className={cn("flex w-full gap-2", hasPreview ? "items-start" : "items-center")}>
      <div className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-lg bg-token-foreground/5 text-xs text-token-description-foreground",
        selected && "bg-token-foreground/10 text-token-foreground",
        hasPreview && "mt-0.5",
      )}>
        {item.projectIcon || item.projectName.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">
          {decorations?.titleSegments
            ? renderSegments(decorations.titleSegments, `${item.id}:title`)
            : item.card.title || "Untitled"}
        </div>
        {showSubtitle ? (
          <div className="truncate text-xs text-token-description-foreground">
            {decorations?.projectNameSegments
              ? renderSegments(decorations.projectNameSegments, `${item.id}:project`)
              : item.projectName}
            {" / "}
            {decorations?.columnNameSegments
              ? renderSegments(decorations.columnNameSegments, `${item.id}:column`)
              : item.columnName}
            {item.recentIndex !== null ? " / Recent" : ""}
          </div>
        ) : null}
        {decorations && decorations.badges.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {decorations.badges.map((badge) => (
              <span
                key={`${item.id}:badge:${badge.id}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md bg-token-foreground/5 px-1.5 py-0.5 text-[11px] leading-none text-token-description-foreground",
                  badge.tone === "monospace" && "font-mono",
                )}
              >
                <span className="text-token-description-foreground/80">{badge.label}</span>
                <span className={badge.tone === "monospace" ? "font-mono" : undefined}>
                  {renderSegments(badge.segments, `${item.id}:badge:${badge.id}`)}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {item.searchPreview ? (
          <div className="mt-1 line-clamp-3 text-xs/relaxed wrap-break-word text-token-description-foreground/90">
            {renderSegments(item.searchPreview.segments, `${item.id}:preview`)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaletteSection({
  title,
  items,
  selectedIndex,
  startIndex,
  onSelectIndex,
  onExecute,
  showSubtitle,
}: {
  title: string;
  items: PaletteItem[];
  selectedIndex: number;
  startIndex: number;
  onSelectIndex: (index: number) => void;
  onExecute: (item: PaletteItem) => void;
  showSubtitle: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section cmdk-group="" role="presentation" className="flex flex-col gap-[var(--spacing)]" data-value={title}>
      <div cmdk-group-heading="" aria-hidden="true">
        <span className="block px-2 pt-2 text-sm text-token-description-foreground">{title}</span>
      </div>
      <div cmdk-group-items="" role="group" aria-label={title}>
        {items.map((item, offset) => {
          const index = startIndex + offset;
          const selected = index === selectedIndex;
          return (
            <button
              key={item.id}
              type="button"
              cmdk-item=""
              data-palette-index={index}
              data-selected={selected}
              aria-selected={selected}
              onMouseMove={() => onSelectIndex(index)}
              onClick={() => onExecute(item)}
              disabled={item.kind === "command" && item.disabled}
              className={cn(
                "flex min-h-[calc(var(--spacing)*6)] w-full cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-left text-sm text-token-foreground opacity-75 outline-none",
                item.kind === "card" && item.searchPreview && "py-[calc(var(--padding-row-y)+2px)]",
                item.kind === "command" && item.disabled
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40"
                  : selected ? "bg-token-list-hover-background opacity-100" : "hover:bg-token-list-hover-background hover:opacity-100",
              )}
            >
              {item.kind === "command" ? (
                <CommandRow item={item} selected={selected} />
              ) : (
                <CardRow item={item} selected={selected} showSubtitle={showSubtitle} />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function CommandPaletteSurface({
  open,
  openTriggerTick,
  initialQuery,
  commands,
  cards,
  cardSearchIndex,
  loading,
  onRequestClose,
  onExecute,
}: CommandPaletteSurfaceProps) {
  const inputId = useId();
  const labelId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(
    () => filterCommandPaletteItems({
      query: deferredQuery,
      commands,
      cards,
      cardSearchIndex,
    }),
    [cardSearchIndex, cards, commands, deferredQuery],
  );
  const flatItems = useMemo(
    () => [...results.commands, ...results.cards],
    [results.cards, results.commands],
  );
  const showSubtitle = results.query.length > 0;
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!open) return;

    const nextQuery = initialQuery ?? "";
    setQuery(nextQuery);

    const rafId = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      if (!input) {
        return;
      }

      if (nextQuery.length > 0) {
        input.setSelectionRange(nextQuery.length, nextQuery.length);
        return;
      }

      input.select();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [initialQuery, open, openTriggerTick]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelectedIndex(0);
  }, [open, results.commandMode, results.query]);

  useEffect(() => {
    if (flatItems.length === 0) {
      if (selectedIndex === -1) return;
      setSelectedIndex(-1);
      return;
    }

    if (selectedIndex >= 0 && selectedIndex < flatItems.length) return;
    setSelectedIndex(0);
  }, [flatItems.length, selectedIndex]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    const next = scrollViewportRef.current?.querySelector<HTMLElement>(`[data-palette-index="${selectedIndex}"]`);
    next?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleExecute = (item: PaletteItem) => {
    onRequestClose();
    onExecute(item);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const moveSelection = (direction: -1 | 1) => {
      if (flatItems.length === 0) return;
      for (let step = 1; step <= flatItems.length; step += 1) {
        const nextIndex = (selectedIndex + direction * step + flatItems.length) % flatItems.length;
        const nextItem = flatItems[nextIndex];
        if (nextItem?.kind === "command" && nextItem.disabled) continue;
        setSelectedIndex(nextIndex);
        return;
      }
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      if (flatItems.length === 0) return;
      setSelectedIndex(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      if (flatItems.length === 0) return;
      setSelectedIndex(flatItems.length - 1);
      return;
    }

    if (event.key === "Enter") {
      if (selectedIndex < 0 || selectedIndex >= flatItems.length) return;
      event.preventDefault();
      handleExecute(flatItems[selectedIndex] as PaletteItem);
      return;
    }

    if (event.key !== "Escape" || query.trim().length === 0) return;
    event.preventDefault();
    setQuery("");
  };

  return (
    <div
      cmdk-root=""
      data-cmdk-root
      title="Command menu"
      className="flex min-w-full select-none flex-col gap-1.25 overflow-hidden rounded-3xl border border-token-border bg-token-dropdown-background px-1.25 py-[calc(var(--spacing)*1.15)] text-sm text-token-foreground shadow-[0_28px_90px_rgba(15,23,42,0.34),0_10px_28px_rgba(15,23,42,0.2)]"
    >
      <label
        cmdk-label=""
        htmlFor={inputId}
        id={labelId}
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0px, 0px, 0px, 0px)",
          whiteSpace: "nowrap",
          borderWidth: 0,
        }}
      >
        Command menu
      </label>
      <input
        ref={inputRef}
        cmdk-input=""
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-autocomplete="list"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-labelledby={labelId}
        id={inputId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search cards or type > for commands"
        aria-label="Command palette search"
        className="w-full border-none bg-transparent px-[calc(var(--spacing)*2.75)] py-[calc(var(--spacing)*1.75)] text-base text-token-foreground outline-none placeholder:text-token-description-foreground"
      />

      <div
        ref={scrollViewportRef}
        cmdk-list=""
        role="listbox"
        tabIndex={-1}
        aria-label="Suggestions"
        id={listId}
        className="scrollbar-token flex max-h-[min(420px,75vh)] flex-col gap-[var(--spacing)] overflow-y-auto overscroll-contain"
      >
        <PaletteSection
          title={results.commandMode ? "Commands" : "Quick actions"}
          items={results.commands}
          selectedIndex={selectedIndex}
          startIndex={0}
          onSelectIndex={setSelectedIndex}
          onExecute={handleExecute}
          showSubtitle={showSubtitle}
        />
        <PaletteSection
          title="Cards"
          items={results.cards}
          selectedIndex={selectedIndex}
          startIndex={results.commands.length}
          onSelectIndex={setSelectedIndex}
          onExecute={handleExecute}
          showSubtitle={showSubtitle}
        />
        {flatItems.length === 0 ? (
          <div data-cmdk-empty className="flex min-h-[calc(var(--spacing)*8)] items-center justify-center px-[calc(var(--spacing)*2.5)] py-[calc(var(--spacing)*1.5)] text-center text-sm text-token-description-foreground">
            {loading ? "Loading cards..." : "No matching commands or cards."}
          </div>
        ) : null}
      </div>
    </div>
  );
}
