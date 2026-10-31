import { describe, expect, it } from "vite-plus/test";
import type { SessionSidebarPlacement } from "../../shared/sidebar-sections";
import type { SessionLiveIndicator } from "./session-execution";
import {
  buildSidebarRuntimeGroupActivities,
  mergeRuntimeProjectActivity,
} from "./sidebar-runtime-group-activity";

const placement = (
  sessionId: string,
  unread = false,
  projectId: string | null = "project",
  sectionId: string | null = "section",
): SessionSidebarPlacement => ({ sessionId, unread, projectId, sectionId });

const core = {
  projectId: "project",
  taskCount: 5,
  waitingCount: 1,
  unreadCount: 2,
  activeCount: 0,
};

describe("sidebar Runtime group activity", () => {
  it("joins live Sessions to both groups without requiring loaded rows", () => {
    const activities = new Map<string, { status: SessionLiveIndicator }>([
      ["waiting-unread", { status: "waiting" }],
      ["running", { status: "running" }],
      ["background-unread", { status: "background" }],
      ["archived-or-missing", { status: "waiting" }],
    ]);
    const groups = buildSidebarRuntimeGroupActivities(
      [
        placement("waiting-unread", true),
        placement("running"),
        placement("background-unread", true),
        placement("idle"),
        placement("running"),
      ],
      activities,
    );
    const runtime = {
      waitingCount: 1,
      runningCount: 2,
      unreadWaitingCount: 1,
      unreadRunningCount: 1,
    };
    expect([...groups.projects]).toEqual([["project", runtime]]);
    expect([...groups.sections]).toEqual([["section", runtime]]);
    expect(mergeRuntimeProjectActivity(core, groups.projects.get("project"))).toEqual({
      ...core,
      waitingCount: 2,
      unreadCount: 1,
      activeCount: 1,
    });
    expect(core.unreadCount).toBe(2);
  });

  it.each([
    ["waiting", false, 1, 2, 0],
    ["waiting", true, 1, 1, 0],
    ["running", false, 0, 2, 1],
    ["running", true, 0, 2, 0],
    ["background", false, 0, 2, 1],
    ["background", true, 0, 2, 0],
  ] as const)(
    "keeps %s and unread=%s in exclusive Project buckets",
    (status, unread, waiting, unreadCount, active) => {
      const groups = buildSidebarRuntimeGroupActivities(
        [placement("session", unread)],
        new Map([["session", { status }]]),
      );
      expect(mergeRuntimeProjectActivity(core, groups.projects.get("project"))).toEqual({
        ...core,
        waitingCount: core.waitingCount + waiting,
        unreadCount,
        activeCount: active,
      });
    },
  );

  it("keeps Project and effective Section membership independent, including projectless Sessions", () => {
    const groups = buildSidebarRuntimeGroupActivities(
      [
        placement("override", false, "project", "override"),
        placement("projectless", true, null, "direct"),
        placement("unplaced", false, "other", null),
      ],
      new Map([
        ["override", { status: "waiting" }],
        ["projectless", { status: "background" }],
        ["unplaced", { status: "running" }],
      ]),
    );
    expect([...groups.projects.keys()]).toEqual(["project", "other"]);
    expect([...groups.sections.keys()]).toEqual(["override", "direct"]);
    expect(groups.sections.get("direct")).toEqual({
      waitingCount: 0,
      runningCount: 1,
      unreadWaitingCount: 0,
      unreadRunningCount: 1,
    });
  });

  it("removes settled activity and preserves unknown Core summaries", () => {
    const groups = buildSidebarRuntimeGroupActivities([placement("settled")], new Map());
    expect(groups.projects.size).toBe(0);
    expect(groups.sections.size).toBe(0);
    expect(mergeRuntimeProjectActivity(core, undefined)).toBe(core);
    const runtime = {
      waitingCount: 2,
      runningCount: 0,
      unreadWaitingCount: 2,
      unreadRunningCount: 0,
    };
    expect(mergeRuntimeProjectActivity(undefined, runtime)).toBeUndefined();
    expect(mergeRuntimeProjectActivity(null, runtime)).toBeNull();
    expect(mergeRuntimeProjectActivity({ ...core, unreadCount: 0 }, runtime)?.unreadCount).toBe(0);
  });
});
