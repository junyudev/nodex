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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { filterCommandPaletteItems, type CommandPaletteCard, type CommandPaletteCommand } from "@/lib/command-palette";
import { getKanbanProjectStore } from "@/lib/kanban-store";
import { normalizeProjectIcon } from "@/lib/project-icon";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { RecentCardSession, StageId, WorkbenchView } from "@/lib/use-workbench-state";
import { CardIcon } from "./card-icon";
import { ThreadsIcon } from "./threads-icon";
import { ToggleListIcon } from "./toggle-list-icon";

interface CommandPaletteProps {
  open: boolean;
  openTriggerTick: number;
  projects: Project[];
  activeProjectId: string;
  activeView: WorkbenchView;
  focusedStage: StageId;
  recentCardSessions: RecentCardSession[];
  onOpenChange: (open: boolean) => void;
  onOpenCard: (projectId: string, cardId: string, titleSnapshot?: string) => void;
  onFocusStage: (stageId: StageId) => void;
  onSetView: (view: WorkbenchView) => void;
  onOpenProjectPicker: () => void;
  onOpenTaskSearch: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onRequestNewWindow?: () => void;
}

type PaletteItem = CommandPaletteCommand | CommandPaletteCard;

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
}

function createShortcutLabel(label: string, isMac: boolean): string {
  if (isMac) {
    return label
      .replace("Cmd", "⌘")
      .replace("Shift", "⇧")
      .replace("Ctrl", "⌃");
  }

  return label.replace("Cmd", "Ctrl");
}

function useCommandPaletteCards(
  open: boolean,
  projects: Project[],
  activeProjectId: string,
  recentCardSessions: RecentCardSession[],
): { cards: CommandPaletteCard[]; loading: boolean } {
  const [version, setVersion] = useState(0);
  const stores = useMemo(
    () => projects.map((project) => ({ project, store: getKanbanProjectStore(project.id) })),
    [projects],
  );
  const recentIndexByKey = useMemo(() => {
    const index = new Map<string, number>();
    recentCardSessions.forEach((session, order) => {
      index.set(`${session.projectId}:${session.cardId}`, order);
    });
    return index;
  }, [recentCardSessions]);

  useEffect(() => {
    if (!open || stores.length === 0) return;

    const unsubscribe = stores.map(({ store }) =>
      store.subscribe(() => {
        setVersion((value) => value + 1);
      }),
    );

    return () => {
      unsubscribe.forEach((stop) => stop());
    };
  }, [open, stores]);

  return useMemo(() => {
    let loading = false;
    const cards: CommandPaletteCard[] = [];

    for (const { project, store } of stores) {
      const snapshot = store.getSnapshot();
      if (snapshot.loading && snapshot.cardIndex.size === 0) {
        loading = true;
      }

      const projectIcon = normalizeProjectIcon(project.icon);
      for (const card of snapshot.cardIndex.values()) {
        cards.push({
          kind: "card",
          id: `${project.id}:${card.id}`,
          projectId: project.id,
          projectName: project.name,
          projectIcon,
          columnName: card.columnName,
          card,
          inActiveProject: project.id === activeProjectId,
          recentIndex: recentIndexByKey.get(`${project.id}:${card.id}`) ?? null,
          boardIndex: card.boardIndex,
        });
      }
    }

    return { cards, loading };
  }, [activeProjectId, recentIndexByKey, stores, version]);
}

