import { normalizeProjectIcon } from "../../lib/project-icon";
import type { ProjectFormValues } from "../../lib/project-form";
import type { Project } from "../../../shared/types";

type ProjectDraftSource = Pick<Project, "id" | "name" | "icon" | "workspacePath">;

export const EMPTY_PROJECT_MANAGER_FORM_VALUES: ProjectFormValues = {
  id: "",
  name: "",
  icon: "",
  workspacePath: "",
};

export function resolveProjectManagerFormValues(project?: ProjectDraftSource | null): ProjectFormValues {
  return {
    id: project?.id ?? EMPTY_PROJECT_MANAGER_FORM_VALUES.id,
    name: project?.name ?? EMPTY_PROJECT_MANAGER_FORM_VALUES.name,
    icon: normalizeProjectIcon(project?.icon),
    workspacePath: project?.workspacePath ?? EMPTY_PROJECT_MANAGER_FORM_VALUES.workspacePath,
  };
}
