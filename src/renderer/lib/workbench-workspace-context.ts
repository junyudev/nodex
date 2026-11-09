import { localProjectSourceRoots } from "../../shared/project-sources";
import type { Project, WorkbenchTabProjection } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";

export function normalizeOptionalPath(value: string | null | undefined): string | undefined {
  const trimmedValue = value?.trim();
  if (!trimmedValue) return undefined;
  return trimmedValue;
}

export function normalizeProjectPrimaryWorkspaceRoot(
  project: Project | null | undefined,
): string | undefined {
  return (
    normalizeOptionalPath(project?.primaryWorkspaceRoot) ??
    normalizeOptionalPath(localProjectSourceRoots(project?.sources ?? [])[0])
  );
}

export function projectWorkspaceRootOrNull(project: Project | null | undefined): string | null {
  return normalizeProjectPrimaryWorkspaceRoot(project) ?? null;
}

export function getWorkspaceFileParentPath(path: string): string {
  const normalizedPath = path.trim();
  const lastSlashIndex = Math.max(
    normalizedPath.lastIndexOf("/"),
    normalizedPath.lastIndexOf("\\"),
  );
  if (/^[A-Za-z]:[\\/]/.test(normalizedPath) && lastSlashIndex === 2) {
    return normalizedPath.slice(0, 3);
  }
  if (lastSlashIndex > 0) return normalizedPath.slice(0, lastSlashIndex);
  if (lastSlashIndex === 0) return normalizedPath.slice(0, 1);
  return "";
}

export function resolveSessionTerminalCwd(
  session: WorkbenchSessionRenderProjection,
  tab: WorkbenchTabProjection,
  projects: readonly Project[],
): string | undefined {
  const threadCwd = normalizeOptionalPath(session.thread?.cwd);
  if (threadCwd) return threadCwd;

  const tabProjectId = "projectId" in tab.config ? tab.config.projectId : session.projectId;
  return (
    normalizeProjectPrimaryWorkspaceRoot(projects.find((project) => project.id === tabProjectId)) ??
    normalizeProjectPrimaryWorkspaceRoot(
      projects.find((project) => project.id === session.projectId),
    )
  );
}