function buildCommands(input: {
  activeProjectName: string;
  activeView: WorkbenchView;
  focusedStage: StageId;
  canGoBack: boolean;
  canGoForward: boolean;
  canOpenNewWindow: boolean;
  isMac: boolean;
}): CommandPaletteCommand[] {
  const { activeProjectName, activeView, focusedStage, canGoBack, canGoForward, canOpenNewWindow, isMac } = input;
  const commands: CommandPaletteCommand[] = [
    {
      kind: "command",
      id: "go-back",
      title: "Go back",
      subtitle: "Return to the previous workbench context",
      keywords: ["back", "previous", "history", "navigation"],
      shortcut: createShortcutLabel("Cmd+[", isMac),
      disabled: !canGoBack,
      priority: 500,
    },
    {
      kind: "command",
      id: "go-forward",
      title: "Go forward",
      subtitle: "Move to the next workbench context",
      keywords: ["forward", "next", "history", "navigation"],
      shortcut: createShortcutLabel("Cmd+]", isMac),
      disabled: !canGoForward,
      priority: 490,
    },
    {
      kind: "command",
      id: "open-project-picker",
      title: "Open project picker",
      subtitle: "Switch spaces or edit the current project",
      keywords: ["project", "space", "switch"],
      shortcut: createShortcutLabel("Cmd+Shift+P", isMac),
      priority: 480,
    },
    {
      kind: "command",
      id: "search-current-project",
      title: "Search current project",
      subtitle: `Open task search for ${activeProjectName}`,
      keywords: ["search", "find", "tasks"],
      shortcut: createShortcutLabel("Cmd+F", isMac),
      priority: 470,
    },
    {
      kind: "command",
      id: "toggle-terminal",
      title: "Toggle terminal",
      subtitle: "Open or close the bottom terminal panel",
      keywords: ["terminal", "panel", "shell"],
      shortcut: createShortcutLabel("Cmd+J", isMac),
      priority: 460,
    },
    {
      kind: "command",
      id: "open-settings",
      title: "Open settings",
      subtitle: "Adjust workspace, editor, and worktree preferences",
      keywords: ["settings", "preferences", "config"],
      shortcut: createShortcutLabel("Cmd+,", isMac),
      priority: 450,
    },
    {
      kind: "command",
      id: "view-kanban",
      title: "Switch to board view",
      subtitle: `Show ${activeProjectName} in Kanban`,
      keywords: ["board", "kanban", "view"],
      active: activeView === "kanban",
      priority: 330,
    },
    {
      kind: "command",
      id: "view-list",
      title: "Switch to list view",
      subtitle: `Show ${activeProjectName} as a list`,
      keywords: ["list", "view"],
      active: activeView === "list",
      priority: 320,
    },
    {
      kind: "command",
      id: "view-toggle-list",
      title: "Switch to toggle list",
      subtitle: `Show ${activeProjectName} in the notebook list`,
      keywords: ["toggle", "notebook", "list", "view"],
      active: activeView === "toggle-list",
      priority: 310,
    },
    {
      kind: "command",
      id: "view-canvas",
      title: "Switch to canvas view",
      subtitle: `Show ${activeProjectName} on the canvas`,
      keywords: ["canvas", "view", "brainstorm"],
      active: activeView === "canvas",
      priority: 300,
    },
    {
      kind: "command",
      id: "view-calendar",
      title: "Switch to calendar view",
      subtitle: `Show ${activeProjectName} on the calendar`,
      keywords: ["calendar", "schedule", "view"],
      active: activeView === "calendar",
      priority: 290,
    },
    {
      kind: "command",
      id: "focus-views-stage",
      title: "Focus Views stage",
      subtitle: "Move focus to the project views rail",
      keywords: ["views", "stage", "focus"],
      shortcut: createShortcutLabel("Cmd+1", isMac),
      active: focusedStage === "db",
      priority: 250,
    },
    {
      kind: "command",
      id: "focus-cards-stage",
      title: "Focus Cards stage",
      subtitle: "Move focus to the card stage",
      keywords: ["cards", "stage", "focus"],
      shortcut: createShortcutLabel("Cmd+2", isMac),
      active: focusedStage === "cards",
      priority: 240,
    },
    {
      kind: "command",
      id: "focus-threads-stage",
      title: "Focus Threads stage",
      subtitle: "Move focus to the thread stage",
      keywords: ["threads", "stage", "focus"],
      shortcut: createShortcutLabel("Cmd+3", isMac),
      active: focusedStage === "threads",
      priority: 230,
    },
    {
      kind: "command",
      id: "focus-diff-stage",
      title: "Focus Diff stage",
      subtitle: "Move focus to the diff stage",
      keywords: ["diff", "files", "stage", "focus"],
      shortcut: createShortcutLabel("Cmd+4", isMac),
      active: focusedStage === "files",
      priority: 220,
    },
  ];

  if (!canOpenNewWindow) {
    return commands;
  }

  return [
    {
      kind: "command",
      id: "new-window",
      title: "Open new window",
      subtitle: "Create another Nodex window",
      keywords: ["window", "new"],
      shortcut: createShortcutLabel("Cmd+N", isMac),
      priority: 440,
    },
    ...commands,
  ];
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
  showSubtitle,
}: {
  item: CommandPaletteCommand;
  selected: boolean;
  showSubtitle: boolean;
}) {
  const Glyph = getCommandGlyph(item.id);

  return (
    <div className="flex w-full items-center gap-2">
      <Glyph className={cn("size-4 shrink-0 text-token-description-foreground", selected && "text-token-foreground")} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">{item.title}</div>
        {showSubtitle ? (
          <div className="truncate text-xs text-token-description-foreground">{item.subtitle}</div>
        ) : null}
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
  return (
    <div className="flex w-full items-center gap-2">
      <div className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-lg bg-token-foreground/5 text-xs text-token-description-foreground",
        selected && "bg-token-foreground/10 text-token-foreground",
      )}>
        {item.projectIcon || item.projectName.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">{item.card.title || "Untitled"}</div>
        {showSubtitle ? (
          <div className="truncate text-xs text-token-description-foreground">
            {item.projectName} / {item.columnName}
            {item.recentIndex !== null ? " / Recent" : ""}
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
                item.kind === "command" && item.disabled
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40"
                  : selected ? "bg-token-list-hover-background opacity-100" : "hover:bg-token-list-hover-background hover:opacity-100",
              )}
            >
              {item.kind === "command" ? (
                <CommandRow item={item} selected={selected} showSubtitle={false} />
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

export function CommandPalette({
  open,
  openTriggerTick,
  projects,
  activeProjectId,
  activeView,
  focusedStage,
  recentCardSessions,
  onOpenChange,
  onOpenCard,
  onFocusStage,
  onSetView,
  onOpenProjectPicker,
  onOpenTaskSearch,
  onToggleTerminal,
  onOpenSettings,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onRequestNewWindow,
}: CommandPaletteProps) {
  const isMac = isMacPlatform();
  const inputId = useId();
  const labelId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const { cards, loading } = useCommandPaletteCards(open, projects, activeProjectId, recentCardSessions);
  const activeProjectName = useMemo(
    () => projects.find((project) => project.id === activeProjectId)?.name ?? activeProjectId,
    [activeProjectId, projects],
  );
  const commands = useMemo(
    () => buildCommands({
      activeProjectName,
      activeView,
      focusedStage,
      canGoBack,
      canGoForward,
      canOpenNewWindow: Boolean(onRequestNewWindow),
      isMac,
    }),
    [activeProjectName, activeView, canGoBack, canGoForward, focusedStage, isMac, onRequestNewWindow],
  );
  const results = useMemo(
    () => filterCommandPaletteItems({
      query: deferredQuery,
      commands,
      cards,
    }),
    [cards, commands, deferredQuery],
  );
  const flatItems = useMemo(
    () => [...results.commands, ...results.cards],
    [results.cards, results.commands],
  );
  const showSubtitle = results.query.length > 0;
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!open) return;

    const rafId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [open, openTriggerTick]);

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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setSelectedIndex(0);
    }
    onOpenChange(nextOpen);
  };

  const handleExecute = (item: PaletteItem) => {
    handleOpenChange(false);

    if (item.kind === "card") {
      onOpenCard(item.projectId, item.card.id, item.card.title);
      return;
    }

    if (item.disabled) {
      return;
    }

    if (item.id === "go-back") {
      onGoBack();
      return;
    }
    if (item.id === "go-forward") {
      onGoForward();
      return;
    }
    if (item.id === "open-project-picker") {
      onOpenProjectPicker();
      return;
    }
    if (item.id === "search-current-project") {
      onOpenTaskSearch();
      return;
    }
    if (item.id === "toggle-terminal") {
      onToggleTerminal();
      return;
    }
    if (item.id === "open-settings") {
      onOpenSettings();
      return;
    }
    if (item.id === "new-window") {
      onRequestNewWindow?.();
      return;
    }
    if (item.id === "view-kanban") {
      onSetView("kanban");
      return;
    }
    if (item.id === "view-list") {
      onSetView("list");
      return;
    }
    if (item.id === "view-toggle-list") {
      onSetView("toggle-list");
      return;
    }
    if (item.id === "view-canvas") {
      onSetView("canvas");
      return;
    }
    if (item.id === "view-calendar") {
      onSetView("calendar");
      return;
    }
    if (item.id === "focus-views-stage") {
      onFocusStage("db");
      return;
    }
    if (item.id === "focus-cards-stage") {
      onFocusStage("cards");
      return;
    }
    if (item.id === "focus-threads-stage") {
      onFocusStage("threads");
      return;
    }
    onFocusStage("files");
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="max-w-[min(44rem,calc(100vw-2rem))] border-none bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div
          cmdk-root=""
          data-cmdk-root
          title="Command menu"
          className="flex min-w-full select-none flex-col gap-[var(--spacing)] overflow-hidden rounded-[var(--radius-3xl)] border border-token-border bg-token-dropdown-background p-[var(--spacing)] text-sm text-token-foreground shadow-2xl"
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
            placeholder="Search commands"
            aria-label="Command palette search"
            className="w-full border-none bg-transparent px-[calc(var(--spacing)*2.5)] py-[calc(var(--spacing)*1.5)] text-sm text-token-foreground outline-none placeholder:text-token-description-foreground"
          />

          <div
            ref={scrollViewportRef}
            cmdk-list=""
            role="listbox"
            tabIndex={-1}
            aria-label="Suggestions"
            id={listId}
            className="scrollbar-token flex max-h-[min(300px,70vh)] flex-col gap-[var(--spacing)] overflow-y-auto overscroll-contain"
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
      </DialogContent>
    </Dialog>
  );
}
