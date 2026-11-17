import type { ChatSearchMatch } from "../../shared/chat-search";
import type { FindHit, FindPhase, FindResponse } from "../../shared/find";
import type { PageSearchResult } from "../../shared/types";

export const pageFindHit = (page: PageSearchResult): FindHit => ({
  kind: "page",
  identity: page.pageId,
  title: page.title,
  location: { projectId: page.projectId, label: page.locationLabel },
  evidence: [],
  rank: { strong: true, text: 8, ordered: false },
  archived: page.archived ?? false,
  page,
});

export const chatFindHit = (chatMatch: ChatSearchMatch): FindHit => ({
  kind: "chat",
  identity: chatMatch.chat.sessionId,
  title: chatMatch.chat.title,
  location: { projectId: chatMatch.chat.projectId, label: chatMatch.chat.projectName },
  evidence: [],
  rank: { strong: true, text: 8, ordered: false },
  archived: chatMatch.chat.archived ?? false,
  chatMatch,
});

export const findFixture = (
  phase: FindPhase,
  hits: readonly FindHit[] = [],
  rest: Partial<FindResponse> = {},
): FindResponse => ({
  phase,
  hits,
  coverage: [],
  truncated: false,
  nextCursor: null,
  ...rest,
});
