import { runWithCleanup } from "@/lib/run-with-cleanup";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ProjectFolderIcon,
  ProjectOpenActionIcon,
  ProjectPinnedIcon,
  ProjectPinIcon,
  ProjectRepositoryIcon,
  ProjectTaskIcon,
  SettingsGeneralIcon,
} from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import type { GitRepositoryIdentity } from "../../../shared/git-repository-identity";
import type { LocalPathPresentationContext } from "../../../shared/local-path-presentation";
import type { ProjectAppearance } from "../../../shared/project-appearance";
import type { Project, ProjectActivitySummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildProjectHoverCardMetadataRows,
  formatProjectActivitySummary,
} from "./project-hover-card-model";
import { ProjectMarkerPicker } from "./project-marker-picker";

type ProjectHoverCardBoundaryEvent =
  | PointerEvent<HTMLElement>
  | MouseEvent<HTMLElement>
  | KeyboardEvent<HTMLElement>;

export interface ProjectHoverCardProps {
  project: Project;
  activity: ProjectActivitySummary | null | undefined;
  repositoryIdentity: GitRepositoryIdentity | null;
  pathContext: LocalPathPresentationContext | null;
  appearance?: ProjectAppearance;
  appearancePending?: boolean;
  pinPending?: boolean;
  markerPickerOpen?: boolean;
  onMarkerPickerOpenChange?: (open: boolean) => void;
  onAppearanceChange: (appearance: ProjectAppearance) => void;
  onRename: (name: string) => Promise<void>;
  onSetPinned?: (pinned: boolean) => Promise<void>;
  onOpenSource: (path: string) => void;
  onEdit: () => void;
}

function stopBoundaryPropagation(event: ProjectHoverCardBoundaryEvent): void {
  event.stopPropagation();
}

