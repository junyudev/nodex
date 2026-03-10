import { CalendarView } from "@/components/kanban/calendar-view";
import { KanbanBoard } from "@/components/kanban/board";
import { ListView } from "@/components/kanban/list-view";
import { ToggleListView } from "@/components/kanban/toggle-list-view";
import { CanvasView } from "@/components/kanban/canvas-view";
import type { Project } from "@/lib/types";
import type { WorkbenchView } from "@/lib/use-workbench-state";

interface MainViewHostProps {
  projectId: string;
  projects: Project[];
  view: WorkbenchView;
  searchQuery: string;
  cardStageCardId?: string;
  cardStageCloseRef: React.RefObject<(() => Promise<void>) | null>;
  pendingReminderOpen?: {
    projectId: string;
    cardId: string;
    occurrenceStart: string;
  } | null;
  onReminderHandled?: (payload: {
    projectId: string;
    cardId: string;
    occurrenceStart: string;
  }) => void;
  openCardStage: (
    projectId: string,
    cardId: string,
    titleSnapshot?: string,
  ) => void;
}

export function MainViewHost({
  projectId,
  projects,
  view,
  searchQuery,
  cardStageCardId,
  cardStageCloseRef,
  pendingReminderOpen,
  onReminderHandled,
  openCardStage,
}: MainViewHostProps) {
  if (view === "kanban") {
    return (
      <KanbanBoard
        projectId={projectId}
        projects={projects}
        searchQuery={searchQuery}
        openCardStage={openCardStage}
        cardStageCardId={cardStageCardId}
        cardStageCloseRef={cardStageCloseRef}
      />
    );
  }

  if (view === "list") {
    return (
      <ListView
        projectId={projectId}
        searchQuery={searchQuery}
        openCardStage={openCardStage}
        cardStageCardId={cardStageCardId}
        cardStageCloseRef={cardStageCloseRef}
      />
    );
  }

  if (view === "canvas") {
    return (
      <CanvasView
        projectId={projectId}
        openCardStage={openCardStage}
        cardStageCardId={cardStageCardId}
        cardStageCloseRef={cardStageCloseRef}
      />
    );
  }

  if (view === "calendar") {
    return (
      <CalendarView
        projectId={projectId}
        searchQuery={searchQuery}
        openCardStage={openCardStage}
        cardStageCardId={cardStageCardId}
        cardStageCloseRef={cardStageCloseRef}
        pendingReminderOpen={pendingReminderOpen?.projectId === projectId ? pendingReminderOpen : null}
        onReminderHandled={onReminderHandled}
      />
    );
  }

  return <ToggleListView projectId={projectId} searchQuery={searchQuery} />;
}
