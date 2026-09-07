import type { WorkbenchSceneCommandLifecycle } from "./workbench-scene-commands";
import type { WorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";

/** Opener routing follows the committed command's actual group, including UI background opens. */
export function workbenchSceneCommandOpenerLifecycle(
  store: WorkbenchPanelTabOpenerStore,
): Pick<WorkbenchSceneCommandLifecycle, "getOpenerState" | "didApply"> {
  return {
    getOpenerState: (sceneOwner, panelId, groupId) =>
      store.get(makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(sceneOwner), panelId, groupId)),
    didApply: (sceneOwner, command, before, after, result, options) => {
      const previous = readWorkbenchAgentContext(before, sceneOwner);
      const current = readWorkbenchAgentContext(after, sceneOwner);
      if (!current) return;
      const scope = (panelId: "right" | "bottom", groupId: string) =>
        makeWorkbenchPanelSlotKey(makeWorkbenchSceneKey(sceneOwner), panelId, groupId);
      for (const group of previous?.groups ?? []) {
        if (
          !current.groups.some(
            (candidate) =>
              candidate.panelId === group.panelId && candidate.groupId === group.groupId,
          )
        )
          store.pruneScope(scope(group.panelId, group.groupId));
      }
      if (command.kind === "reorder_tabs") {
        const oldGroup = previous?.groups.find(
          (group) => group.panelId === command.panelId && group.groupId === command.groupId,
        );
        const nextGroup = current.groups.find(
          (group) => group.panelId === command.panelId && group.groupId === command.groupId,
        );
        if (
          oldGroup &&
          nextGroup &&
          oldGroup.tabIds.some((id, index) => nextGroup.tabIds[index] !== id)
        ) {
          for (const id of oldGroup.tabIds)
            store.recordMoved(scope(command.panelId, command.groupId), id);
        }
        return;
      }
      const previousTab = previous?.tabs.find((tab) => tab.tabId === result.tabId);
      const nextTab = current.tabs.find((tab) => tab.tabId === result.tabId);
      if (
        previousTab?.panelId &&
        previousTab.groupId &&
        (command.kind === "close_tab" ||
          command.kind === "move_tab" ||
          command.kind === "split_group")
      ) {
        const key = scope(previousTab.panelId, previousTab.groupId);
        if (command.kind === "close_tab") store.recordClosed(key, previousTab.tabId);
        else store.recordMoved(key, previousTab.tabId);
      }
      if (!nextTab?.panelId || !nextTab.groupId) return;
      const group = current.groups.find(
        (candidate) =>
          candidate.panelId === nextTab.panelId && candidate.groupId === nextTab.groupId,
      );
      if (!group) return;
      const key = scope(nextTab.panelId, nextTab.groupId);
      if (
        command.kind === "open_tab" &&
        !previousTab &&
        options.open?.openerTabId &&
        group.tabIds.includes(options.open.openerTabId)
      )
        store.recordOpened(key, {
          tabId: nextTab.tabId,
          openerTabId: options.open.openerTabId,
          openedInBackground: options.open.presentation === "background",
        });
      if (
        (command.kind === "activate_tab" || command.kind === "open_tab") &&
        options.open?.presentation !== "background"
      )
        store.recordActivated(key, nextTab.tabId, group.tabIds);
    },
  };
}
