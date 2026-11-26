import { useQuery } from "@tanstack/react-query";
import { projectDetailQueryOptions } from "./query-options";
import { resolvePageExecutionContext } from "./page-execution-context";
import { resourceLocationProjectId } from "./resource-location-presentation";
import { useResourceLocation } from "./resource-location-queries";
import type { Project } from "./types";
import { projectWorkspaceRootOrNull } from "./workbench-workspace-context";

export function usePageExecutionContext(
  pageId: string,
  sceneProjectId: string | null,
  projects: readonly Project[],
  destination?: { readonly projectId: string | null } | null,
) {
  const location = useResourceLocation({ kind: "page", pageId });
  const resolvedLocation = location.data?.status === "available" ? location.data : null;
  const context = resolvePageExecutionContext({
    sceneProjectId,
    destination: destination ?? undefined,
    pageHomeProjectId: resourceLocationProjectId(resolvedLocation?.segments ?? []),
  });
  const project = projects.find((item) => item.id === context.executionProjectId);
  const workspaceProject = projects.find((item) => item.id === context.workspaceProjectId);
  const workspaceProjectDetail = useQuery({
    ...projectDetailQueryOptions(context.workspaceProjectId ?? ""),
    enabled: Boolean(resolvedLocation && context.workspaceProjectId && !workspaceProject),
  });
  const workspaceRoot = projectWorkspaceRootOrNull(workspaceProject ?? workspaceProjectDetail.data);
  return {
    ...context,
    projectName: project?.name ?? null,
    // Until Location resolves, a foreign Page's relative path has no known base.
    workspaceRoot: resolvedLocation ? workspaceRoot : null,
  };
}
