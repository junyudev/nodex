import { localProjectSourceRoots } from "../../shared/project-sources";
import type { Project, ProjectSession, WorkbenchTabProjection } from "@/lib/types";
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

/**
 * Where a chat works: its execution location once it has one, else the Chat folder it reserved,
 * else its Project's folder. A chat with none of these gets a Chat folder when one is first needed.
 */
export function resolveSessionWorkingFolder(
  session: Pick<ProjectSession, "thread" | "folder">,
  project: Project | null | undefined,
): string | undefined {
  return (
    normalizeOptionalPath(session.thread?.cwd) ??
    normalizeOptionalPath(session.folder?.path) ??
    normalizeProjectPrimaryWorkspaceRoot(project)
  );
}

/** The one description of a Session that panel capabilities are resolved from. */
export function sessionPanelOwner(
  session: Pick<ProjectSession, "projectId" | "thread" | "folder" | "executionRef">,
  project: Project | null | undefined,
) {
  return {
    kind: "session",
    backendKind: session.thread?.backendBinding.kind ?? "codex",
    projectId: session.projectId,
    hasAttachedThread: Boolean(session.executionRef || session.thread),
    cwd: resolveSessionWorkingFolder(session, null),
    projectWorkspaceRoot: projectWorkspaceRootOrNull(project),
  } as const;
}

export function resolveSessionTerminalCwd(
  session: WorkbenchSessionRenderProjection,
  tab: WorkbenchTabProjection,
  projects: readonly Project[],
): string | undefined {
  const ownFolder = resolveSessionWorkingFolder(session, null);
  if (ownFolder) return ownFolder;

  const tabProjectId = "projectId" in tab.config ? tab.config.projectId : session.projectId;
  return (
    normalizeProjectPrimaryWorkspaceRoot(projects.find((project) => project.id === tabProjectId)) ??
    normalizeProjectPrimaryWorkspaceRoot(
      projects.find((project) => project.id === session.projectId),
    )
  );
}
