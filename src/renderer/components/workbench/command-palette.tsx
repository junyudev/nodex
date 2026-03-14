import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { CommandPaletteCard, CommandPaletteCommand } from "@/lib/command-palette";
import { getKanbanProjectStore } from "@/lib/kanban-store";
import { normalizeProjectIcon } from "@/lib/project-icon";
import type { Project } from "@/lib/types";
import { useCommandPaletteCardSearchIndex } from "@/lib/use-command-palette-card-search-index";
import type { RecentCardSession, StageId, WorkbenchView } from "@/lib/use-workbench-state";
import { CommandPaletteSurface } from "./command-palette-surface";

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
  const { cards, loading } = useCommandPaletteCards(open, projects, activeProjectId, recentCardSessions);
  const cardSearchIndex = useCommandPaletteCardSearchIndex(cards);
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

  const handleExecute = (item: PaletteItem) => {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="max-w-2xl border-none bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <CommandPaletteSurface
          open={open}
          openTriggerTick={openTriggerTick}
          commands={commands}
          cards={cards}
          cardSearchIndex={cardSearchIndex}
          loading={loading}
          onRequestClose={() => onOpenChange(false)}
          onExecute={handleExecute}
        />
      </DialogContent>
    </Dialog>
  );
}
