import type { Project } from "@/lib/types";

export interface WorkbenchAutomationProjectOption {
  projectId: string | null;
  value: string;
  label: string;
  description: string | null;
  isFallback: boolean;
}

function normalizeRoot(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function projectLabel(project: Project): string {
  return project.name.trim() || project.id;
}

function listProjectRoots(project: Project): string[] {
  const roots = new Set<string>();
  const primaryRoot = normalizeRoot(project.primaryWorkspaceRoot);
  if (primaryRoot) roots.add(primaryRoot);

  const orderedSources = [...project.sources].sort((left, right) => left.order - right.order);
  for (const source of orderedSources) {
    const root = normalizeRoot(source.root);
    if (root) roots.add(root);
  }

  return [...roots];
}

export function buildWorkbenchAutomationProjectOptions(input: {
  projects: readonly Project[];
  selectedRoots: readonly string[];
  selectedProjectId: string | null;
}): WorkbenchAutomationProjectOption[] {
  const options: WorkbenchAutomationProjectOption[] = [];
  const optionRoots = new Set<string>();

  for (const project of input.projects) {
    const label = projectLabel(project);
    for (const root of listProjectRoots(project)) {
      const key = JSON.stringify([project.id, root]);
      if (optionRoots.has(key)) continue;
      optionRoots.add(key);
      options.push({
        projectId: project.id,
        value: root,
        label,
        description: root,
        isFallback: false,
      });
    }
  }

  for (const selectedRoot of input.selectedRoots) {
    const root = normalizeRoot(selectedRoot);
    if (!root || optionRoots.has(JSON.stringify([input.selectedProjectId, root]))) continue;
    optionRoots.add(JSON.stringify([input.selectedProjectId, root]));
    options.push({
      projectId: input.selectedProjectId,
      value: root,
      label: root,
      description: null,
      isFallback: true,
    });
  }

  return options;
}

export function formatWorkbenchAutomationProjectTriggerLabel(input: {
  selectedRoots: readonly string[];
  options: readonly WorkbenchAutomationProjectOption[];
  selectedProjectId: string | null;
  placeholder?: string;
}): string {
  const placeholder = input.placeholder ?? "Select project";
  const selectedRoots = input.selectedRoots
    .map((root) => normalizeRoot(root))
    .filter((root): root is string => root !== null);
  if (input.selectedProjectId === null)
    return selectedRoots.length > 0 ? placeholder : "No project";
  if (selectedRoots.length === 0) return placeholder;

  const selectedRoot = selectedRoots[0];
  const option = input.options.find(
    (item) => item.projectId === input.selectedProjectId && item.value === selectedRoot,
  );
  const label = option?.label ?? selectedRoot ?? placeholder;
  return selectedRoots.length > 1 ? `${label} · ${selectedRoots.length} folders` : label;
}

export function resolveWorkbenchAutomationProjectForRoot(input: {
  projects: readonly Project[];
  root: string | null | undefined;
  projectId: string | null;
}): Project | null {
  const root = normalizeRoot(input.root);
  if (!root) return null;

  return (
    input.projects.find(
      (project) => project.id === input.projectId && listProjectRoots(project).includes(root),
    ) ?? null
  );
}

export function toggleWorkbenchAutomationProjectRoot(input: {
  selectedRoots: readonly string[];
  root: string;
}): string[] {
  const root = normalizeRoot(input.root);
  if (!root) return [...input.selectedRoots];

  const selectedRoots = input.selectedRoots
    .map((item) => normalizeRoot(item))
    .filter((item): item is string => item !== null);

  if (selectedRoots.includes(root)) {
    return selectedRoots.filter((item) => item !== root);
  }

  return [...selectedRoots, root];
}

export function selectWorkbenchAutomationProjectRoot(input: {
  projectId: string;
  selectedProjectId: string | null;
  selectedRoots: readonly string[];
  root: string;
}): { projectId: string; cwds: string[] } {
  return {
    projectId: input.projectId,
    cwds: toggleWorkbenchAutomationProjectRoot({
      selectedRoots: input.projectId === input.selectedProjectId ? input.selectedRoots : [],
      root: input.root,
    }),
  };
}
