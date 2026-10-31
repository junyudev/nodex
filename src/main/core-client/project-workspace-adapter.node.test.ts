import { expect, test } from "vite-plus/test";

import {
  projectWorkspaceSessionSidebarPlacementFromCore,
  projectWorkspaceSidebarSectionSummaryFromCore,
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
  { project_id: "project:work", section_id: "section:direct", unread: true },
  { project_id: null, section_id: null, unread: false },
])("preserves nullable Session Sidebar placement coordinates: %j", (placement) => {
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
  });
});
