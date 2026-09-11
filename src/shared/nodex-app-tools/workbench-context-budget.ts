import {
  WorkbenchObservedTabSchema,
  WORKBENCH_OBSERVATION_MAX_TABS,
  type WorkbenchObservedTab,
  type WorkbenchRendererObservation,
  type WorkbenchSubmitPresentation,
} from "./workbench";

// Leave space for physical window references, transport envelopes and future metadata.
export const WORKBENCH_CONTEXT_MAX_BYTES = 512 * 1_024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Omit ambiguous or invalid targets; partial context must never invent a usable capability. */
function selectBoundedTabs(
  tabs: readonly WorkbenchObservedTab[],
  focusedTabId: string | undefined,
  remainingBytes: number,
): Set<string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) counts.set(tab.tabId, (counts.get(tab.tabId) ?? 0) + 1);
  const priority = (tab: WorkbenchObservedTab) =>
    tab.tabId === focusedTabId ? 0 : tab.visible ? 1 : tab.selected ? 2 : 3;
  const retained = new Set<string>();
  for (const tab of [...tabs].sort((a, b) => priority(a) - priority(b))) {
    if (counts.get(tab.tabId) !== 1 || !WorkbenchObservedTabSchema.safeParse(tab).success) continue;
    // Include the group's membership and selected-tab reference as well as the descriptor.
    const cost = bytes(tab) + 2 * bytes(tab.tabId) + 4;
    if (cost > remainingBytes || retained.size === WORKBENCH_OBSERVATION_MAX_TABS) continue;
    remainingBytes -= cost;
    retained.add(tab.tabId);
  }
  return retained;
}

/** Transport projection only. The owner keeps the complete Scene for local commands. */
export function boundWorkbenchObservation(
  observation: WorkbenchRendererObservation,
): WorkbenchRendererObservation | null {
  const skeleton = {
    ...observation,
    tabs: [],
    focusedTarget: observation.focusedTarget,
    groups: observation.groups.map((group) => ({ ...group, tabIds: [], selectedTabId: null })),
  };
  const remaining = WORKBENCH_CONTEXT_MAX_BYTES - bytes(skeleton) - 256;
  if (remaining < 0) return null;
  const retained = selectBoundedTabs(observation.tabs, observation.focusedTarget?.tabId, remaining);
  const omittedTabCount =
    (observation.omittedTabCount ?? 0) + observation.tabs.length - retained.size;
  return {
    ...observation,
    tabs: observation.tabs.filter((tab) => retained.has(tab.tabId)),
    focusedTarget:
      observation.focusedTarget && retained.has(observation.focusedTarget.tabId)
        ? observation.focusedTarget
        : null,
    groups: observation.groups.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => retained.has(id)),
      selectedTabId:
        group.selectedTabId && retained.has(group.selectedTabId) ? group.selectedTabId : null,
    })),
    ...(omittedTabCount > 0 ? { availability: "partial" as const, omittedTabCount } : {}),
  };
}

export function boundWorkbenchSubmission(
  presentation: WorkbenchSubmitPresentation,
): WorkbenchSubmitPresentation {
  const skeleton = { ...presentation, selectedTabs: [] };
  const retained = selectBoundedTabs(
    presentation.selectedTabs,
    presentation.focusedTarget?.tabId,
    WORKBENCH_CONTEXT_MAX_BYTES - bytes(skeleton) - 256,
  );
  const omittedTabCount =
    (presentation.omittedTabCount ?? 0) + presentation.selectedTabs.length - retained.size;
  return {
    ...presentation,
    selectedTabs: presentation.selectedTabs.filter((tab) => retained.has(tab.tabId)),
    focusedTarget:
      presentation.focusedTarget && retained.has(presentation.focusedTarget.tabId)
        ? presentation.focusedTarget
        : null,
    ...(omittedTabCount > 0 ? { availability: "partial" as const, omittedTabCount } : {}),
  };
}
