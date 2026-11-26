import { getIntl } from "@/lib/i18n";
import type { WorkbenchRendererObservation } from "../../shared/nodex-app-tools/workbench";
import type { PanelNewTabAction, PanelNewTabActionKind } from "./workbench-panel-actions";

/** How many tools a New tab pins until the person chooses their own. */
export const NEW_TAB_DEFAULT_PIN_COUNT = 4;

/** Default order of New tab tools. Tools not listed follow in capability order. */
export const NEW_TAB_TOOL_RANK: readonly PanelNewTabActionKind[] = [
  "new_page",
  "side_chat",
  "terminal",
  "files",
  "review",
  "agents",
  "db_view",
  "canvas_stage",
];

const toolRanks = new Map(NEW_TAB_TOOL_RANK.map((kind, index) => [kind, index]));

/** A New tab already is a Browser, and its search field opens Pages directly. */
export function isNewTabToolKind(kind: PanelNewTabActionKind): boolean {
  return kind !== "browser" && kind !== "page_stage";
}

/** A person's chosen order and pins for one panel's New tabs. */
export interface NewTabShortcutPreference {
  /** Every tool kind the person has arranged, including tools unavailable in the current Scene. */
  readonly order: readonly PanelNewTabActionKind[];
  /** Pinned tool kinds. Display order comes from `order`. */
  readonly pinned: readonly PanelNewTabActionKind[];
}

export interface NewTabShortcutLayout {
  /** Every tool this New tab offers, in the person's order. Used by the menu and Customize. */
  readonly tools: readonly PanelNewTabAction[];
  /** The tools shown in the Open grid, in `tools` order. */
  readonly pinned: readonly PanelNewTabAction[];
}

/** Resolves the New tab tools and pins available in this Scene. */
export function resolveNewTabShortcutLayout(
  actions: readonly PanelNewTabAction[],
  preference: NewTabShortcutPreference | null,
): NewTabShortcutLayout {
  const available = new Map<PanelNewTabActionKind, PanelNewTabAction>();
  for (const action of actions) {
    if (!isNewTabToolKind(action.kind) || available.has(action.kind)) continue;
    available.set(action.kind, action);
  }

  const rankOf = (kind: PanelNewTabActionKind) => toolRanks.get(kind) ?? NEW_TAB_TOOL_RANK.length;
  const ranked = [...available.values()].sort((a, b) => rankOf(a.kind) - rankOf(b.kind));
  if (preference === null) {
    return { tools: ranked, pinned: ranked.slice(0, NEW_TAB_DEFAULT_PIN_COUNT) };
  }

  const order = new Set([...preference.order, ...ranked.map(({ kind }) => kind)]);
  const tools = [...order].flatMap((kind) => {
    const tool = available.get(kind);
    return tool ? [tool] : [];
  });
  const pinnedKinds = new Set(preference.pinned);
  return { tools, pinned: tools.filter(({ kind }) => pinnedKinds.has(kind)) };
}

/** Fills visible slots while preserving the order and pins of tools offered in other Scenes. */
function mergeNewTabShortcutPreference(
  layout: NewTabShortcutLayout,
  preference: NewTabShortcutPreference | null,
  nextKinds: readonly PanelNewTabActionKind[],
  nextPins: Iterable<PanelNewTabActionKind>,
): NewTabShortcutPreference {
  const visible = new Set(layout.tools.map(({ kind }) => kind));
  const order = new Set([...(preference?.order ?? []).filter(isNewTabToolKind), ...visible]);
  const newVisibleOrder = [
    ...new Set([...nextKinds.filter((kind) => visible.has(kind)), ...visible]),
  ];
  const hiddenPins = (preference?.pinned ?? []).filter(
    (kind) => isNewTabToolKind(kind) && !visible.has(kind),
  );
  const visiblePins = [...nextPins].filter((kind) => visible.has(kind));
  let nextIndex = 0;

  return {
    order: [...order].map((kind) => (visible.has(kind) ? newVisibleOrder[nextIndex++] : kind)),
    pinned: [...new Set([...hiddenPins, ...visiblePins])],
  };
}

/** Pins or unpins one tool, freezing the current arrangement as the person's own. */
export function toggleNewTabShortcutPin(
  layout: NewTabShortcutLayout,
  preference: NewTabShortcutPreference | null,
  kind: PanelNewTabActionKind,
): NewTabShortcutPreference {
  const pins = new Set(layout.pinned.map((action) => action.kind));
  if (!pins.delete(kind)) pins.add(kind);
  return mergeNewTabShortcutPreference(
    layout,
    preference,
    layout.tools.map((action) => action.kind),
    pins,
  );
}

/** Applies a new order of the visible tools, keeping the current pins. */
export function reorderNewTabShortcuts(
  layout: NewTabShortcutLayout,
  preference: NewTabShortcutPreference | null,
  nextKinds: readonly PanelNewTabActionKind[],
): NewTabShortcutPreference {
  return mergeNewTabShortcutPreference(
    layout,
    preference,
    nextKinds,
    layout.pinned.map(({ kind }) => kind),
  );
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

/** Recents never show more rows than this before scrolling within themselves. */
export const NEW_TAB_RECENT_MAX_ROWS = 8;

/**
 * How tall Recents may be: as many whole rows as fit in `availablePx`, at most
 * `NEW_TAB_RECENT_MAX_ROWS` and never fewer than two, plus half of the next row so the list
 * reads as scrollable.
 */
export function resolveNewTabRecentsHeight(availablePx: number, rowHeightPx: number): number {
  if (rowHeightPx <= 0) return 0;
  const rows = Math.max(2, Math.floor((availablePx - rowHeightPx / 2) / rowHeightPx));
  return Math.min(NEW_TAB_RECENT_MAX_ROWS, rows + 0.5) * rowHeightPx;
}

/** Recents show a time for today's edits and a date otherwise, with the year only when it differs. */
export function formatNewTabRecentTime(editedAt: Date, now: Date, locale?: string): string {
  if (editedAt.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale ?? getIntl().locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(editedAt);
  }
  return new Intl.DateTimeFormat(locale ?? getIntl().locale, {
    month: "short",
    day: "numeric",
    ...(editedAt.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(editedAt);
}
