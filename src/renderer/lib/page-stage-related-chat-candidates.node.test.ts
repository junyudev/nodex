import { describe, expect, test } from "vite-plus/test";

import type { Project, ProjectSession } from "./types";
import {
  presentPageStageRelatedChatCandidates,
  selectLinkableChatCandidates,
} from "./page-stage-related-chat-candidates";

const session = (overrides: Partial<ProjectSession> = {}): ProjectSession => ({
  id: "session:one",
  projectId: "project:one",
  noThreadFallbackTitle: "Fallback",
  displayTitle: "Chat one",
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  thread: null,
  createdAt: "2026-08-24T00:00:00Z",
  updatedAt: "2026-08-24T00:00:00Z",
  ...overrides,
});

describe("Page Stage related Chat candidates", () => {
  test("keeps threadless Chats, omits archived and repeated Chats, and resolves only useful picker context", () => {
    const projects = [{ id: "project:one", name: "Alpha" }] as Project[];
    expect(
      presentPageStageRelatedChatCandidates(
        [
          session(),
          session({
            id: "session:fallback",
            displayTitle: " ",
            noThreadFallbackTitle: "Planning",
            projectId: null,
          }),
          session({ id: "session:archived", archived: true }),
          session({ displayTitle: "Chat one, detailed" }),
        ],
        projects,
      ),
    ).toEqual([
      { sessionId: "session:one", displayTitle: "Chat one", projectName: "Alpha" },
      { sessionId: "session:fallback", displayTitle: "Planning", projectName: null },
    ]);
  });

  describe("linkable Chats", () => {
    const candidates = [
      { sessionId: "session:recent", displayTitle: "Recent chat", projectName: "Alpha" },
      { sessionId: "session:linked", displayTitle: "Linked chat", projectName: "Alpha" },
      { sessionId: "session:current", displayTitle: "Fix login", projectName: "Beta" },
      { sessionId: "session:loose", displayTitle: "Loose ends", projectName: null },
    ];
    const linkedSessionIds = new Set(["session:linked"]);
    const ids = (currentSessionId: string | null, query = "") =>
      selectLinkableChatCandidates(candidates, { linkedSessionIds, currentSessionId, query }).map(
        (candidate) => candidate.sessionId,
      );

    test("lists the current Chat first and keeps the catalog order for the rest", () => {
      expect(ids("session:current")).toEqual([
        "session:current",
        "session:recent",
        "session:loose",
      ]);
      expect(ids(null)).toEqual(["session:recent", "session:current", "session:loose"]);
    });

    test("never offers a Chat the Page already links to, even the current one", () => {
      expect(ids("session:linked")).toEqual(["session:recent", "session:current", "session:loose"]);
    });

    test("matches the title or Project and keeps the current Chat first among matches", () => {
      expect(ids("session:current", " BETA ")).toEqual(["session:current"]);
      expect(ids("session:current", "chat")).toEqual(["session:recent"]);
      expect(ids("session:recent", "l")).toEqual([
        "session:recent",
        "session:current",
        "session:loose",
      ]);
    });
  });
});
