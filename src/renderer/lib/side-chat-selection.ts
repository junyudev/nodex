import type { SideChatPanelTab } from "./workbench-panel-tab-model";

/** Prefer the active idle chat in the right panel, then the bottom panel. */
export function selectReusableSideChat(input: {
  readonly tabs: readonly SideChatPanelTab[];
  readonly isActive: (tab: SideChatPanelTab) => boolean;
  readonly isIdle: (tab: SideChatPanelTab) => boolean;
}): SideChatPanelTab | null {
  for (const panel of ["right", "bottom"] as const) {
    const candidates = input.tabs.filter((tab) => tab.panelId === panel);
    const ordered = [
      ...candidates.filter(input.isActive),
      ...candidates.filter((tab) => !input.isActive(tab)),
    ];
    const available = ordered.find(
      (tab) =>
        (tab.status === "loading" && tab.draftAttachmentMode === "append") ||
        (tab.status === "ready" && input.isIdle(tab)),
    );
    if (available) return available;
  }
  return null;
}
