import { expect, test } from "vite-plus/test";

import type { PageTurn } from "../../shared/page-turn";
import { inboxCountsFromCore } from "./inbox-adapter";
import {
  projectWorkspaceSessionSidebarPlacementFromCore,
  projectWorkspaceSidebarSectionSummaryFromCore,
  projectWorkspaceTaskFromCore,
} from "./project-workspace-adapter";

test.each([
  { has_waiting: true, has_running: false, has_unread: true },
  { has_waiting: false, has_running: true, has_unread: false },
])("preserves independent Sidebar Section activity flags: %j", (activity) => {
  expect(
    projectWorkspaceSidebarSectionSummaryFromCore({
      section_id: "section:work",
      kind: "custom",
      name: "Work",
      rank_key: 1,
      revision: 2,
      lifecycle: "active",
      direct_item_count: 3,
      effective_session_count: 4,
      ...activity,
    }),
  ).toEqual({
    sectionId: "section:work",
    kind: "custom",
    name: "Work",
    rankKey: 1,
    revision: 2,
    lifecycle: "active",
    directItemCount: 3,
    effectiveSessionCount: 4,
    hasWaiting: activity.has_waiting,
    hasRunning: activity.has_running,
    hasUnread: activity.has_unread,
  });
});

test.each([
  {
    project_id: "project:work",
    section_id: "section:direct",
    unread: true,
    snoozed_until: "2026-11-02T09:00:00.000Z",
  },
  { project_id: null, section_id: null, unread: false, snoozed_until: null },
])("preserves nullable Session Sidebar placement and snoozes: %j", (placement) => {
  expect(
    projectWorkspaceSessionSidebarPlacementFromCore({
      session_id: "session:live",
      ...placement,
    }),
  ).toEqual({
    sessionId: "session:live",
    projectId: placement.project_id,
    sectionId: placement.section_id,
    unread: placement.unread,
    snoozedUntil: placement.snoozed_until,
  });
});

const reviewTurn: PageTurn = {
  page_id: "page",
  actor: { kind: "member", member_id: "person" },
  episode: "review-episode",
  reason: "review",
  since: "2026-11-02T09:00:00.000Z",
  hold: null,
};

test.each([reviewTurn, null])(
  "carries the current Page Turn from Core into the chat summary: %j",
  (pageTurn) => {
    expect(
      projectWorkspaceTaskFromCore({
        session: {
          id: "chat",
          project_id: "work",
          no_thread_fallback_title: "A chat",
          display_title: "A chat",
          activity_at: 0,
          attention_at: 0,
          pinned: false,
          managed: false,
          archived: false,
          unread: false,
          page_turn: pageTurn,
          can_manage: true,
          can_stop: true,
          created_at: reviewTurn.since,
          updated_at: reviewTurn.since,
        },
      }).pageTurn,
    ).toEqual(pageTurn);
  },
);

test("keeps the Inbox waiting signal independent of its count", () => {
  const waiting = { library: true, projects: { work: true, planning: false } };
  expect(
    inboxCountsFromCore({
      library_count: 3,
      projects: [
        { project_id: "work", inbox_count: 1 },
        { project_id: "planning", inbox_count: 2 },
      ],
      waiting,
    }),
  ).toEqual({
    library: 3,
    projects: { work: 1, planning: 2 },
    waiting,
  });
});
