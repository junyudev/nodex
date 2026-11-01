import type { SessionSidebarPlacement } from "../../shared/sidebar-sections";
import type { ProjectActivitySummary } from "../../shared/types";
import type { SessionLiveIndicator } from "./session-execution";

export interface SidebarRuntimeGroupActivity {
  readonly waitingCount: number;
  /** Running or background Sessions, including those that are unread. */
  readonly runningCount: number;
  readonly unreadWaitingCount: number;
  readonly unreadRunningCount: number;
}

export interface SidebarRuntimeGroupActivities {
  readonly projects: ReadonlyMap<string, SidebarRuntimeGroupActivity>;
  readonly sections: ReadonlyMap<string, SidebarRuntimeGroupActivity>;
}

/** Join from the bounded live set, independently of which sidebar rows are loaded. */
export function buildSidebarRuntimeGroupActivities(
  placements: readonly SessionSidebarPlacement[],
  activities: ReadonlyMap<string, { readonly status: SessionLiveIndicator }>,
): SidebarRuntimeGroupActivities {
  const projects = new Map<string, SidebarRuntimeGroupActivity>();
  const sections = new Map<string, SidebarRuntimeGroupActivity>();
  const seen = new Set<string>();
  const add = (
    groups: Map<string, SidebarRuntimeGroupActivity>,
    id: string | null,
    waiting: boolean,
    unread: boolean,
  ) => {
    if (id === null) return;
    const previous = groups.get(id);
    groups.set(id, {
      waitingCount: (previous?.waitingCount ?? 0) + Number(waiting),
      runningCount: (previous?.runningCount ?? 0) + Number(!waiting),
      unreadWaitingCount: (previous?.unreadWaitingCount ?? 0) + Number(waiting && unread),
      unreadRunningCount: (previous?.unreadRunningCount ?? 0) + Number(!waiting && unread),
    });
  };
  for (const placement of placements) {
    const status = activities.get(placement.sessionId)?.status;
    if (!status || seen.has(placement.sessionId)) continue;
    seen.add(placement.sessionId);
    add(
      projects,
      placement.projectId,
      status === "waiting" || status === "approval",
      placement.unread,
    );
    add(
      sections,
      placement.sectionId,
      status === "waiting" || status === "approval",
      placement.unread,
    );
  }
  return { projects, sections };
}

/** Core supplies task/unread counts; Runtime supplies exclusive waiting and active buckets. */
export function mergeRuntimeProjectActivity(
  summary: ProjectActivitySummary | null | undefined,
  runtime: SidebarRuntimeGroupActivity | undefined,
): ProjectActivitySummary | null | undefined {
  if (!summary || !runtime) return summary;
  return {
    ...summary,
    waitingCount: summary.waitingCount + runtime.waitingCount,
    unreadCount: Math.max(0, summary.unreadCount - runtime.unreadWaitingCount),
    activeCount: summary.activeCount + runtime.runningCount - runtime.unreadRunningCount,
  };
}
