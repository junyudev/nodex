import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { canonicalWorkbenchFilePath } from "../../shared/workbench-resource-identity";
import type { FileReferenceRouterPort } from "./file-reference-router";
import type { WorkbenchSceneNavigator } from "./workbench-scene-navigator";
import type { Project } from "./types";
import { isWorkspacePathInsideRoot } from "../features/workspace-files/workspace-file-model";
import { getWorkspaceFileParentPath, normalizeOptionalPath } from "./workbench-workspace-context";
import { recordWorkspaceSearchFile } from "./workspace-search-recent-files";

/** File navigation belongs to the current Scene; it never establishes a conversation. */
export async function openWorkbenchSceneFile({
  owner,
  navigator,
  projects,
  input,
}: {
  readonly owner: WorkbenchSceneOwner;
  readonly navigator: WorkbenchSceneNavigator;
  readonly projects: readonly Project[];
  readonly input: Parameters<FileReferenceRouterPort["openWorkspaceFileTab"]>[0];
}): Promise<boolean> {
  if (input.isCurrent?.() === false) return false;
  const hostId = input.hostId ?? "local";
  const projectId = owner.kind === "project" ? owner.projectId : null;
  const project = projects.find((candidate) => candidate.id === projectId);
  const matchingRoot = (hostId === "local" ? project?.sources : undefined)
    ?.map((source) => source.root)
    .find((root) => isWorkspacePathInsideRoot(root, input.path));
  const workspaceRoot =
    normalizeOptionalPath(input.workspaceRoot) ??
    matchingRoot ??
    getWorkspaceFileParentPath(input.path);
  const cwd = normalizeOptionalPath(input.cwd) ?? workspaceRoot;
  const path = canonicalWorkbenchFilePath(input.path, cwd);
  const presented = await navigator.presentPanelSurface({
    owner,
    request: {
      kind: "files",
      titleSnapshot: input.title,
      config: { projectId, hostId, cwd, workspaceRoot, path },
      ...(input.location?.line
        ? { reveal: { kind: "file" as const, ...input.location, line: input.location.line } }
        : {}),
    },
    target: { panelId: input.panelId },
    mode: input.mode ?? "preview",
    navigation: "background",
    isCurrent: input.isCurrent,
  });
  if (presented.status !== "presented") {
    if (input.isCurrent?.() === false) return false;
    // A rejected replacement must not fall through to opening an external editor.
    throw new Error(presented.reason);
  }
  if (input.kind !== "directory") recordWorkspaceSearchFile(hostId, path);
  return true;
}
