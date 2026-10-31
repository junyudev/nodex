import type { PageStageRelatedChatCandidate } from "@/components/board/page-stage/types";
import type { Project, ProjectSession } from "./types";

/** A chat's title as pickers show it, falling back like the sidebar does. */
export function presentChatTitle(
  session: Pick<ProjectSession, "displayTitle" | "noThreadFallbackTitle">,
): string {
  return session.displayTitle.trim() || session.noThreadFallbackTitle.trim() || "New chat";
}

/**
 * Presents the loaded Chat catalog without leaking Workbench Scene state into Page Stage. A
 * Chat listed twice keeps its first place.
 */
export function presentPageStageRelatedChatCandidates(
  sessions: readonly ProjectSession[],
  projects: readonly Project[],
): PageStageRelatedChatCandidate[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name.trim()]));
  const seen = new Set<string>();
  return sessions.flatMap((session) => {
    if (session.archived || seen.has(session.id)) return [];
    seen.add(session.id);
    return [
      {
        sessionId: session.id,
        displayTitle: presentChatTitle(session),
        projectName: session.projectId ? projectNames.get(session.projectId) || null : null,
      },
    ];
  });
}

/**
 * The Chats a Page can still link to, matching `query` by title or Project. The Chat whose
 * Scene shows the Page comes first, since it is the one a Page opened there most often joins.
 */
export function selectLinkableChatCandidates(
  candidates: readonly PageStageRelatedChatCandidate[],
  {
    linkedSessionIds,
    currentSessionId,
    query,
  }: {
    readonly linkedSessionIds: ReadonlySet<string>;
    readonly currentSessionId: string | null;
    readonly query: string;
  },
): PageStageRelatedChatCandidate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const linkable = candidates.filter(
    (candidate) =>
      !linkedSessionIds.has(candidate.sessionId) &&
      (!normalizedQuery ||
        [candidate.displayTitle, candidate.projectName].some((value) =>
          value?.toLocaleLowerCase().includes(normalizedQuery),
        )),
  );
  const current = linkable.find((candidate) => candidate.sessionId === currentSessionId);
  return current ? [current, ...linkable.filter((candidate) => candidate !== current)] : linkable;
}
