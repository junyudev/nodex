export const SETTLED_CHATS_ROOT_PATH = "/settled";

/** The Settled page for every Project, or for one Project's chats. */
export function buildSettledChatsPath(projectId: string | null): string {
  return projectId === null
    ? SETTLED_CHATS_ROOT_PATH
    : `${SETTLED_CHATS_ROOT_PATH}?${new URLSearchParams({ project: projectId }).toString()}`;
}

export function parseSettledChatsPath(path: string): { readonly projectId: string | null } {
  const query = path.indexOf("?");
  const projectId =
    query === -1 ? null : new URLSearchParams(path.slice(query + 1)).get("project")?.trim();
  return { projectId: projectId || null };
}
