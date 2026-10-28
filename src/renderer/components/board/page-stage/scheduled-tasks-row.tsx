import { AutomationsIcon, InboxIcon } from "@/components/shared/icons";
import { DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME } from "@/components/database/property-value-chip";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useCodexScheduledAutomations } from "@/lib/use-codex-scheduled-automations";
import { cn } from "@/lib/utils";
import { useScheduledNavigation } from "@/features/scheduled/scheduled-navigation";
import { formatScheduledTaskScheduleLabel } from "@/features/scheduled/scheduled-task-model";
import { PageStagePropertyRow } from "./property-row";

/**
 * The scheduled tasks that follow this Page as their runbook, each opening in Scheduled. The row
 * appears only when a task follows the Page; its runs show among the Page's linked chats. Tasks
 * that ask first carry the Inbox glyph.
 */
export function PageScheduledTasksRow({ pageId }: { readonly pageId: string }) {
  const navigation = useScheduledNavigation();
  const tasks = (useCodexScheduledAutomations().data ?? []).filter(
    (task) => task.runbookPageId === pageId && task.status !== "DELETED",
  );
  if (tasks.length === 0) return null;
  return (
    <PageStagePropertyRow icon={<AutomationsIcon />} label="Scheduled">
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-1 py-0.5">
        {tasks.map((task) => {
          const schedule = [
            task.status === "PAUSED" ? "Paused" : formatScheduledTaskScheduleLabel(task),
            task.launch === "ask" ? "Asks in Inbox" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <NodexTooltip key={task.id} tooltipContent={schedule} side="bottom">
              <button
                type="button"
                data-page-stage-scheduled-task-id={task.id}
                disabled={!navigation}
                onClick={() => navigation?.openTask(task.id)}
                className={cn(
                  DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME,
                  "max-w-full min-w-0 gap-1 px-1.5 text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:opacity-60",
                )}
              >
                {/* Like a linked chat, the chip is its name; the schedule is a hover away. */}
                <span className="min-w-0 truncate">{task.name}</span>
                {task.launch === "ask" ? (
                  <InboxIcon className="icon-2xs shrink-0 text-token-description-foreground" />
                ) : null}
              </button>
            </NodexTooltip>
          );
        })}
      </div>
    </PageStagePropertyRow>
  );
}
