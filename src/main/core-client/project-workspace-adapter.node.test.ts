import { expect, test } from "vite-plus/test";

import { projectWorkspaceSidebarSectionSummaryFromCore } from "./project-workspace-adapter";

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
