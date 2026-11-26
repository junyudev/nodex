/** Derive action defaults and the base for Page-authored paths independently. */
export function resolvePageExecutionContext({
  sceneProjectId,
  pageHomeProjectId,
  destination,
}: {
  readonly sceneProjectId: string | null;
  readonly pageHomeProjectId: string | null;
  readonly destination?: { readonly projectId: string | null };
}) {
  const launchProjectId = sceneProjectId ?? pageHomeProjectId;
  return {
    executionProjectId: sceneProjectId,
    launchProjectId,
    targetProjectId: destination ? destination.projectId : launchProjectId,
    workspaceProjectId: pageHomeProjectId ?? sceneProjectId,
  };
}
