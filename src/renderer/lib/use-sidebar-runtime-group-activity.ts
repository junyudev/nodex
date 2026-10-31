import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  useAgentRuntimeActivities,
  type AgentRuntimeActivityStore,
} from "./agent-runtime-session-activity";
import { buildSidebarRuntimeGroupActivities } from "./sidebar-runtime-group-activity";
import { readSessionSidebarPlacements, SIDEBAR_SECTIONS_QUERY_KEY } from "./sidebar-sections-api";

export function sidebarRuntimeSessionPlacementsQueryOptions(sessionIds: Iterable<string>) {
  const ids = [...new Set(sessionIds)].sort();
  return {
    // Section mutations and the catalog's Project/Session change subscriptions invalidate
    // this prefix, covering placement, membership, archive and unread changes together.
    queryKey: [...SIDEBAR_SECTIONS_QUERY_KEY, "runtime-session-placements", ids],
    queryFn: async () => {
      // The initial activity snapshot is capped, but subsequent live pushes can exceed it.
      const batches = Array.from({ length: Math.ceil(ids.length / 500) }, (_, index) =>
        readSessionSidebarPlacements(ids.slice(index * 500, (index + 1) * 500)),
      );
      return (await Promise.all(batches)).flat();
    },
    enabled: ids.length > 0,
    // A Session starting or stopping changes the key; keep the last placements meanwhile so
    // collapsed groups never blink out while the new set loads.
    placeholderData: keepPreviousData,
  };
}

/** Subscribe once in the sidebar owner and pass each group's overlay to its presentation. */
export function useSidebarRuntimeGroupActivity(activityStore?: AgentRuntimeActivityStore) {
  const activities = useAgentRuntimeActivities(activityStore);
  const placements = useQuery(sidebarRuntimeSessionPlacementsQueryOptions(activities.keys()));
  return buildSidebarRuntimeGroupActivities(placements.data ?? [], activities);
}
