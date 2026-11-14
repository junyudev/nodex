import { ProjectFolderIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ProjectMarker } from "@/components/workbench/project-marker";
import { cn } from "@/lib/utils";
import type { Project } from "../../../shared/types";

/**
 * Names the Project a row belongs to, where rows from every Project share one stream: the
 * Project's own marker and name, as quiet as the line that says who sent a message. It is also the
 * way into that Project's Inbox, where the row waits among its own.
 */
export function InboxProjectLabel({
  project,
  onOpen,
  className,
}: {
  readonly project: Pick<Project, "id" | "name" | "appearance">;
  /** Opens the Project's own Inbox; without it the label only names the Project. */
  readonly onOpen?: () => void;
  readonly className?: string;
}) {
  const name = project.name.trim() || "Untitled";
  const labelClassName = cn(
    "flex max-w-48 min-w-0 shrink-0 items-center gap-1 text-xs text-token-description-foreground",
    className,
  );
  const label = (
    <>
      <ProjectMarker
        appearance={project.appearance}
        fallbackIcon={<ProjectFolderIcon />}
        className="size-3.5 text-xs [&>svg]:size-3.5"
      />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  if (!onOpen)
    return (
      <span data-inbox-project-id={project.id} className={labelClassName}>
        {label}
      </span>
    );
  return (
    <NodexTooltip tooltipContent={`Open ${name} Inbox`} side="top">
      <button
        type="button"
        data-inbox-project-id={project.id}
        aria-label={`Open ${name} Inbox`}
        onClick={onOpen}
        className={cn(labelClassName, "cursor-interaction hover:text-token-foreground")}
      >
        {label}
      </button>
    </NodexTooltip>
  );
}
