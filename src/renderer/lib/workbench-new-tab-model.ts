import type { WorkbenchRendererObservation } from "../../shared/nodex-app-tools/workbench";
import { isNodexPanelOptionAction, type PanelNewTabAction } from "./workbench-panel-actions";

/** A New tab's Tools grid holds four rows of two tiles, counting `Chat` and `More tools…`. */
export const NEW_TAB_TOOL_SLOTS = 8;

export interface NewTabToolLayout {
  /** Tools shown as tiles: shortcut-bearing tools, the other tools, then project content. */
  readonly tiles: readonly PanelNewTabAction[];
  /** General tools that did not fit in the grid. */
  readonly moreTools: readonly PanelNewTabAction[];
  /** Project content destinations that did not fit in the grid. */
  readonly projectContent: readonly PanelNewTabAction[];
}

/**
 * Lays out a New tab's Tools. A New tab already is a Browser, so Browser is never a tool.
 * Shortcut-bearing tools lead, the rest keep capability order, and project content follows.
 * Only when they do not all fit does the last slot become `More tools…` for the rest.
 */
export function resolveNewTabToolLayout(
  actions: readonly PanelNewTabAction[],
  options: {
    readonly hasChat: boolean;
    readonly hasShortcut: (action: PanelNewTabAction) => boolean;
  },
): NewTabToolLayout {
  const tools = actions.filter((action) => action.kind !== "browser");
  const general = tools.filter((action) => !isNodexPanelOptionAction(action));
  const ordered = [
    ...general.filter(options.hasShortcut),
    ...general.filter((action) => !options.hasShortcut(action)),
    ...tools.filter(isNodexPanelOptionAction),
  ];
  const slots = options.hasChat ? NEW_TAB_TOOL_SLOTS - 1 : NEW_TAB_TOOL_SLOTS;
  const tileCount = ordered.length > slots ? slots - 1 : slots;
  const overflow = ordered.slice(tileCount);
  return {
    tiles: ordered.slice(0, tileCount),
    moreTools: overflow.filter((action) => !isNodexPanelOptionAction(action)),
    projectContent: overflow.filter(isNodexPanelOptionAction),
  };
}

export type NewTabReplacementPlan =
  | { readonly kind: "keep" }
  | {
      readonly kind: "replace";
      readonly groupId: string;
      /** The group's order with the opened tab moved into the New tab's place, if it moved. */
      readonly reorderedTabIds: readonly string[] | null;
    };

/**
 * Decides how an intent's result takes a New tab's place. A tab opened in the New tab's
 * group moves to the New tab's position; a tab revealed elsewhere still retires the New
 * tab. When nothing else became visible, the New tab stays.
 */
export function planNewTabReplacement({
  newTabId,
  before,
  after,
}: {
  readonly newTabId: string;
  readonly before: WorkbenchRendererObservation | null;
  readonly after: WorkbenchRendererObservation | null;
}): NewTabReplacementPlan {
  const beforeGroup = before?.groups.find((group) => group.tabIds.includes(newTabId));
  const afterGroup = after?.groups.find((group) => group.groupId === beforeGroup?.groupId);
  if (!before || !after || !beforeGroup || !afterGroup?.tabIds.includes(newTabId)) {
    return { kind: "keep" };
  }

  const openedId = afterGroup.selectedTabId;
  if (openedId && openedId !== newTabId) {
    const opened = after.tabs.find((tab) => tab.tabId === openedId);
    // Durable tabs and renderer-local tabs such as Side chat take the New tab's position;
    // a preview keeps its own slot.
    const movable = opened?.persisted === true || opened?.auxiliary != null;
    const moves = !beforeGroup.tabIds.includes(openedId) && movable;
    return {
      kind: "replace",
      groupId: afterGroup.groupId,
      reorderedTabIds: moves ? placeBefore(afterGroup.tabIds, openedId, newTabId) : null,
    };
  }

  // Revealing an already-selected tab elsewhere changes no selection, only the active group.
  const activeGroupOf = (observation: WorkbenchRendererObservation) =>
    observation.panels.find((panel) => panel.panelId === afterGroup.panelId)?.activeGroupId;
  const focusedGroupOf = (observation: WorkbenchRendererObservation) =>
    observation.groups.find((group) => group.focused)?.groupId;
  const revealedElsewhere =
    after.groups.some((group) => {
      if (group.groupId === afterGroup.groupId) return false;
      const previous = before.groups.find((candidate) => candidate.groupId === group.groupId);
      return previous?.selectedTabId !== group.selectedTabId && group.selectedTabId !== null;
    }) ||
    (activeGroupOf(after) !== activeGroupOf(before) &&
      activeGroupOf(after) !== afterGroup.groupId) ||
    (focusedGroupOf(after) !== focusedGroupOf(before) &&
      focusedGroupOf(after) !== undefined &&
      focusedGroupOf(after) !== afterGroup.groupId);
  return revealedElsewhere
    ? { kind: "replace", groupId: afterGroup.groupId, reorderedTabIds: null }
    : { kind: "keep" };
}

function placeBefore(
  tabIds: readonly string[],
  movingId: string,
  anchorId: string,
): readonly string[] | null {
  const without = tabIds.filter((id) => id !== movingId);
  const anchorIndex = without.indexOf(anchorId);
  if (anchorIndex < 0) return null;
  const next = [...without.slice(0, anchorIndex), movingId, ...without.slice(anchorIndex)];
  return next.every((id, index) => id === tabIds[index]) ? null : next;
}

/** Recents show a time for today's edits and a date otherwise, with the year only when it differs. */
export function formatNewTabRecentTime(editedAt: Date, now: Date, locale?: string): string {
  if (editedAt.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(editedAt);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(editedAt.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(editedAt);
}
