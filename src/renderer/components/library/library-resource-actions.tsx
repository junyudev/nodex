import {
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
} from "react";

import {
  ArchiveIcon,
  MoveToIcon,
  OpenInIcon,
  ProjectAccessIcon,
  RefreshIcon,
  ProjectActionsIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { useApplyLibraryOperation } from "@/lib/use-library-navigation";
import {
  LibraryOpenInProjectModal,
  LibraryResourceAccessModal,
} from "./library-resource-action-modals";
import { DatabaseMoveDestinationPicker } from "./database-move-destination-picker";
import { PageMoveDestinationPicker } from "./page-move-destination-picker";
import type {
  LibraryProjectOption,
  LibraryResourceTarget,
  OpenLibraryResourceInProject,
} from "./library-resource-action-types";

export type { LibraryProjectOption, LibraryResourceTarget } from "./library-resource-action-types";

type PendingDialog = "manage_access" | "open_project" | "archive" | null;

const EMPTY_LIBRARY_PROJECTS: readonly LibraryProjectOption[] = [];

const stopActionPropagation = (event: SyntheticEvent<HTMLElement>): void => {
  event.stopPropagation();
};

const stopActionKeyPropagation = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.stopPropagation();
};

export function LibraryResourceActions({
  target,
  title,
  expectedLocationRevision,
  expectedMetadataRevision,
  lifecycle = "active",
  projects = EMPTY_LIBRARY_PROJECTS,
  triggerButton,
  onOpenInProject,
  open: controlledMenuOpen,
  onOpenChange,
}: {
  readonly target: LibraryResourceTarget;
  readonly title: string;
  readonly expectedLocationRevision: number;
  readonly expectedMetadataRevision?: number;
  readonly lifecycle?: "active" | "archived";
  readonly projects?: readonly LibraryProjectOption[];
  readonly triggerButton?: ReactElement;
  readonly onOpenInProject?: OpenLibraryResourceInProject;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const appHandle = useScopeHandle(appScope);
  const pendingDialogRef = useRef<PendingDialog>(null);
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const { mutation } = useApplyLibraryOperation();
  const menuOpen = controlledMenuOpen ?? uncontrolledMenuOpen;

  const changeMenuOpen = (open: boolean): void => {
    if (controlledMenuOpen === undefined) setUncontrolledMenuOpen(open);
    if (!open) setMoveSubmenuOpen(false);
    onOpenChange?.(open);
  };

  const applyLifecycle = async () => {
    if (expectedMetadataRevision === undefined) return;
    try {
      await mutation.mutateAsync({
        kind: lifecycle === "active" ? "archive_resource" : "restore_resource",
        target:
          target.kind === "page"
            ? {
                kind: "page",
                pageId: target.pageId,
                expectedMetadataRevision,
              }
            : {
                kind: "database",
                databaseId: target.databaseId,
                expectedMetadataRevision,
              },
      });
      setArchiveOpen(false);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not update Library item");
    }
  };

  const defaultTrigger = (
    <button
      type="button"
      aria-label={`Actions for ${title}`}
      className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-bg-secondary hover:text-token-text-primary focus-visible:outline focus-visible:outline-2"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <ProjectActionsIcon className="icon-xs" />
    </button>
  );

  return (
    <span
      className="contents"
      onClick={stopActionPropagation}
      onMouseDown={stopActionPropagation}
      onPointerDown={stopActionPropagation}
      onKeyDown={stopActionKeyPropagation}
    >
      <NodexDropdownMenu
        triggerButton={triggerButton ?? defaultTrigger}
        align="end"
        open={menuOpen}
        onOpenChange={changeMenuOpen}
        finalFocus={() => {
          const pendingDialog = pendingDialogRef.current;
          if (!pendingDialog) return true;
          pendingDialogRef.current = null;

          if (pendingDialog === "manage_access") {
            openModal(appHandle, LibraryResourceAccessModal, { target, title });
            return false;
          }
          if (pendingDialog === "open_project" && onOpenInProject) {
            openModal(appHandle, LibraryOpenInProjectModal, {
              target,
              title,
              projects,
              onOpenInProject,
            });
            return false;
          }
          setArchiveOpen(true);
          return false;
        }}
      >
        <NodexDropdownFlyoutSubmenuItem
          label="Move to"
          leftSlot={<MoveToIcon />}
          open={moveSubmenuOpen}
          onOpenChange={setMoveSubmenuOpen}
          contentClassName="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
          contentMotion="none"
        >
          {target.kind === "page" ? (
            <PageMoveDestinationPicker
              pageId={target.pageId}
              title={title}
              onClose={() => {
                setMoveSubmenuOpen(false);
                changeMenuOpen(false);
              }}
            />
          ) : (
            <DatabaseMoveDestinationPicker
              target={target}
              title={title}
              expectedLocationRevision={expectedLocationRevision}
              onClose={() => {
                setMoveSubmenuOpen(false);
                changeMenuOpen(false);
              }}
              onMoved={() => {
                setMoveSubmenuOpen(false);
                changeMenuOpen(false);
              }}
            />
          )}
        </NodexDropdownFlyoutSubmenuItem>
        <NodexDropdownItem
          leftSlot={<ProjectAccessIcon />}
          onSelect={() => {
            pendingDialogRef.current = "manage_access";
          }}
        >
          Manage access
        </NodexDropdownItem>
        {onOpenInProject ? (
          <NodexDropdownItem
            leftSlot={<OpenInIcon />}
            disabled={projects.length === 0}
            onSelect={() => {
              pendingDialogRef.current = "open_project";
            }}
          >
            Open in Project…
          </NodexDropdownItem>
        ) : null}
        {expectedMetadataRevision !== undefined ? (
          <NodexDropdownItem
            leftSlot={lifecycle === "active" ? <ArchiveIcon /> : <RefreshIcon />}
            onSelect={() => {
              if (lifecycle === "active") {
                pendingDialogRef.current = "archive";
                return;
              }
              void applyLifecycle();
            }}
          >
            {lifecycle === "active" ? "Archive" : "Restore"}
          </NodexDropdownItem>
        ) : null}
      </NodexDropdownMenu>

      <NodexDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <NodexDialogContent size="compact">
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>Archive this {target.kind}?</NodexDialogTitle>
              <NodexDialogDescription>
                {title} will leave the active Library and remain available under Archived.
              </NodexDialogDescription>
            </NodexDialogHeader>
            <NodexDialogFooter>
              <NodexDialogAction onClick={() => setArchiveOpen(false)}>Cancel</NodexDialogAction>
              <NodexDialogAction
                tone="danger"
                disabled={mutation.isPending}
                onClick={() => void applyLifecycle()}
              >
                Archive
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </span>
  );
}
