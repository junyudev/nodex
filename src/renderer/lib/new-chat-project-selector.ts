import { localProjectSourceRoots } from "../../shared/project-sources";
import type { Project } from "./types";
import type { ProjectAppearance } from "../../shared/project-appearance";

export interface NewChatProjectSelectorOption {
  id: string;
  label: string;
  appearance: ProjectAppearance;
  description: string | null;
  primaryWorkspaceRoot: string | null;
  searchText: string;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function getPrimaryWorkspaceRoot(project: Project): string | null {
  return (
    project.primaryWorkspaceRoot?.trim() ||
    localProjectSourceRoots(project.sources)[0]?.trim() ||
    null
  );
}

export function formatNewChatProjectSelectorOption(project: Project): NewChatProjectSelectorOption {
  const label = project.name.trim() || project.id;
  const primaryWorkspaceRoot = getPrimaryWorkspaceRoot(project);
  const description = primaryWorkspaceRoot || project.description.trim() || null;
  const searchText = normalizeSearchText(
    [project.id, project.name, project.description, primaryWorkspaceRoot ?? ""].join(" "),
  );

  return {
    id: project.id,
    label,
    appearance: project.appearance,
    description,
    primaryWorkspaceRoot,
    searchText,
  };
}

export function buildNewChatProjectSelectorOptions(
  projects: readonly Project[],
): NewChatProjectSelectorOption[] {
  return projects.map(formatNewChatProjectSelectorOption);
}

export function filterNewChatProjectSelectorOptions(
  options: readonly NewChatProjectSelectorOption[],
  search: string,
): NewChatProjectSelectorOption[] {
  const query = normalizeSearchText(search);
  if (!query) return [...options];
  return options.filter((option) => option.searchText.includes(query));
}

export function resolveSelectedNewChatProjectSelectorOption(
  options: readonly NewChatProjectSelectorOption[],
  selectedProjectId: string | null,
): NewChatProjectSelectorOption | null {
  if (!selectedProjectId) return null;
  return options.find((option) => option.id === selectedProjectId) ?? null;
}
