import { useEffect, useEffectEvent, useRef } from "react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import type { Project, ProjectCreateInput } from "@/lib/types";
import { SidePanelPlusIcon } from "@/components/shared/icons";
import { CodexSidebarActionButton } from "./codex-sidebar";
import { ProjectCreateDialog } from "./project-edit-dialog";

export type SidebarCreateProjectHandler = (input: ProjectCreateInput) => Promise<Project | null>;

const CODEX_PROJECT_ADD_BUTTON_CLASS =
  "outline-hidden cursor-interaction relative isolate h-6 w-6 overflow-visible rounded-md !p-1 text-(--color-text-secondary-ghost) hover:text-(--color-text-secondary-ghost-hover)";

export function SidebarProjectAddButton({
  onCreateProject,
  openDialogTick,
}: {
  onCreateProject: SidebarCreateProjectHandler;
  openDialogTick?: number;
}) {
  const appHandle = useScopeHandle(appScope);
  const lastOpenDialogTickRef = useRef(openDialogTick ?? 0);

  const openProjectCreateDialog = () => {
    openModal(appHandle, ProjectCreateDialog, {
      onCreate: async ({ appearance, name, sources }) => {
        const project = await onCreateProject({
          appearance,
          name,
          sources,
        });
        if (!project) throw new Error("Could not create project");
      },
    });
  };
  const openProjectCreateDialogFromEffect = useEffectEvent(openProjectCreateDialog);

  useEffect(() => {
    if (openDialogTick === undefined || openDialogTick === lastOpenDialogTickRef.current) return;
    lastOpenDialogTickRef.current = openDialogTick;
    openProjectCreateDialogFromEffect();
  }, [openDialogTick]);

  return (
    <CodexSidebarActionButton
      label="Add new project"
      className={CODEX_PROJECT_ADD_BUTTON_CLASS}
      onClick={openProjectCreateDialog}
    >
      <SidePanelPlusIcon />
    </CodexSidebarActionButton>
  );
}