function ProjectHoverCardRow({
  icon,
  children,
  onClick,
  showActionIndicator,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  showActionIndicator?: boolean;
}) {
  const resolvedShowActionIndicator = showActionIndicator ?? onClick !== undefined;
  const rowClassName = cn(
    "group/project-hover-card-row grid min-w-0 items-center gap-x-1.5 rounded-md",
    resolvedShowActionIndicator
      ? "grid-cols-[1rem_minmax(0,1fr)_1.25rem]"
      : "grid-cols-[1rem_minmax(0,1fr)]",
    onClick && [
      "cursor-interaction hover:bg-token-list-hover-background",
      "focus-visible:bg-token-list-hover-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
    ],
  );
  const content = (
    <>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-token-description-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
      {resolvedShowActionIndicator ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-token-description-foreground opacity-0 group-hover/project-hover-card-row:opacity-100 group-focus-visible/project-hover-card-row:opacity-100">
          <ProjectOpenActionIcon aria-hidden="true" />
        </span>
      ) : null}
    </>
  );

  if (!onClick) {
    return <div className={rowClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      className={cn(rowClassName, "text-left text-token-foreground")}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

export function ProjectHoverCard({
  project,
  activity,
  repositoryIdentity,
  pathContext,
  appearance: suppliedAppearance,
  appearancePending = false,
  pinPending = false,
  markerPickerOpen,
  onMarkerPickerOpenChange,
  onAppearanceChange,
  onRename,
  onSetPinned,
  onOpenSource,
  onEdit,
}: ProjectHoverCardProps) {
  const appearance = suppliedAppearance === undefined ? project.appearance : suppliedAppearance;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [renaming, setRenaming] = useState(false);
  const [internalMarkerPickerOpen, setInternalMarkerPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const resolvedMarkerPickerOpen = markerPickerOpen ?? internalMarkerPickerOpen;
  const metadataRows = buildProjectHoverCardMetadataRows({
    projectName: project.name,
    sources: project.sources,
    repositoryIdentity,
    pathContext,
  });

  if (!editingName && nameDraft !== project.name) {
    setNameDraft(project.name);
  }

  useEffect(() => {
    if (!editingName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [editingName]);

  const saveName = async (event: FocusEvent<HTMLInputElement>) => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setEditingName(false);
      setNameDraft(project.name);
      return;
    }

    const name = event.currentTarget.value.trim();
    setEditingName(false);
    if (!name || name === project.name) {
      setNameDraft(project.name);
      return;
    }

    setRenaming(true);
    await runWithCleanup(
      async () => {
        await onRename(name);
      },
      {
        onError: (error) => {
          setNameDraft(project.name);
          toast.danger("Could not rename project", {
            description: error instanceof Error ? error.message : undefined,
          });
        },
        cleanup: () => {
          setRenaming(false);
        },
      },
    );
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRenameRef.current = true;
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  const handleMarkerPickerOpenChange = (open: boolean) => {
    if (markerPickerOpen === undefined) {
      setInternalMarkerPickerOpen(open);
    }
    onMarkerPickerOpenChange?.(open);
  };

  const handleBoundaryKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !resolvedMarkerPickerOpen) return;
    event.stopPropagation();
  };

  return (
    <div
      className="flex max-h-[min(var(--nodex-floating-surface-available-height,calc(100vh-16px)),calc(100vh-16px))] w-[min(21rem,calc(100vw-16px))] min-w-72 max-w-full flex-col gap-1.5 px-row-x py-2 text-token-foreground"
      data-app-action-sidebar-project-hover-card=""
      onPointerDown={stopBoundaryPropagation}
      onMouseDown={stopBoundaryPropagation}
      onClick={stopBoundaryPropagation}
      onDoubleClick={stopBoundaryPropagation}
      onKeyDown={handleBoundaryKeyDown}
    >
      <div className="flex min-w-0 shrink-0 flex-col gap-1">
        <ProjectHoverCardRow
          icon={
            <ProjectMarkerPicker
              appearance={appearance}
              onAppearanceChange={onAppearanceChange}
              projectName={project.name}
              pending={appearancePending}
              open={resolvedMarkerPickerOpen}
              onOpenChange={handleMarkerPickerOpenChange}
              portalled={false}
              colorGroupLabel="Project color"
              iconGroupLabel="Project icon"
              buttonClassName="!h-5 !w-4 !p-0 text-token-description-foreground"
              markerClassName="!size-4"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1">
              {editingName ? (
                <input
                  ref={nameInputRef}
                  value={nameDraft}
                  disabled={renaming}
                  aria-label="Project name"
                  className="h-6 w-full min-w-0 rounded-md border border-token-focus-border bg-token-input-background px-1.5 text-base leading-6 font-medium text-token-input-foreground outline-none"
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={(event) => void saveName(event)}
                  onKeyDown={handleNameKeyDown}
                />
              ) : (
                <button
                  type="button"
                  className="block max-w-full min-w-0 truncate rounded-md text-left text-base leading-6 font-medium text-token-foreground hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background focus-visible:outline-none"
                  onClick={() => setEditingName(true)}
                >
                  {project.name}
                </button>
              )}
            </span>
            {onSetPinned ? (
              <button
                type="button"
                aria-label={project.pinned ? "Unpin project" : "Pin project"}
                aria-busy={pinPending}
                disabled={pinPending}
                className="flex h-5 w-5 items-center justify-center leading-none text-token-description-foreground hover:text-token-foreground focus-visible:outline-none disabled:opacity-50"
                onClick={() => void onSetPinned(!project.pinned)}
              >
                {project.pinned ? <ProjectPinnedIcon /> : <ProjectPinIcon />}
              </button>
            ) : null}
          </span>
        </ProjectHoverCardRow>
        <ProjectHoverCardRow icon={<ProjectTaskIcon />}>
          <span className="flex min-w-0 flex-1 flex-wrap text-sm leading-5 text-token-foreground">
            {formatProjectActivitySummary(activity)}
          </span>
        </ProjectHoverCardRow>
      </div>

      {metadataRows.length > 0 ? (
        <div className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto border-t border-token-border pt-1.5">
          {metadataRows.map((row) => (
            <ProjectHoverCardRow
              key={`${row.kind}:${row.label}`}
              icon={row.kind === "repository" ? <ProjectRepositoryIcon /> : <ProjectFolderIcon />}
              onClick={row.path ? () => onOpenSource(row.path as string) : undefined}
            >
              <span
                className={cn(
                  "flex min-w-0 items-baseline text-sm leading-5 text-token-foreground",
                  row.kind === "source" ? "break-all" : "truncate",
                )}
              >
                {row.label}
              </span>
            </ProjectHoverCardRow>
          ))}
        </div>
      ) : null}

      <div className="flex min-w-0 shrink-0 flex-col gap-1 border-t border-token-border pt-1.5">
        <ProjectHoverCardRow
          icon={<SettingsGeneralIcon className="icon-xs shrink-0" />}
          onClick={onEdit}
          showActionIndicator={false}
        >
          <span className="min-w-0 truncate text-sm leading-5 text-token-foreground">
            Edit project
          </span>
        </ProjectHoverCardRow>
      </div>
    </div>
  );
}
